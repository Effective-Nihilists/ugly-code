/**
 * The Database panel's data layer. A self-contained ES-module script that we run
 * with `node --input-type=module -e <DB_SCRIPT>` over `native.process` (see
 * `runDbScript` in useSocket). It connects to the project's database — bundled
 * local postgres for `dev` (the same `p_<projectId>` the agent's dev server uses)
 * or the project's Neon connection string for `prod` — and answers one `op`:
 *
 *   collections | count | getDoc | getQuery | exec | mutate | schema
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
  "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import cp from 'node:child_process'; import crypto from 'node:crypto'; import pg from 'pg';",
  "const mode = process.env.UGLY_DB_MODE, proj = process.env.UGLY_DB_PROJECT, op = process.env.UGLY_DB_OP;",
  "const input = JSON.parse(process.env.UGLY_DB_INPUT || '{}');",
  // ── connection ──────────────────────────────────────────────────────────────
  "function connStr(){",
  "  if (mode === 'prod') {",
  "    const ua = JSON.parse(fs.readFileSync(path.join(proj, '.uglyapp'), 'utf8'));",
  "    const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ugly-studio', 'projects', ua.projectId, 'publish-state.json'), 'utf8'));",
  "    const neon = st.neon || (st.deployTarget && st.deployTarget.neon) || {};",
  "    const cs = neon.connectionString || neon.connStr || (st.deployTarget && st.deployTarget.neonConnectionString);",
  "    if (!cs) throw new Error('No Neon connection string in publish-state for ' + ua.projectId);",
  "    return cs;",
  "  }",
  "  try { const env = fs.readFileSync(path.join(proj, '.env'), 'utf8'); const m = /^(?:DATABASE_URL|POSTGRES_URL)=(.+)$/m.exec(env); if (m) return m[1].trim().replace(/^[\"\\']|[\"\\']$/g, ''); } catch {}",
  "  return ensureLocalPg();",
  "}",
  "function ensureLocalPg(){",
  "  const pgRoot = path.join(os.homedir(), '.ugly-studio', 'binaries', 'postgres');",
  "  const ver = fs.readdirSync(pgRoot).filter(d => /^[0-9]/.test(d)).sort().pop();",
  "  if (!ver) throw new Error('Bundled postgres not found at ' + pgRoot + ' — open Ugly Studio so it downloads its binaries.');",
  "  const plat = fs.readdirSync(path.join(pgRoot, ver)).find(d => fs.existsSync(path.join(pgRoot, ver, d, 'bin')));",
  "  const bin = path.join(pgRoot, ver, plat, 'bin'), lib = path.join(pgRoot, ver, plat, 'lib');",
  "  const PGDATA = path.join(os.homedir(), '.ugly-studio', 'pgdata'), PORT = 55432;",
  "  const cenv = Object.assign({}, process.env, { DYLD_LIBRARY_PATH: lib, LD_LIBRARY_PATH: lib });",
  "  const run = (c, a) => cp.execFileSync(path.join(bin, c), a, { env: cenv, stdio: 'pipe' });",
  "  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) run('initdb', ['-D', PGDATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);",
  "  let up = false; try { run('pg_isready', ['-h','127.0.0.1','-p',String(PORT)]); up = true; } catch {}",
  "  if (!up) run('pg_ctl', ['-D', PGDATA, '-o', '-p '+PORT+' -k /tmp -c listen_addresses=127.0.0.1', '-l', path.join(os.homedir(),'.ugly-studio','pg.log'), '-w', 'start']);",
  "  let dbName = 'dev'; try { dbName = 'p_' + JSON.parse(fs.readFileSync(path.join(proj, '.uglyapp'),'utf8')).projectId; } catch {}",
  "  dbName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');",
  "  try { run('createdb', ['-h','127.0.0.1','-p',String(PORT),'-U','postgres', dbName]); } catch {}",
  "  return 'postgresql://postgres@127.0.0.1:'+PORT+'/'+dbName;",
  "}",
  "process.env.DATABASE_URL = connStr();",
  "const mod = await import('ugly-app/server');",
  "mod.createAdapter();",
  "const q = mod.query || mod.pgQuery;", // read path (adapter); no rowCount needed
  // Write/transaction path: a DEDICATED pg client. The adapter routes every
  // query through pool.query() — a *different* pooled connection each call — so
  // BEGIN/…/ROLLBACK there would NOT isolate (the statement would autocommit and
  // the dry-run would mutate for real). A single Client guarantees isolation and
  // gives a real rowCount. Same connection string works for local PG + Neon.
  "async function withClient(fn){",
  "  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });",
  "  await client.connect();",
  "  try { await client.query(\"SET statement_timeout = '20s'\"); return await fn(client); }",
  "  finally { try { await client.end(); } catch {} }",
  "}",
  // ── helpers ───────────────────────────────────────────────────────────────
  "const ident = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '');", // table/column sanitizer
  "const COLS = new Set(['_id','created','updated']);",            // real columns vs JSONB keys
  "function fieldExpr(f){ const id = ident(f); return COLS.has(id) ? ('\"'+id+'\"') : (\"data->>'\"+id+\"'\"); }",
  // Build a parameterized WHERE from the structured filter list.
  "function buildWhere(filters, params){",
  "  const parts = [];",
  "  for (const f of (filters||[])){",
  "    const fe = fieldExpr(f.field); const op = f.op;",
  "    if (op === 'exists'){ parts.push('data ? $'+(params.push(ident(f.field)))); continue; }",
  "    const v = f.value == null ? '' : String(f.value);",
  "    if (op === 'contains'){ parts.push(fe+\" ILIKE '%'||$\"+(params.push(v))+\"||'%'\"); continue; }",
  "    if (op === 'eq'){ parts.push(fe+' = $'+(params.push(v))); continue; }",
  "    if (op === 'ne'){ parts.push('('+fe+' IS DISTINCT FROM $'+(params.push(v))+')'); continue; }",
  // gt/gte/lt/lte: numeric-aware (cast only when both sides look numeric).
  "    const cmp = { gt:'>', gte:'>=', lt:'<', lte:'<=' }[op]; if (!cmp) continue;",
  "    if (/^-?[0-9.]+$/.test(v)){ parts.push('(CASE WHEN '+fe+\" ~ '^-?[0-9.]+$' THEN (\"+fe+')::numeric END) '+cmp+' $'+(params.push(Number(v)))); }",
  "    else { parts.push(fe+' '+cmp+' $'+(params.push(v))); }",
  "  }",
  "  return parts.length ? (' WHERE '+parts.join(' AND ')) : '';",
  "}",
  "function flatten(rows){ return rows.map((row) => Object.assign({ _id: row._id }, (row.data && typeof row.data === 'object') ? row.data : {}, { _created: row.created, _updated: row.updated })); }",
  "function classify(sql){ const s = sql.replace(/^[\\s(]+/, '').slice(0, 12).toLowerCase(); if (/^(select|with|explain|show|table)/.test(s)) return 'read'; return 'write'; }",
  // ── ops ─────────────────────────────────────────────────────────────────────
  "let out = {};",
  "if (op === 'collections') {",
  "  const sql = \"SELECT c.relname AS name, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'pg_%' AND c.relname NOT LIKE 'sql_%' ORDER BY c.relname\";",
  "  const r = await q(sql);",
  "  out = { collections: r.rows.map((x) => ({ name: x.name, estimatedCount: Math.max(0, Number(x.n) || 0) })) };",
  "} else if (op === 'count') {",
  "  const r = await q('SELECT count(*)::bigint AS n FROM \"' + ident(input.collection) + '\"');",
  "  out = { count: Number(r.rows[0].n) || 0 };",
  "} else if (op === 'getDoc') {",
  "  const r = await q('SELECT data FROM \"' + ident(input.collection) + '\" WHERE _id = $1', [input.id]);",
  "  out = { doc: (r.rows[0] && r.rows[0].data) || null };",
  "} else if (op === 'getQuery') {",
  "  const t0 = Date.now();",
  "  const tbl = ident(input.collection);",
  "  const lim = Math.min(Number(input.limit) || 50, 1000), skip = Math.max(0, Number(input.skip) || 0);",
  "  const params = []; const where = buildWhere(input.filters, params);",
  "  const sortField = input.sort && input.sort.field ? fieldExpr(input.sort.field) : '\"created\"';",
  "  const dir = (input.sort && String(input.sort.dir).toLowerCase() === 'asc') ? 'ASC' : 'DESC';",
  "  const total = Number((await q('SELECT count(*)::bigint AS n FROM \"'+tbl+'\"'+where, params)).rows[0].n) || 0;",
  "  params.push(lim); params.push(skip);",
  "  const r = await q('SELECT _id, data, created, updated FROM \"'+tbl+'\"'+where+' ORDER BY '+sortField+' '+dir+' NULLS LAST LIMIT $'+(params.length-1)+' OFFSET $'+params.length, params);",
  "  const rows = flatten(r.rows);",
  "  const columns = rows.length ? Array.from(rows.reduce((s,row)=>{Object.keys(row).forEach(k=>s.add(k));return s;}, new Set())) : ['_id'];",
  "  out = { columns, rows, rowCount: rows.length, total, durationMs: Date.now() - t0 };",
  "} else if (op === 'exec') {",
  "  const t0 = Date.now();",
  "  const sql = String(input.sql || '').trim(); if (!sql) throw new Error('Empty SQL');",
  "  const kind = classify(sql);",
  "  const danger = /\\b(drop|truncate|alter)\\b/i.test(sql);",
  "  const blindWrite = kind === 'write' && /\\b(update|delete)\\b/i.test(sql) && !/\\bwhere\\b/i.test(sql);",
  "  if (kind === 'write' && !input.allowWrite) throw new Error('This is a write statement. Unlock writes to run it.');",
  "  if ((danger || blindWrite) && !input.force) throw new Error((danger ? 'DROP/TRUNCATE/ALTER' : 'UPDATE/DELETE without WHERE') + ' is blocked. Re-run with force to override.');",
  "  const params = Array.isArray(input.params) ? input.params : [];",
  "  out = await withClient(async (c) => {",
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
  "} else if (op === 'mutate') {",
  "  if (!input.allowWrite) throw new Error('Writes are locked. Unlock writes to mutate.');",
  "  const tbl = ident(input.collection);",
  // created/updated are timestamptz columns (the adapter writes now()), so we
  // use SQL now() here rather than epoch millis (which Postgres rejects).
  "  if (input.action === 'insert') {",
  "    const doc = (input.doc && typeof input.doc === 'object') ? input.doc : {};",
  "    const id = doc._id || crypto.randomUUID(); delete doc._id; delete doc._created; delete doc._updated;",
  "    await withClient((c) => c.query('INSERT INTO \"'+tbl+'\" (_id, data, created, updated) VALUES ($1,$2,now(),now())', [id, JSON.stringify(doc)]));",
  "    out = { ok: true, _id: id };",
  "  } else if (input.action === 'update') {",
  "    const doc = (input.doc && typeof input.doc === 'object') ? input.doc : {}; const id = input.id || doc._id; delete doc._id; delete doc._created; delete doc._updated;",
  "    if (!id) throw new Error('update needs an _id');",
  "    const r = await withClient((c) => c.query('UPDATE \"'+tbl+'\" SET data=$1, updated=now() WHERE _id=$2', [JSON.stringify(doc), id]));",
  "    out = { ok: true, _id: id, affected: r.rowCount || 0 };",
  "  } else if (input.action === 'delete') {",
  "    if (!input.id) throw new Error('delete needs an _id');",
  "    const r = await withClient((c) => c.query('DELETE FROM \"'+tbl+'\" WHERE _id=$1', [input.id]));",
  "    out = { ok: true, _id: input.id, affected: r.rowCount || 0 };",
  "  } else { throw new Error('Unknown mutate action: ' + input.action); }",
  "} else if (op === 'schema') {",
  "  const tbl = ident(input.collection);",
  "  const cols = (await q(\"SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position\", [tbl])).rows;",
  "  const idx = (await q(\"SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname\", [tbl])).rows;",
  "  const n = Number((await q('SELECT count(*)::bigint AS n FROM \"'+tbl+'\"')).rows[0].n) || 0;",
  "  out = { columns: cols, indexes: idx, count: n };",
  "}",
  // Force exit after the result flushes: createAdapter()'s pg pool keeps idle connections
  // (and thus the event loop) alive, so the process would otherwise never exit and the panel
  // hangs on "Loading…". Exit in the write callback so stdout isn't truncated on a pipe.
  "process.stdout.write(JSON.stringify(out), () => process.exit(0));",
].join('\n');
