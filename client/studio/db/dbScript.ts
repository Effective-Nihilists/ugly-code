/**
 * The Database panel's data layer. A self-contained ES-module script that we run
 * with `node --input-type=module -e <DB_SCRIPT>` over `native.process` (see
 * `runDbScript` in useSocket). It connects to the project's database and answers
 * one `op`:
 *
 *   collections | count | getDoc | getQuery | exec | mutate | schema
 *
 * ── Backend routing (Neon / Postgres vs Cloudflare D1 / SQLite) ───────────────
 * Most apps have migrated their collections from Neon (Postgres) to D1, so the
 * panel routes per app + per collection:
 *   - `.uglyapp` `neon: false`  ⇒ the WHOLE app is D1. Every op uses the D1 path;
 *     ZERO Postgres/Neon access (no connection string is ever resolved).
 *   - otherwise (Neon default / mixed "PARTIAL" apps) ⇒ Postgres stays the
 *     default; only collections the `database-collections.json` manifest marks
 *     `meta.db.kind === 'd1'` (i.e. `backendKind()` → 'd1') route to D1.
 * The D1 transport is the project's local better-sqlite3 file for `dev` (the same
 * `.ugly-sqlite/data.db` the node dev-server opens for `db:'d1'` collections) or
 * the project's Cloudflare D1 over the HTTP API for `prod` (via ugly-app's
 * `execTelemetryD1`, which resolves accountId/databaseId/token from publish-state).
 * The Postgres path is unchanged: bundled local postgres for `dev` (the same
 * `p_<projectId>` the agent's dev server uses) or the project's Neon for `prod`.
 *
 * Inputs/outputs are JSON over env (UGLY_DB_*) / stdout. Writes (`exec` with a
 * mutating statement, `mutate`) require `input.allowWrite` — the panel only sets
 * that once the user explicitly unlocks writes (and never silently for prod), so
 * the gate is enforced both UI-side and here (defense in depth).
 */

/** Supported filter operators for the structured (no-SQL) query builder. */
export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value?: string;
}

export const DB_SCRIPT = [
  "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import cp from 'node:child_process'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  "const mode = process.env.UGLY_DB_MODE, proj = process.env.UGLY_DB_PROJECT, op = process.env.UGLY_DB_OP;",
  "const input = JSON.parse(process.env.UGLY_DB_INPUT || '{}');",
  // ── backend routing ─────────────────────────────────────────────────────────
  // Two committed signals decide which backend a given op runs against:
  //   1. `.uglyapp` `neon` flag — `neon: false` means the app has NO Neon DB at
  //      all (fully migrated to D1), so every op MUST avoid Postgres entirely.
  //   2. `database-collections.json` manifest — carries each collection's
  //      `meta.db` (`{ kind: 'd1' | 'neon' }`), i.e. exactly `backendKind()`'s
  //      input. Used to route per-collection in mixed apps.
  "function readJsonSafe(p){ try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }",
  "const ua = readJsonSafe(path.join(proj, '.uglyapp')) || {};",
  "const appNeon = ua.neon !== false;", // neon:false ⇒ fully D1 (no Postgres)
  "const backendMap = (() => {",
  "  const m = {};",
  "  const man = readJsonSafe(path.join(proj, 'database-collections.json'));",
  "  const cols = (man && man.collections) || {};",
  "  for (const name of Object.keys(cols)) { const db = cols[name] && cols[name].meta && cols[name].meta.db; m[name] = (db && db.kind === 'd1') ? 'd1' : 'neon'; }",
  "  return m;",
  "})();",
  // Per-collection backend. In a fully-D1 app EVERYTHING is d1; otherwise default
  // Neon and only route manifest-declared d1 collections to D1.
  "function backendFor(collection){ return appNeon ? (backendMap[collection] === 'd1' ? 'd1' : 'neon') : 'd1'; }",
  // ── shared helpers ──────────────────────────────────────────────────────────
  "const ident = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '');", // table/column sanitizer
  "function classify(sql){ const s = sql.replace(/^[\\s(]+/, '').slice(0, 12).toLowerCase(); if (/^(select|with|explain|show|table|pragma)/.test(s)) return 'read'; return 'write'; }",
  // ════════════════════════════════════════════════════════════════════════════
  // D1 / SQLite engine
  //   dev  → the project's local better-sqlite3 file (.ugly-sqlite/data.db) — the
  //          SAME store the node dev-server opens for db:'d1' collections.
  //   prod → the project's Cloudflare D1 over the HTTP API, via ugly-app's
  //          execTelemetryD1 (accountId/databaseId/token resolved from
  //          publish-state — the single D1 that also holds telemetry).
  // SQLite table shape (SqliteDoc): _id TEXT, data TEXT(json), created INTEGER,
  // updated INTEGER, version INTEGER. Identifiers are backtick-quoted (SQLite
  // accepts it) to keep this script's string escaping readable.
  // ════════════════════════════════════════════════════════════════════════════
  "let _d1db = null, _execD1 = null, _d1ready = false;",
  "async function d1Init(){",
  "  if (_d1ready) return;",
  "  if (mode === 'prod') {",
  // execTelemetryD1 lives under ugly-app/dist/cli but isn't in the package
  // `exports` map, so import it by ABSOLUTE file URL derived from ugly-app's
  // resolved location (the same trick the pg require uses). It resolves the
  // prod D1 (accountId/databaseId) + a self-healing Cloudflare token from the
  // project's publish-state, so we never handle credentials here.
  "    const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.resolve('ugly-app/server')))));",
  "    const mod = await import(pathToFileURL(path.join(root, 'dist', 'cli', 'telemetryD1.js')).href);",
  "    _execD1 = mod.execTelemetryD1;",
  "  } else {",
  "    const dbPath = process.env.UGLY_SQLITE_PATH || path.join(proj, '.ugly-sqlite', 'data.db');",
  "    if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) throw new Error('No local D1 database at ' + dbPath + ' yet. Start the app (pnpm dev) so it creates its SQLite tables, then refresh.');",
  // better-sqlite3 is ugly-app's dependency (its node adapter uses it for d1
  // collections), resolved through ugly-app's location like `pg`.
  "    const Database = createRequire(import.meta.resolve('ugly-app/server'))('better-sqlite3');",
  "    _d1db = new Database(dbPath);",
  "    try { _d1db.pragma('busy_timeout = 4000'); } catch {}",
  "  }",
  "  _d1ready = true;",
  "}",
  "async function d1All(sql, params){ await d1Init(); const p = params || []; if (_d1db) return _d1db.prepare(sql).all(...p); const r = await _execD1(sql, p, { projectDir: proj }); return r.results || []; }",
  "async function d1Run(sql, params){ await d1Init(); const p = params || []; if (_d1db) { const info = _d1db.prepare(sql).run(...p); return info.changes || 0; } const r = await _execD1(sql, p, { projectDir: proj }); return (r.meta && (r.meta.changes != null ? r.meta.changes : r.meta.rows_written)) || 0; }",
  // WHERE builder for the structured (no-SQL) filter list. Mirrors the Postgres
  // buildWhere semantics (values compared as TEXT; numeric-aware >/</>=/<=) using
  // the SQLite dialect: json_extract(data,'$.field'), `?` placeholders (accepted
  // by both better-sqlite3 and D1).
  "const D1_COLS = new Set(['_id', 'created', 'updated', 'version']);",
  // TEXT-context expression (eq/ne/contains/sort). Postgres `data->>'f'` renders a
  // JSON boolean as 'true'/'false' and everything else as its text; SQLite's
  // json_extract instead yields 1/0 for booleans, which would break `done = false`
  // filters. json_type() reports 'true'/'false' for JSON booleans, so a CASE
  // reproduces the Postgres text semantics exactly (absent/null → NULL, as ->>' does).
  "function d1Text(f){ const id = ident(f); if (D1_COLS.has(id)) return '`' + id + '`'; const jp = \"'$.\" + id + \"'\"; return \"CASE WHEN json_type(data,\" + jp + \")='true' THEN 'true' WHEN json_type(data,\" + jp + \")='false' THEN 'false' ELSE CAST(json_extract(data,\" + jp + \") AS TEXT) END\"; }",
  "function d1Num(f){ const id = ident(f); return D1_COLS.has(id) ? ('`' + id + '`') : (\"json_extract(data,'$.\" + id + \"')\"); }",
  "function d1Where(filters, params){",
  "  const parts = [];",
  "  for (const f of (filters || [])){",
  "    const id = ident(f.field); const fop = f.op;",
  "    if (fop === 'exists'){ parts.push(\"json_type(data,'$.\" + id + \"') IS NOT NULL\"); continue; }",
  "    const v = f.value == null ? '' : String(f.value);",
  "    if (fop === 'contains'){ parts.push(d1Text(f.field) + \" LIKE '%'||?||'%'\"); params.push(v); continue; }",
  "    if (fop === 'eq'){ parts.push(d1Text(f.field) + ' = ?'); params.push(v); continue; }",
  "    if (fop === 'ne'){ parts.push('(' + d1Text(f.field) + ' IS NOT ?)'); params.push(v); continue; }",
  "    const cmp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[fop]; if (!cmp) continue;",
  "    if (/^-?[0-9.]+$/.test(v)){ parts.push('CAST(' + d1Num(f.field) + ' AS REAL) ' + cmp + ' ?'); params.push(Number(v)); }",
  "    else { parts.push(d1Text(f.field) + ' ' + cmp + ' ?'); params.push(v); }",
  "  }",
  "  return parts.length ? (' WHERE ' + parts.join(' AND ')) : '';",
  "}",
  // D1 rows store `data` as a JSON string — parse and flatten to the panel's row
  // shape (matches the Postgres flatten()).
  "function d1Flatten(rows){ return rows.map((row) => { let d = {}; if (row.data){ try { d = JSON.parse(row.data); } catch {} } return Object.assign({ _id: row._id }, (d && typeof d === 'object') ? d : {}, { _created: row.created, _updated: row.updated }); }); }",
  "async function d1TableExists(name){ const r = await d1All(\"SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1\", [ident(name)]); return r.length > 0; }",
  // estimatedCount: SQLite has no cheap reltuples, so count each table via a UNION ALL of
  // scalar subqueries. CHUNKED — one UNION ALL over EVERY table blows past D1/SQLite's
  // compound-SELECT term cap once an app has enough tables (framework builtins + collections
  // + telemetry), failing the whole Browse list with `too many terms in compound SELECT`.
  // Batch keeps each compound query small; a handful of round-trips is fine for a table list.
  "async function d1CountNames(tables){",
  "  if (!tables.length) return [];",
  "  const CHUNK = 20;",
  "  const out = [];",
  "  for (let i = 0; i < tables.length; i += CHUNK) {",
  "    const batch = tables.slice(i, i + CHUNK);",
  "    const unionSql = batch.map((t) => \"SELECT '\" + String(t).replace(/'/g, \"''\") + \"' AS name, (SELECT count(*) FROM `\" + ident(t) + \"`) AS n\").join(' UNION ALL ');",
  "    const rows = await d1All(unionSql, []);",
  "    for (const x of rows) out.push({ name: String(x.name), estimatedCount: Math.max(0, Number(x.n) || 0) });",
  "  }",
  "  return out;",
  "}",
  "async function d1ListAll(){ const tables = (await d1All(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name\", [])).map((r) => String(r.name)); return d1CountNames(tables); }",
  "async function d1ListNamed(names){ const present = []; for (const n of names){ if (await d1TableExists(n)) present.push(n); } return d1CountNames(present); }",
  "async function d1Op(){",
  "  if (op === 'count'){ const r = await d1All('SELECT count(*) AS n FROM `' + ident(input.collection) + '`', []); return { count: Number(r[0].n) || 0 }; }",
  "  if (op === 'getDoc'){ const r = await d1All('SELECT data FROM `' + ident(input.collection) + '` WHERE _id = ?', [input.id]); let doc = null; if (r[0] && r[0].data){ try { doc = JSON.parse(r[0].data); } catch { doc = null; } } return { doc }; }",
  "  if (op === 'getQuery'){",
  "    const t0 = Date.now(); const tbl = ident(input.collection);",
  "    const lim = Math.min(Number(input.limit) || 50, 1000), skip = Math.max(0, Number(input.skip) || 0);",
  "    const params = []; const where = d1Where(input.filters, params);",
  "    const sortExpr = input.sort && input.sort.field ? d1Text(input.sort.field) : '`created`';",
  "    const dir = (input.sort && String(input.sort.dir).toLowerCase() === 'asc') ? 'ASC' : 'DESC';",
  "    const total = Number((await d1All('SELECT count(*) AS n FROM `' + tbl + '`' + where, params))[0].n) || 0;",
  "    const rparams = params.slice(); rparams.push(lim); rparams.push(skip);",
  "    const rows0 = await d1All('SELECT _id, data, created, updated FROM `' + tbl + '`' + where + ' ORDER BY ' + sortExpr + ' ' + dir + ' NULLS LAST LIMIT ? OFFSET ?', rparams);",
  "    const rows = d1Flatten(rows0);",
  "    const columns = rows.length ? Array.from(rows.reduce((s, row) => { Object.keys(row).forEach((k) => s.add(k)); return s; }, new Set())) : ['_id'];",
  "    return { columns, rows, rowCount: rows.length, total, durationMs: Date.now() - t0 };",
  "  }",
  "  if (op === 'schema'){",
  "    const tbl = ident(input.collection);",
  "    const cols = (await d1All('PRAGMA table_info(`' + tbl + '`)', [])).map((c) => ({ name: c.name, type: c.type }));",
  "    const idx = (await d1All(\"SELECT name, sql AS def FROM sqlite_master WHERE type='index' AND tbl_name = ? ORDER BY name\", [tbl])).map((r) => ({ name: r.name, def: r.def || '' }));",
  "    const n = Number((await d1All('SELECT count(*) AS n FROM `' + tbl + '`', []))[0].n) || 0;",
  "    return { columns: cols, indexes: idx, count: n };",
  "  }",
  "  if (op === 'mutate'){",
  "    if (!input.allowWrite) throw new Error('Writes are locked. Unlock writes to mutate.');",
  "    const tbl = ident(input.collection); const now = Date.now();",
  "    if (input.action === 'insert'){",
  "      const doc = (input.doc && typeof input.doc === 'object') ? input.doc : {};",
  "      const id = doc._id || crypto.randomUUID(); delete doc._id; delete doc._created; delete doc._updated;",
  "      await d1Run('INSERT INTO `' + tbl + '` (_id, data, created, updated, version) VALUES (?, ?, ?, ?, 1)', [id, JSON.stringify(doc), now, now]);",
  "      return { ok: true, _id: id };",
  "    }",
  "    if (input.action === 'update'){",
  "      const doc = (input.doc && typeof input.doc === 'object') ? input.doc : {}; const id = input.id || doc._id; delete doc._id; delete doc._created; delete doc._updated;",
  "      if (!id) throw new Error('update needs an _id');",
  "      const affected = await d1Run('UPDATE `' + tbl + '` SET data = ?, updated = ? WHERE _id = ?', [JSON.stringify(doc), now, id]);",
  "      return { ok: true, _id: id, affected };",
  "    }",
  "    if (input.action === 'delete'){",
  "      if (!input.id) throw new Error('delete needs an _id');",
  "      const affected = await d1Run('DELETE FROM `' + tbl + '` WHERE _id = ?', [input.id]);",
  "      return { ok: true, _id: input.id, affected };",
  "    }",
  "    throw new Error('Unknown mutate action: ' + input.action);",
  "  }",
  "  throw new Error('Unsupported D1 op: ' + op);",
  "}",
  "async function d1Exec(){",
  "  const t0 = Date.now(); const sql = String(input.sql || '').trim(); if (!sql) throw new Error('Empty SQL');",
  "  const kind = classify(sql);",
  "  const danger = /\\b(drop|truncate|alter)\\b/i.test(sql);",
  "  const blindWrite = kind === 'write' && /\\b(update|delete)\\b/i.test(sql) && !/\\bwhere\\b/i.test(sql);",
  "  if (kind === 'write' && !input.allowWrite) throw new Error('This is a write statement. Unlock writes to run it.');",
  "  if ((danger || blindWrite) && !input.force) throw new Error((danger ? 'DROP/TRUNCATE/ALTER' : 'UPDATE/DELETE without WHERE') + ' is blocked. Re-run with force to override.');",
  "  const params = Array.isArray(input.params) ? input.params : [];",
  "  if (kind === 'read'){ const rows = await d1All(sql, params); const columns = rows.length ? Object.keys(rows[0]) : []; return { kind, columns, rows, rowCount: rows.length, durationMs: Date.now() - t0 }; }",
  "  if (input.dryRun){",
  "    await d1Init();",
  // The HTTP D1 API auto-commits each statement (no interactive BEGIN/ROLLBACK),
  // so a dry-run is only possible against the local dev SQLite file.
  "    if (!_d1db) throw new Error('Dry-run is not supported against production D1 (no interactive transactions). Run without dry-run — writes are still gated.');",
  "    _d1db.exec('BEGIN'); let n = 0; try { n = _d1db.prepare(sql).run(...params).changes || 0; } finally { _d1db.exec('ROLLBACK'); }",
  "    return { kind, dryRun: true, affected: n, durationMs: Date.now() - t0 };",
  "  }",
  "  const affected = await d1Run(sql, params);",
  "  return { kind, affected, durationMs: Date.now() - t0 };",
  "}",
  // ════════════════════════════════════════════════════════════════════════════
  // Postgres / Neon engine — UNCHANGED behavior, but lazily connected: a fully-D1
  // app (neon:false) never resolves a connection string or opens a pool, so it
  // makes ZERO Neon/Postgres access.
  // ════════════════════════════════════════════════════════════════════════════
  // Derive the prod Neon connection string from the COMMITTED `.uglyapp`
  // deployTarget.neonProjectId + the user's Neon API key (~/.ugly-app/credentials.json),
  // via the Neon API. This is the machine-independent fallback: publish-state is
  // per-machine and absent on any machine that didn't publish, but neonProjectId is
  // committed to the repo, so Neon auth alone is enough to reach prod from anywhere.
  "async function deriveNeonConnStr(proj){",
  "  try {",
  "    const ua = JSON.parse(fs.readFileSync(path.join(proj, '.uglyapp'), 'utf8'));",
  "    const npid = ua.deployTarget && ua.deployTarget.neonProjectId;",
  "    if (!npid) return null;",
  "    const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ugly-app', 'credentials.json'), 'utf8'));",
  "    const apiKey = creds.neon && creds.neon.apiKey;",
  "    if (!apiKey) return null;",
  "    const H = { Authorization: 'Bearer ' + apiKey };",
  "    const base = 'https://console.neon.tech/api/v2';",
  "    const gj = async (p) => { const r = await fetch(base + p, { headers: H }); if (!r.ok) throw new Error('neon ' + p + ' -> ' + r.status); return r.json(); };",
  "    const branches = (await gj('/projects/' + npid + '/branches')).branches || [];",
  "    const def = branches.find(b => b.default) || branches[0]; if (!def) return null;",
  "    const dbs = (await gj('/projects/' + npid + '/branches/' + def.id + '/databases')).databases || [];",
  "    const roles = (await gj('/projects/' + npid + '/branches/' + def.id + '/roles')).roles || [];",
  "    const db = dbs[0] && dbs[0].name, role = roles[0] && roles[0].name;",
  "    if (!db || !role) return null;",
  "    const cu = await gj('/projects/' + npid + '/connection_uri?branch_id=' + def.id + '&database_name=' + encodeURIComponent(db) + '&role_name=' + encodeURIComponent(role));",
  "    return cu.uri || cu.connection_uri || null;",
  "  } catch (e) { console.error('[dbScript:deriveNeonConnStr] ' + String((e && e.message) || e)); return null; }",
  "}",
  "async function connStr(){",
  "  if (mode === 'prod') {",
  "    let projectId = '(unknown)';",
  "    let cs = null;",
  // publish-state is per-machine (written by the publish flow). On a machine that
  // published the project it carries the Neon URL; on any OTHER machine it's absent
  // (this is the domain source-of-truth, not synced) — so a raw readFileSync ENOENT
  // there is EXPECTED, not a crash. Try it, then fall back to an explicit prod URL.
  "    try {",
  "      const ua = JSON.parse(fs.readFileSync(path.join(proj, '.uglyapp'), 'utf8')); projectId = ua.projectId || projectId;",
  "      const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ugly-studio', 'projects', ua.projectId, 'publish-state.json'), 'utf8'));",
  "      const neon = st.neon || (st.deployTarget && st.deployTarget.neon) || {};",
  "      cs = neon.connectionString || neon.connStr || (st.deployTarget && st.deployTarget.neonConnectionString) || null;",
  "    } catch (e) { /* no local publish-state — try an explicit prod override below */ }",
  // Escape hatch for a machine that didn't publish: a deliberate PROD_DATABASE_URL
  // in .env (NOT the plain DATABASE_URL, which is the local dev DB — mixing them
  // would silently point 'prod' at dev).
  "    if (!cs) { try { const env = fs.readFileSync(path.join(proj, '.env'), 'utf8'); const m = /^(?:PROD_DATABASE_URL|NEON_DATABASE_URL)=(.+)$/m.exec(env); if (m) cs = m[1].trim().replace(/^[\"\\']|[\"\\']$/g, ''); } catch {} }",
  // Machine-independent fallback: derive from committed neonProjectId + Neon API key.
  "    if (!cs) { cs = await deriveNeonConnStr(proj); }",
  "    if (!cs) throw new Error('No prod database connection for project ' + projectId + '. Tried: publish-state (~/.ugly-studio/projects/' + projectId + '/publish-state.json, per-machine — absent here), PROD_DATABASE_URL in .env, and deriving from .uglyapp deployTarget.neonProjectId via the Neon API. Fix: run `ugly-app login neon` so the API key is present (and ensure .uglyapp has deployTarget.neonProjectId), or set PROD_DATABASE_URL=<neon url> in .env.');",
  "    return cs;",
  "  }",
  "  try { const env = fs.readFileSync(path.join(proj, '.env'), 'utf8'); const m = /^(?:DATABASE_URL|POSTGRES_URL)=(.+)$/m.exec(env); if (m) return m[1].trim().replace(/^[\"\\']|[\"\\']$/g, ''); } catch {}",
  "  return ensureLocalPg();",
  "}",
  "function ensureLocalPg(){",
  "  const pgRoot = path.join(os.homedir(), '.ugly-studio', 'binaries', 'postgres');",
  "  const arch = os.platform() + '-' + os.arch();",
  "  const intelMac = os.platform() === 'darwin' && os.arch() === 'x64';",
  "  const pgHint = intelMac ? 'bundled postgres is NOT built for Intel Macs (darwin-x64) — the local dev DB is unavailable on this platform; use prod mode or set DATABASE_URL in .env.' : 'reopen/restart Ugly Studio so it finishes downloading its binaries.';",
  "  if (!fs.existsSync(pgRoot)) throw new Error('Bundled postgres not found at ' + pgRoot + ' for ' + arch + ' — ' + pgHint);",
  // Resolve to the NEWEST version dir that actually has a usable bin/initdb.
  // A partial/in-progress download can leave an empty or half-populated version
  // dir that sorts newest; the bin also lives at either <ver>/bin (flat) or
  // <ver>/<platform>/bin. Picking the highest-sorting NAME + assuming a platform
  // subdir (the old code) left `plat` undefined → `path.join(...,undefined,...)`
  // crashed with a cryptic ERR_INVALID_ARG_TYPE instead of a clear message.
  "  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };",
  "  const hasInitdb = (b) => fs.existsSync(path.join(b, 'initdb')) || fs.existsSync(path.join(b, 'initdb.exe'));",
  "  let bin = null, lib = null;",
  "  for (const ver of fs.readdirSync(pgRoot).filter(d => /^[0-9]/.test(d)).sort().reverse()) {",
  "    const vroot = path.join(pgRoot, ver); if (!isDir(vroot)) continue;",
  "    const cands = [vroot].concat(fs.readdirSync(vroot).map(d => path.join(vroot, d)).filter(isDir));",
  "    for (const c of cands) { if (hasInitdb(path.join(c, 'bin'))) { bin = path.join(c, 'bin'); lib = path.join(c, 'lib'); break; } }",
  "    if (bin) break;",
  "  }",
  "  if (!bin) {",
  "    let tree = [];",
  "    try { for (const v of fs.readdirSync(pgRoot)) { let line = v; try { if (isDir(path.join(pgRoot, v))) { line += ' -> [' + fs.readdirSync(path.join(pgRoot, v)).map(k => k + (isDir(path.join(pgRoot, v, k, 'bin')) ? '/bin' : '')).join(', ') + ']'; } } catch (e) {} tree.push(line); } } catch (e) { tree.push('(readdir ' + pgRoot + ' failed: ' + (e && e.message) + ')'); }",
  "    throw new Error('Bundled postgres unusable for ' + arch + ' under ' + pgRoot + ' (no <version>/bin/initdb) — ' + pgHint + ' Contents: ' + (tree.length ? tree.join(' ; ') : '(empty)'));",
  "  }",
  "  const PGDATA = path.join(os.homedir(), '.ugly-studio', 'pgdata'), PORT = 55432;",
  "  const cenv = Object.assign({}, process.env, { DYLD_LIBRARY_PATH: lib, LD_LIBRARY_PATH: lib });",
  "  const winExe = process.platform === 'win32' ? '.exe' : '';",
  "  const run = (c, a) => cp.execFileSync(path.join(bin, c + winExe), a, { env: cenv, stdio: 'pipe' });",
  "  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) run('initdb', ['-D', PGDATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);",
  "  let up = false; try { run('pg_isready', ['-h','127.0.0.1','-p',String(PORT)]); up = true; } catch {}",
  // Windows postgres: no unix sockets, needs dynamic_shared_memory_type=windows. We connect over TCP.
  "  const pgStartOpts = process.platform === 'win32' ? ('-p '+PORT+' -c listen_addresses=127.0.0.1 -c dynamic_shared_memory_type=windows') : ('-p '+PORT+' -k /tmp -c listen_addresses=127.0.0.1');",
  "  const PGLOG = path.join(os.homedir(),'.ugly-studio','pg.log');",
  // Bound the wait with -t 30 so a server that never comes up (e.g. a Windows
  // dsm/perm issue) surfaces an error in ~30s instead of hanging the panel; on
  // failure attach the pg.log tail so the actual postgres startup error is visible.
  "  if (!up) { try { run('pg_ctl', ['-D', PGDATA, '-o', pgStartOpts, '-l', PGLOG, '-w', '-t', '30', 'start']); } catch (e) { let tail=''; try { tail = fs.readFileSync(PGLOG,'utf8').slice(-1000); } catch {} throw new Error('postgres failed to start: ' + ((e&&e.message)||e) + (tail ? ' | pg.log: ' + tail : '')); } }",
  "  let dbName = 'dev'; try { dbName = 'p_' + JSON.parse(fs.readFileSync(path.join(proj, '.uglyapp'),'utf8')).projectId; } catch {}",
  "  dbName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');",
  "  try { run('createdb', ['-h','127.0.0.1','-p',String(PORT),'-U','postgres', dbName]); } catch {}",
  "  return 'postgresql://postgres@127.0.0.1:'+PORT+'/'+dbName;",
  "}",
  // Lazily connect Postgres the first time a Neon-backed op runs. `pg` is
  // ugly-app's dependency, NOT the project's — resolve it through ugly-app's
  // location (a bare `import pg from 'pg'` fails under pnpm's strict node_modules).
  "let _pg = null;",
  "async function ensurePg(){",
  "  if (_pg) return _pg;",
  "  process.env.DATABASE_URL = await connStr();",
  "  const mod = await import('ugly-app/server');",
  "  mod.createAdapter();",
  "  const q = mod.query || mod.pgQuery;", // read path (adapter); no rowCount needed
  "  const pg = createRequire(import.meta.resolve('ugly-app/server'))('pg');",
  // Write/transaction path: a DEDICATED pg client. The adapter routes every
  // query through pool.query() — a *different* pooled connection each call — so
  // BEGIN/…/ROLLBACK there would NOT isolate (the statement would autocommit and
  // the dry-run would mutate for real). A single Client guarantees isolation and
  // gives a real rowCount. Same connection string works for local PG + Neon.
  "  async function withClient(fn){ const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); try { await client.query(\"SET statement_timeout = '20s'\"); return await fn(client); } finally { try { await client.end(); } catch {} } }",
  "  _pg = { q, withClient };",
  "  return _pg;",
  "}",
  // ── Postgres helpers (JSONB-aware) ───────────────────────────────────────────
  "const COLS = new Set(['_id','created','updated']);",            // real columns vs JSONB keys
  "function fieldExpr(f){ const id = ident(f); return COLS.has(id) ? ('\"'+id+'\"') : (\"data->>'\"+id+\"'\"); }",
  "function buildWhere(filters, params){",
  "  const parts = [];",
  "  for (const f of (filters||[])){",
  "    const fe = fieldExpr(f.field); const fop = f.op;",
  "    if (fop === 'exists'){ parts.push('data ? $'+(params.push(ident(f.field)))); continue; }",
  "    const v = f.value == null ? '' : String(f.value);",
  "    if (fop === 'contains'){ parts.push(fe+\" ILIKE '%'||$\"+(params.push(v))+\"||'%'\"); continue; }",
  "    if (fop === 'eq'){ parts.push(fe+' = $'+(params.push(v))); continue; }",
  "    if (fop === 'ne'){ parts.push('('+fe+' IS DISTINCT FROM $'+(params.push(v))+')'); continue; }",
  // gt/gte/lt/lte: numeric-aware (cast only when both sides look numeric).
  "    const cmp = { gt:'>', gte:'>=', lt:'<', lte:'<=' }[fop]; if (!cmp) continue;",
  "    if (/^-?[0-9.]+$/.test(v)){ parts.push('(CASE WHEN '+fe+\" ~ '^-?[0-9.]+$' THEN (\"+fe+')::numeric END) '+cmp+' $'+(params.push(Number(v)))); }",
  "    else { parts.push(fe+' '+cmp+' $'+(params.push(v))); }",
  "  }",
  "  return parts.length ? (' WHERE '+parts.join(' AND ')) : '';",
  "}",
  "function flatten(rows){ return rows.map((row) => Object.assign({ _id: row._id }, (row.data && typeof row.data === 'object') ? row.data : {}, { _created: row.created, _updated: row.updated })); }",
  "async function pgListCollections(){",
  "  const { q } = await ensurePg();",
  "  const sql = \"SELECT c.relname AS name, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'pg_%' AND c.relname NOT LIKE 'sql_%' ORDER BY c.relname\";",
  "  const r = await q(sql);",
  "  return r.rows.map((x) => ({ name: x.name, estimatedCount: Math.max(0, Number(x.n) || 0) }));",
  "}",
  "async function pgOp(){",
  "  const { q, withClient } = await ensurePg();",
  "  if (op === 'count') { const r = await q('SELECT count(*)::bigint AS n FROM \"' + ident(input.collection) + '\"'); return { count: Number(r.rows[0].n) || 0 }; }",
  "  if (op === 'getDoc') { const r = await q('SELECT data FROM \"' + ident(input.collection) + '\" WHERE _id = $1', [input.id]); return { doc: (r.rows[0] && r.rows[0].data) || null }; }",
  "  if (op === 'getQuery') {",
  "    const t0 = Date.now();",
  "    const tbl = ident(input.collection);",
  "    const lim = Math.min(Number(input.limit) || 50, 1000), skip = Math.max(0, Number(input.skip) || 0);",
  "    const params = []; const where = buildWhere(input.filters, params);",
  "    const sortField = input.sort && input.sort.field ? fieldExpr(input.sort.field) : '\"created\"';",
  "    const dir = (input.sort && String(input.sort.dir).toLowerCase() === 'asc') ? 'ASC' : 'DESC';",
  "    const total = Number((await q('SELECT count(*)::bigint AS n FROM \"'+tbl+'\"'+where, params)).rows[0].n) || 0;",
  "    params.push(lim); params.push(skip);",
  "    const r = await q('SELECT _id, data, created, updated FROM \"'+tbl+'\"'+where+' ORDER BY '+sortField+' '+dir+' NULLS LAST LIMIT $'+(params.length-1)+' OFFSET $'+params.length, params);",
  "    const rows = flatten(r.rows);",
  "    const columns = rows.length ? Array.from(rows.reduce((s,row)=>{Object.keys(row).forEach(k=>s.add(k));return s;}, new Set())) : ['_id'];",
  "    return { columns, rows, rowCount: rows.length, total, durationMs: Date.now() - t0 };",
  "  }",
  "  if (op === 'schema') {",
  "    const tbl = ident(input.collection);",
  "    const cols = (await q(\"SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position\", [tbl])).rows;",
  "    const idx = (await q(\"SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname\", [tbl])).rows;",
  "    const n = Number((await q('SELECT count(*)::bigint AS n FROM \"'+tbl+'\"')).rows[0].n) || 0;",
  "    return { columns: cols, indexes: idx, count: n };",
  "  }",
  "  if (op === 'mutate') {",
  "    if (!input.allowWrite) throw new Error('Writes are locked. Unlock writes to mutate.');",
  "    const tbl = ident(input.collection);",
  // created/updated are timestamptz columns (the adapter writes now()), so we
  // use SQL now() here rather than epoch millis (which Postgres rejects).
  "    if (input.action === 'insert') {",
  "      const doc = (input.doc && typeof input.doc === 'object') ? input.doc : {};",
  "      const id = doc._id || crypto.randomUUID(); delete doc._id; delete doc._created; delete doc._updated;",
  "      await withClient((c) => c.query('INSERT INTO \"'+tbl+'\" (_id, data, created, updated) VALUES ($1,$2,now(),now())', [id, JSON.stringify(doc)]));",
  "      return { ok: true, _id: id };",
  "    }",
  "    if (input.action === 'update') {",
  "      const doc = (input.doc && typeof input.doc === 'object') ? input.doc : {}; const id = input.id || doc._id; delete doc._id; delete doc._created; delete doc._updated;",
  "      if (!id) throw new Error('update needs an _id');",
  "      const r = await withClient((c) => c.query('UPDATE \"'+tbl+'\" SET data=$1, updated=now() WHERE _id=$2', [JSON.stringify(doc), id]));",
  "      return { ok: true, _id: id, affected: r.rowCount || 0 };",
  "    }",
  "    if (input.action === 'delete') {",
  "      if (!input.id) throw new Error('delete needs an _id');",
  "      const r = await withClient((c) => c.query('DELETE FROM \"'+tbl+'\" WHERE _id=$1', [input.id]));",
  "      return { ok: true, _id: input.id, affected: r.rowCount || 0 };",
  "    }",
  "    throw new Error('Unknown mutate action: ' + input.action);",
  "  }",
  "  throw new Error('Unsupported PG op: ' + op);",
  "}",
  "async function pgExec(){",
  "  const { withClient } = await ensurePg();",
  "  const t0 = Date.now();",
  "  const sql = String(input.sql || '').trim(); if (!sql) throw new Error('Empty SQL');",
  "  const kind = classify(sql);",
  "  const danger = /\\b(drop|truncate|alter)\\b/i.test(sql);",
  "  const blindWrite = kind === 'write' && /\\b(update|delete)\\b/i.test(sql) && !/\\bwhere\\b/i.test(sql);",
  "  if (kind === 'write' && !input.allowWrite) throw new Error('This is a write statement. Unlock writes to run it.');",
  "  if ((danger || blindWrite) && !input.force) throw new Error((danger ? 'DROP/TRUNCATE/ALTER' : 'UPDATE/DELETE without WHERE') + ' is blocked. Re-run with force to override.');",
  "  const params = Array.isArray(input.params) ? input.params : [];",
  "  return withClient(async (c) => {",
  "    if (kind === 'read') {",
  "      const r = await c.query(sql, params);",
  "      const rows = r.rows || []; const columns = r.fields ? r.fields.map((f) => f.name) : (rows.length ? Object.keys(rows[0]) : []);",
  "      return { kind, columns, rows, rowCount: rows.length, durationMs: Date.now() - t0 };",
  "    }",
  "    if (input.dryRun) {",
  "      await c.query('BEGIN'); let n = 0; try { const r = await c.query(sql, params); n = r.rowCount || 0; } finally { await c.query('ROLLBACK'); }",
  "      return { kind, dryRun: true, affected: n, durationMs: Date.now() - t0 };",
  "    }",
  "    const r = await c.query(sql, params);",
  "    return { kind, affected: r.rowCount || 0, durationMs: Date.now() - t0 };",
  "  });",
  "}",
  // ── dispatch ──────────────────────────────────────────────────────────────────
  // Wrap the entire routing+query in a try so ANY failure is emitted as a
  // STRUCTURED error object on stdout — captured verbatim by runDbScript →
  // errorLog. That makes every panel failure debuggable from the logs alone.
  "try {",
  "  let out = {};",
  "  if (op === 'collections') {",
  "    if (!appNeon) { out = { collections: await d1ListAll() }; }",
  "    else {",
  // Mixed/PARTIAL app: Postgres tables (unchanged) + any manifest-declared d1
  // collections. The manifest naturally excludes framework telemetry tables
  // (error_log/feedback_report/perf_log) that share the D1 database. Best-effort
  // on the D1 side so a missing local dev SQLite never breaks the list.
  "      const pgCols = await pgListCollections();",
  "      const d1Names = Object.keys(backendMap).filter((n) => backendMap[n] === 'd1');",
  "      if (!d1Names.length) { out = { collections: pgCols }; }",
  "      else { let d1Cols = []; try { const seen = new Set(pgCols.map((c) => c.name)); d1Cols = (await d1ListNamed(d1Names)).filter((c) => !seen.has(c.name)); } catch (e) { console.error('[dbScript:mixed-d1-list] ' + String((e && e.message) || e)); } out = { collections: pgCols.concat(d1Cols) }; }",
  "    }",
  "  } else if (op === 'exec') {",
  // The raw SQL console targets the app's primary backend (single dialect): D1 for
  // fully-D1 apps, Postgres otherwise.
  "    out = appNeon ? await pgExec() : await d1Exec();",
  "  } else {",
  "    out = backendFor(input.collection) === 'd1' ? await d1Op() : await pgOp();",
  "  }",
  // Force exit after the result flushes: an open pg pool / better-sqlite3 handle
  // keeps the event loop alive, so the process would otherwise never exit and the
  // panel hangs on "Loading…". Exit in the write callback so stdout isn't
  // truncated on a pipe.
  "  process.stdout.write(JSON.stringify(out), () => process.exit(0));",
  "} catch (e) {",
  // Structured error → stdout (exit 0) so runDbScript ALWAYS gets parseable JSON and can
  // log the real cause + context (failing phase inferred from the message, redacted target)
  // instead of scraping a truncated, warning-polluted stderr.
  "  const target = String(process.env.DATABASE_URL || (mode === 'prod' ? 'cloudflare-d1' : 'local-sqlite')).replace(/:\\/\\/([^:]+):[^@]+@/, '://$1:***@');",
  "  const err = { __dbError: { message: (e && e.message) ? String(e.message) : String(e), code: (e && e.code) || null, op, mode, target, stack: (e && e.stack) ? String(e.stack).split('\\n').slice(0, 6).join('\\n') : null } };",
  "  process.stdout.write(JSON.stringify(err), () => process.exit(0));",
  "}",
].join('\n');
