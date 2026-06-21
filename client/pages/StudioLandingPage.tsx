import React, { useEffect, useMemo, useState } from 'react';
import { ScrollAnimatedView, ScrollView, View } from 'ugly-app/client';
import {
  buildInstallDownloadUrl,
  requestStudioInstall,
  type InstallOs,
} from '../lib/studioInstall';
import {
  BG,
  BG_ELEV,
  BORDER,
  BORDER_STRONG,
  BRAND,
  BRAND_GLOW,
  BRAND_GLOW_STRONG,
  BRAND_GRAD,
  ERR,
  FONT_BODY,
  FONT_DISPLAY,
  FONT_MONO,
  OK,
  ON_BRAND,
  TEXT,
  TEXT_FAINT,
  TEXT_MUTED,
  WARN,
} from '../landingBrandTokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArchAsset {
  url: string;
  filename: string;
  size: number;
}

interface PlatformInfo {
  url: string;
  filename: string;
  size: number;
  // Linux ships AppImage (the primary `url`) plus an optional .deb for
  // Debian/Ubuntu apt users, attached as a sibling so the card can offer both.
  deb?: ArchAsset;
  // Mac ships per-arch dmgs. The top-level `url` defaults to arm64; these let
  // the page serve the Intel build to Intel Macs.
  arm64?: ArchAsset;
  x64?: ArchAsset;
  // Present once a code-bearing .pkg is published — switches the mac CTA to the
  // auto-open install path (Plan 2).
  pkg?: ArchAsset;
}

interface ReleaseInfo {
  version: string;
  date: string;
  platforms: {
    mac?: PlatformInfo;
    win?: PlatformInfo;
    linux?: PlatformInfo;
  };
}

type OS = 'mac' | 'win' | 'linux';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'mac';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win';
  if (ua.includes('linux')) return 'linux';
  return 'mac';
}

type MacArch = 'arm64' | 'x64';

const macArchLabels: Record<MacArch, string> = {
  arm64: 'Apple Silicon',
  x64: 'Intel',
};

// Best-effort Apple-Silicon vs Intel detection. The User-Agent is useless here
// (every modern Mac reports "Intel Mac OS X"), so we read the WebGL GPU
// renderer: Apple Silicon reports an "Apple" GPU, Intel Macs report
// Intel/AMD/Radeon. Defaults to arm64 (the broadest current base) when
// uncertain — the user can always flip the toggle.
function detectMacArch(): MacArch {
  if (typeof document === 'undefined') return 'arm64';
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '')
        : '';
      if (/apple/i.test(renderer)) return 'arm64';
      if (/intel|amd|radeon|nvidia|geforce/i.test(renderer)) return 'x64';
    }
  } catch {
    /* fall through to default */
  }
  return 'arm64';
}

// Resolve the mac download for a given arch, falling back to the top-level
// (arm64) entry on older metadata that has no per-arch sub-entries.
function macAssetFor(
  mac: PlatformInfo | null | undefined,
  arch: MacArch,
): PlatformInfo | null {
  if (!mac) return null;
  const sub = mac[arch];
  return sub ? { url: sub.url, filename: sub.filename, size: sub.size } : mac;
}

const osLabels: Record<OS, string> = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux',
};

const osShellHints: Record<OS, string> = {
  mac: 'brew install --cask ugly-studio',
  win: 'winget install ugly-bot.studio',
  linux: 'curl -fsSL ugly.bot/install | sh',
};

function formatSize(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0) + ' MB';
}

// ---------------------------------------------------------------------------
// Style injection
// ---------------------------------------------------------------------------

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const sheet = document.createElement('style');
  sheet.textContent = `
    @keyframes ugly-studio-blink { to { visibility: hidden; } }
    @keyframes ugly-studio-pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes ugly-studio-loop {
      0%, 33% { box-shadow: 0 0 24px ${BRAND_GLOW_STRONG}; border-color: ${BRAND}; color: ${BRAND}; background: ${BRAND_GLOW}; }
      34%, 100% { box-shadow: none; border-color: ${BORDER_STRONG}; color: ${TEXT_MUTED}; background: transparent; }
    }
    @keyframes ugly-bar-fill { from { width: 0; } }
    .ugly-cta:hover {
      box-shadow: 0 0 24px ${BRAND_GLOW_STRONG};
      transform: translateY(-1px);
    }
    .ugly-loop-node-1 { animation: ugly-studio-loop 2.7s ${BRAND_GLOW} infinite; animation-delay: 0s; }
    .ugly-loop-node-2 { animation: ugly-studio-loop 2.7s infinite; animation-delay: 0.9s; }
    .ugly-loop-node-3 { animation: ugly-studio-loop 2.7s infinite; animation-delay: 1.8s; }
    .ugly-link:hover { color: ${BRAND} !important; }
  `;
  document.head.appendChild(sheet);
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

// Responsive helper (replaces the monolith's global.isDesktop)
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 900,
  );
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isDesktop;
}

export default function StudioLandingPage(): React.ReactElement {
  const isDesktop = useIsDesktop();
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  // Detected (or user-overridden) Mac architecture, shared by the hero +
  // install cards so a toggle in one place updates both.
  const [macArch, setMacArch] = useState<MacArch>('arm64');

  useEffect(() => {
    injectStyles();
    setMacArch(detectMacArch());
    fetch('https://studio.ugly.bot/releases/studio-latest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ReleaseInfo | null) => {
        if (data) setRelease(data);
      })
      .catch(() => {});
  }, []);

  return (
    <View style={{ flex: 1, background: BG }}>
      <ScrollView showScrollArrow>
        <NavBar />
        <HeroInstall
          isDesktop={isDesktop}
          release={release}
          macArch={macArch}
          setMacArch={setMacArch}
        />
        <HarnessLayer isDesktop={isDesktop} />
        <IDELayer isDesktop={isDesktop} />
        <PlatformLayer isDesktop={isDesktop} />
        <BetSection isDesktop={isDesktop} />
        <InstallDeep
          isDesktop={isDesktop}
          release={release}
          macArch={macArch}
          setMacArch={setMacArch}
        />
        <ShowEnd isDesktop={isDesktop} />
        <FooterSection />
      </ScrollView>
    </View>
  );
}

// Small Apple Silicon / Intel switch shown on Mac download surfaces.
function MacArchToggle({
  macArch,
  setMacArch,
}: {
  macArch: MacArch;
  setMacArch: (a: MacArch) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        border: `1px solid ${BORDER_STRONG}`,
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        fontWeight: 700,
      }}
    >
      {(['arm64', 'x64'] as MacArch[]).map((a) => {
        const active = a === macArch;
        return (
          <button
            key={a}
            type="button"
            onClick={() => setMacArch(a)}
            style={{
              padding: '6px 12px',
              background: active ? BRAND_GLOW : 'transparent',
              color: active ? BRAND : TEXT_MUTED,
              border: 'none',
              borderRight: a === 'arm64' ? `1px solid ${BORDER_STRONG}` : 'none',
              cursor: 'pointer',
              font: 'inherit',
              letterSpacing: 'inherit',
              textTransform: 'inherit',
            }}
          >
            {macArchLabels[a]}
          </button>
        );
      })}
    </div>
  );
}

// ===========================================================================
// NAV BAR
// ===========================================================================

function NavBar() {
  return (
    <div
      style={{
        borderBottom: `1px solid ${BORDER}`,
        background: BG,
        position: 'sticky',
        top: 0,
        zIndex: 30,
        backdropFilter: 'blur(12px)',
      }}
    >
      <Shell>
        <div
          style={{
            padding: '18px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 32,
            flexWrap: 'wrap',
          }}
        >
          <a
            href="/"
            style={{
              fontFamily: FONT_DISPLAY,
              fontWeight: 800,
              fontSize: 20,
              letterSpacing: '-0.03em',
              color: TEXT,
              textDecoration: 'none',
            }}
          >
            ugly<span style={{ color: BRAND }}>.</span>bot
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: TEXT_FAINT,
                fontWeight: 700,
                marginLeft: 14,
              }}
            >
              / studio
            </span>
          </a>
          <div
            style={{
              display: 'flex',
              gap: 28,
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: TEXT_MUTED,
              fontWeight: 700,
            }}
          >
            <NavLink href="#harness">01 Harness</NavLink>
            <NavLink href="#ide">02 IDE</NavLink>
            <NavLink href="#platform">03 Platform</NavLink>
            <NavLink href="#install">Install</NavLink>
            <NavLink href="/">← ugly.bot</NavLink>
          </div>
        </div>
      </Shell>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="ugly-link"
      href={href}
      style={{ color: TEXT_MUTED, textDecoration: 'none', transition: 'color 160ms ease' }}
    >
      {children}
    </a>
  );
}

// ===========================================================================
// HERO + INSTALL
// ===========================================================================

function HeroInstall({
  isDesktop,
  release,
  macArch,
  setMacArch,
}: {
  isDesktop: boolean;
  release: ReleaseInfo | null;
  macArch: MacArch;
  setMacArch: (a: MacArch) => void;
}) {
  const userOS = useMemo(detectOS, []);
  // On Mac, serve the detected/selected arch (Apple Silicon vs Intel);
  // other OSes use their single platform entry.
  const primary =
    userOS === 'mac'
      ? macAssetFor(release?.platforms.mac, macArch)
      : release?.platforms[userOS];
  const [winPromptUrl, setWinPromptUrl] = useState<string | null>(null);

  // Map the detected OS (+ mac arch) to a download target for the handoff. On
  // mac, prefer the code-bearing .pkg once one is published (auto-open); until
  // then fall back to the per-arch dmg (no auto-open, unchanged behavior).
  const macTarget: InstallOs = release?.platforms.mac?.pkg
    ? 'mac-pkg'
    : macArch === 'x64'
      ? 'mac-x64'
      : 'mac-arm64';
  const installOs: InstallOs =
    userOS === 'win' ? 'win' : userOS === 'linux' ? 'linux-appimage' : macTarget;

  // On click: create an install intent so Studio opens code.ugly.bot after
  // install, then download via the code-bearing /dl URL when the target can
  // recover the code (win, AppImage); otherwise fall back to the direct asset.
  // The Windows flow keeps showing its SmartScreen prompt modal (with the /dl
  // URL); other OSes navigate straight to the download.
  const onPrimaryClick = (e: { preventDefault(): void }) => {
    e.preventDefault();
    void (async () => {
      const code = await requestStudioInstall('https://code.ugly.bot');
      const dl = code ? buildInstallDownloadUrl(installOs, code) : null;
      const url = dl ?? primary?.url ?? null;
      if (!url) return;
      if (userOS === 'win') setWinPromptUrl(url);
      else window.location.href = url;
    })();
  };

  return (
    <div
      style={{
        position: 'relative',
        paddingTop: isDesktop ? 96 : 56,
        paddingBottom: isDesktop ? 80 : 56,
        paddingLeft: 24,
        paddingRight: 24,
        background: BG,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '-25%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '90vw',
          height: '70vw',
          maxWidth: 1400,
          maxHeight: 1000,
          background: `radial-gradient(circle at center, ${BRAND_GLOW} 0%, transparent 55%)`,
          filter: 'blur(30px)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <Shell>
        <ScrollAnimatedView animation="fadeIn" delay={0} threshold={0}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              color: BRAND,
              fontWeight: 700,
              marginBottom: 28,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                background: BRAND,
                boxShadow: `0 0 10px ${BRAND}`,
              }}
            />
            The studio from the YouTube show
          </div>
        </ScrollAnimatedView>

        <ScrollAnimatedView animation="slideUp" delay={100} threshold={0}>
          <h1
            style={{
              fontFamily: FONT_DISPLAY,
              fontWeight: 800,
              fontSize: isDesktop ? 'clamp(56px, 7.5vw, 96px)' : 44,
              lineHeight: 0.94,
              letterSpacing: '-0.045em',
              color: TEXT,
              margin: '0 0 28px',
            }}
          >
            <span style={{ display: 'block' }}>Three layers.</span>
            <span style={{ display: 'block' }}>
              One <span style={{ color: BRAND }}>cheap</span> model.
            </span>
            <span style={{ display: 'block' }}>Stacked, they ship.</span>
          </h1>
        </ScrollAnimatedView>

        <ScrollAnimatedView animation="slideUp" delay={300} threshold={0}>
          <p
            style={{
              fontFamily: FONT_BODY,
              fontSize: isDesktop ? 20 : 17,
              color: TEXT_MUTED,
              lineHeight: 1.55,
              maxWidth: 720,
              marginBottom: 12,
            }}
          >
            <strong style={{ color: TEXT, fontWeight: 700 }}>
              ugly-studio + GLM-5.1
            </strong>{' '}
            (or your model of choice) vs. Claude Code + Sonnet, at{' '}
            <span style={{ color: BRAND, fontWeight: 700 }}>
              less than 20% of the cost
            </span>
            . Same eval. Same bar. The bill is on screen.
          </p>
        </ScrollAnimatedView>

        <ScrollAnimatedView animation="slideUp" delay={450} threshold={0}>
          <div
            style={{
              display: 'flex',
              gap: 32,
              margin: '40px 0 48px',
              flexWrap: 'wrap',
            }}
          >
            <Stat v="35" k="tools wired" />
            <Stat v="$0.22" k="cost / task" />
            <Stat v="84.0%" k="eval score" />
          </div>
        </ScrollAnimatedView>

        <ScrollAnimatedView animation="slideUp" delay={550} threshold={0}>
          <div
            style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}
          >
            <a
              className="ugly-cta"
              href={primary?.url ?? '#install'}
              onClick={onPrimaryClick}
              style={primaryButtonStyle(!!primary)}
            >
              Download for {osLabels[userOS]}
              {primary && (
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, opacity: 0.7 }}>
                  {formatSize(primary.size)}
                </span>
              )}
              <span style={{ fontSize: 16, fontWeight: 900 }}>→</span>
            </a>
            {userOS === 'mac' && release?.platforms.mac && (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <MacArchToggle macArch={macArch} setMacArch={setMacArch} />
              </div>
            )}
            {userOS !== 'win' && release?.platforms.win && (
              <a
                className="ugly-cta"
                href="#install"
                style={ghostButtonStyle()}
              >
                Windows
              </a>
            )}
            {userOS !== 'linux' && release?.platforms.linux && (
              <a
                className="ugly-cta"
                href="#install"
                style={ghostButtonStyle()}
              >
                Linux
              </a>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: TEXT_FAINT,
              fontWeight: 700,
              flexWrap: 'wrap',
            }}
          >
            <a href="#install" className="ugly-link" style={navMetaStyle()}>
              System requirements
            </a>
            <a href="#install" className="ugly-link" style={navMetaStyle()}>
              Changelog
            </a>
          </div>
        </ScrollAnimatedView>
      </Shell>

      <WindowsTrustModal
        url={winPromptUrl}
        onClose={() => setWinPromptUrl(null)}
      />
    </div>
  );
}

function Stat({ v, k }: { v: string; k: string }) {
  return (
    <div style={{ borderLeft: `2px solid ${BRAND}`, paddingLeft: 18 }}>
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: '-0.025em',
          lineHeight: 1,
          color: BRAND,
        }}
      >
        {v}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
          marginTop: 8,
        }}
      >
        {k}
      </div>
    </div>
  );
}

// ===========================================================================
// 01 — THE HARNESS
// ===========================================================================

function HarnessLayer({ isDesktop }: { isDesktop: boolean }) {
  return (
    <LayerWrap id="harness" num="01" lbl="The harness" isDesktop={isDesktop}>
      <LayerHeading isDesktop={isDesktop}>
        Cuts the model off when it{' '}
        <span style={{ color: BRAND }}>wanders</span>.
      </LayerHeading>
      <LayerPromise>Hard caps · budget ledger · 3-strike termination</LayerPromise>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isDesktop ? '1.4fr 1fr' : '1fr',
          gap: 48,
          alignItems: 'start',
          marginTop: 56,
        }}
      >
        <HarnessTranscript />
        <div>
          <LoopCard />
          <Guards />
          <CodeCite
            path="studio/server/coding-agent/session-loop/session-loop.ts:50"
          />
        </div>
      </div>
    </LayerWrap>
  );
}

function HarnessTranscript() {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        background: BG_ELEV,
        padding: '28px 32px',
        fontFamily: FONT_MONO,
        fontSize: 14,
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${BORDER}`,
          paddingBottom: 14,
          marginBottom: 22,
          fontSize: 10,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
        }}
      >
        <span>session · model: GLM-5.1</span>
        <span style={{ color: OK, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              background: OK,
              boxShadow: `0 0 8px ${OK}`,
              animation: 'ugly-studio-pulse-dot 1.4s ease-in-out infinite',
              display: 'inline-block',
            }}
          />
          running
        </span>
      </div>
      <Msg
        who="harness"
        body={
          <>
            <span style={{ color: TEXT_FAINT }}>TOOLS:</span>{' '}
            <span style={{ color: BRAND }}>read</span> ·{' '}
            <span style={{ color: BRAND }}>edit</span> ·{' '}
            <span style={{ color: BRAND }}>bash</span> ·{' '}
            <span style={{ color: BRAND }}>grep</span> ·{' '}
            <span style={{ color: TEXT_FAINT }}>+ 31 more</span>
          </>
        }
        brand
      />
      <Msg
        who="model"
        body={
          <>
            → <span style={{ color: BRAND }}>bash</span>{' '}
            <span style={{ color: TEXT_FAINT }}>·</span> tsc --noEmit
          </>
        }
      />
      <Msg
        who="harness"
        body={<span style={{ color: ERR }}>3 errors.</span>}
        brand
      />
      <Msg
        who="model"
        body={
          <>
            → <span style={{ color: BRAND }}>edit</span>{' '}
            <span style={{ color: TEXT_FAINT }}>·</span> Page.tsx
          </>
        }
      />
      <Msg
        who="harness"
        body={<span style={{ color: OK }}>✓ 0 errors</span>}
        brand
      />
      <Msg
        who="model"
        body={
          <>
            → <span style={{ color: OK }}>done.</span>
          </>
        }
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          borderTop: `1px solid ${BORDER}`,
          marginTop: 18,
          paddingTop: 18,
          fontSize: 11,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: TEXT_MUTED,
          fontWeight: 700,
        }}
      >
        <div>
          turn <Counter v="6" />
        </div>
        <div>
          cost <Counter v="$0.0089" brand />
        </div>
        <div>
          wall <Counter v="14s" />
        </div>
      </div>
    </div>
  );
}

function Msg({
  who,
  body,
  brand,
}: {
  who: string;
  body: React.ReactNode;
  brand?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '80px 1fr',
        gap: 18,
        marginBottom: 10,
        alignItems: 'start',
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          fontWeight: 700,
          paddingTop: 4,
          textAlign: 'right',
          color: brand ? BRAND : TEXT_FAINT,
        }}
      >
        {who}
      </div>
      <div
        style={{
          borderLeft: `2px solid ${brand ? BRAND : BORDER}`,
          paddingLeft: 16,
          color: TEXT,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function Counter({ v, brand }: { v: string; brand?: boolean }) {
  return (
    <span
      style={{
        fontSize: 18,
        letterSpacing: 0,
        textTransform: 'none',
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        marginLeft: 10,
        color: brand ? BRAND : TEXT,
      }}
    >
      {v}
    </span>
  );
}

function LoopCard() {
  return (
    <div style={{ border: `1px solid ${BORDER}`, background: BG_ELEV, padding: 28 }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.26em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
          marginBottom: 22,
        }}
      >
        the loop
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 16,
        }}
      >
        <LoopNode label="model" index={1} />
        <span style={{ color: TEXT_FAINT, fontFamily: FONT_MONO }}>→</span>
        <LoopNode label="tool" index={2} />
        <span style={{ color: TEXT_FAINT, fontFamily: FONT_MONO }}>→</span>
        <LoopNode label="result" index={3} />
      </div>
      <div
        style={{
          textAlign: 'center',
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          marginTop: 12,
          fontWeight: 700,
        }}
      >
        ↻ until <span style={{ color: BRAND }}>done</span>
      </div>
    </div>
  );
}

function LoopNode({ label, index }: { label: string; index: 1 | 2 | 3 }) {
  return (
    <div
      className={`ugly-loop-node-${index}`}
      style={{
        flex: 1,
        textAlign: 'center',
        padding: '18px 8px',
        border: `1px solid ${BORDER_STRONG}`,
        fontFamily: FONT_MONO,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: TEXT_MUTED,
      }}
    >
      {label}
    </div>
  );
}

function Guards() {
  return (
    <div
      style={{
        marginTop: 28,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 14,
      }}
    >
      <Guard k="Round cap" v="100" desc="Hard limit before forced summarize." />
      <Guard k="Wall clock" v="12 h" desc="Absolute ceiling per session." />
      <Guard k="Cost cap" v="$ usd" desc="Configurable. Ledgered per call." />
      <Guard k="3-strike" v="stop" desc="3 consecutive give-up turns → terminate." />
    </div>
  );
}

function Guard({ k, v, desc }: { k: string; v: string; desc: string }) {
  return (
    <div style={{ border: `1px solid ${BORDER}`, padding: 18, fontFamily: FONT_MONO }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 26,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: BRAND,
          lineHeight: 1,
        }}
      >
        {v}
      </div>
      <div
        style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 8, lineHeight: 1.5 }}
      >
        {desc}
      </div>
    </div>
  );
}

function CodeCite({ path }: { path: string }) {
  return (
    <div
      style={{
        marginTop: 24,
        fontFamily: FONT_MONO,
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: TEXT_FAINT,
        fontWeight: 700,
      }}
    >
      Grounded in{' '}
      <span style={{ color: TEXT_MUTED, textTransform: 'none', letterSpacing: 0 }}>
        {path}
      </span>
    </div>
  );
}

// ===========================================================================
// 02 — THE IDE
// ===========================================================================

function IDELayer({ isDesktop }: { isDesktop: boolean }) {
  return (
    <LayerWrap id="ide" num="02" lbl="The IDE" isDesktop={isDesktop}>
      <LayerHeading isDesktop={isDesktop}>
        Gives the model <span style={{ color: BRAND }}>real evidence</span>.
      </LayerHeading>
      <LayerPromise>More tools wired in than any other coding agent</LayerPromise>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isDesktop ? '1fr 1.2fr' : '1fr',
          gap: 48,
          alignItems: 'start',
          marginTop: 56,
        }}
      >
        <ToolChart />
        <ToolList />
      </div>
    </LayerWrap>
  );
}

function ToolChart() {
  const bars: { name: string; w: number; v: number; us?: boolean }[] = [
    { name: 'opencode', w: 32, v: 11 },
    { name: 'claude code', w: 79, v: 27 },
    { name: 'ugly-studio', w: 100, v: 35, us: true },
  ];
  return (
    <div style={{ border: `1px solid ${BORDER}`, background: BG_ELEV, padding: 28 }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.26em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
          marginBottom: 26,
        }}
      >
        Tools wired into the agent
      </div>
      {bars.map((b) => (
        <div
          key={b.name}
          style={{
            display: 'grid',
            gridTemplateColumns: '110px 1fr 50px',
            gap: 14,
            alignItems: 'center',
            marginBottom: 16,
            fontFamily: FONT_MONO,
            fontSize: 13,
          }}
        >
          <div
            style={{
              color: b.us ? BRAND : TEXT_MUTED,
              letterSpacing: '0.04em',
              textAlign: 'right',
              fontWeight: b.us ? 700 : 400,
            }}
          >
            {b.name}
          </div>
          <div
            style={{
              height: 16,
              background: 'rgba(255,255,255,0.04)',
              border: `1px solid ${BORDER}`,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                width: `${b.w}%`,
                background: b.us ? BRAND : TEXT_MUTED,
                boxShadow: b.us ? `0 0 14px ${BRAND_GLOW_STRONG}` : 'none',
                animation: 'ugly-bar-fill 1100ms cubic-bezier(0.16,1,0.3,1) 200ms both',
              }}
            />
          </div>
          <div
            style={{
              fontWeight: 700,
              color: b.us ? BRAND : TEXT,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {b.v}
          </div>
        </div>
      ))}
      <div
        style={{
          marginTop: 20,
          paddingTop: 14,
          borderTop: `1px solid ${BORDER}`,
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
          lineHeight: 1.7,
        }}
      >
        Captured June 2026 · proxy logs in
        <br />
        <span style={{ color: TEXT_MUTED, textTransform: 'none', letterSpacing: 0 }}>
          studio/evals/proxy-logs/v4-gap-compare/REPORT.md
        </span>
      </div>
    </div>
  );
}

function ToolList() {
  const tools: { name: string; gap?: boolean }[] = [
    { name: 'read' }, { name: 'edit' }, { name: 'bash' },
    { name: 'grep' }, { name: 'glob' }, { name: 'write' },
    { name: 'todos' }, { name: 'multiedit' }, { name: 'web_fetch' },
    { name: 'python_exec', gap: true },
    { name: 'memory_save', gap: true },
    { name: 'spec_write', gap: true },
    { name: 'delegate', gap: true },
    { name: 'analyze_image', gap: true },
    { name: 'dep_docs', gap: true },
    { name: 'inspect_ux', gap: true },
    { name: 'dev_server_screenshot', gap: true },
    { name: 'dev_server_errors', gap: true },
    { name: 'dev_server_logs', gap: true },
    { name: 'database', gap: true },
    { name: 'database_sql_query', gap: true },
  ];
  return (
    <div style={{ border: `1px solid ${BORDER}`, background: BG_ELEV, padding: 28 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${BORDER}`,
          paddingBottom: 16,
          marginBottom: 22,
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: TEXT_MUTED,
        }}
      >
        <span>Native to ugly-studio</span>
        <span
          style={{
            color: BRAND,
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: 0,
            fontFamily: FONT_DISPLAY,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          35
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          border: `1px solid ${BORDER}`,
        }}
      >
        {tools.map((t, i) => (
          <div
            key={t.name}
            style={{
              padding: '14px 12px',
              borderRight: (i + 1) % 3 === 0 ? 'none' : `1px solid ${BORDER}`,
              borderBottom: i >= tools.length - 3 ? 'none' : `1px solid ${BORDER}`,
              fontFamily: FONT_MONO,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.02em',
              color: t.gap ? BRAND : TEXT,
              background: t.gap ? 'rgba(255, 85, 0, 0.10)' : 'transparent',
            }}
          >
            {t.name}
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 18,
          display: 'flex',
          gap: 24,
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
        }}
      >
        <span>
          <Swatch color={BRAND} /> only in ugly-studio
        </span>
        <span>
          <Swatch color={TEXT_MUTED} /> shared
        </span>
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        background: color,
        marginRight: 8,
        verticalAlign: -1,
      }}
    />
  );
}

// ===========================================================================
// 03 — THE PLATFORM
// ===========================================================================

function PlatformLayer({ isDesktop }: { isDesktop: boolean }) {
  return (
    <LayerWrap id="platform" num="03" lbl="The platform" isDesktop={isDesktop}>
      <LayerHeading isDesktop={isDesktop}>
        The app <span style={{ color: BRAND }}>answers</span> the agent.
      </LayerHeading>
      <LayerPromise>Because we built the framework it runs on</LayerPromise>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isDesktop ? '1fr 70px 1.2fr' : '1fr',
          gap: 24,
          alignItems: 'stretch',
          marginTop: 56,
        }}
      >
        <PlatformAppCard />
        <PlatformArrow rotate={!isDesktop} />
        <PlatformOutputs />
      </div>

      <CodeCite path="studio/server/coding-agent/tools/inspect-ux.ts · dev_server_screenshot · dev_server_errors" />
    </LayerWrap>
  );
}

function PlatformAppCard() {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        background: BG_ELEV,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '14px 22px',
          borderBottom: `1px solid ${BORDER}`,
          fontFamily: FONT_MONO,
          fontSize: 12,
          color: TEXT_MUTED,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span style={{ display: 'flex', gap: 6 }}>
          <BrowserDot />
          <BrowserDot />
          <BrowserDot />
        </span>
        <span style={{ color: TEXT, marginLeft: 6 }}>image-gallery.ugly.app</span>
        <span
          style={{
            marginLeft: 'auto',
            color: OK,
            fontSize: 10,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              background: OK,
              boxShadow: `0 0 8px ${OK}`,
              animation: 'ugly-studio-pulse-dot 1.4s ease-in-out infinite',
            }}
          />
          live
        </span>
      </div>
      <div
        style={{
          flex: 1,
          padding: '36px 30px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 22,
        }}
      >
        <div
          style={{
            width: 80,
            height: 80,
            border: `1px solid ${BORDER_STRONG}`,
            display: 'grid',
            placeItems: 'center',
            color: BRAND,
            fontSize: 32,
            fontFamily: FONT_DISPLAY,
          }}
        >
          ▣
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: TEXT,
          }}
        >
          image-gallery
        </div>
        <div
          style={{
            width: '100%',
            maxWidth: 320,
            padding: '12px 16px',
            border: `1px solid ${BORDER}`,
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: TEXT_MUTED,
            lineHeight: 1.8,
          }}
        >
          <ActivityRow verb="click" rest="/gallery" />
          <ActivityRow verb="upload" rest="photo.jpg" />
          <ActivityRow verb="render" rest="242ms" />
          <ActivityRow
            verb="error"
            rest={
              <span style={{ color: ERR }}>NPE: thumbnails[0]</span>
            }
          />
        </div>
      </div>
    </div>
  );
}

function BrowserDot() {
  return (
    <span
      style={{ width: 9, height: 9, border: `1px solid ${TEXT_FAINT}`, display: 'inline-block' }}
    />
  );
}

function ActivityRow({
  verb,
  rest,
}: {
  verb: string;
  rest: React.ReactNode;
}) {
  return (
    <div>
      <span
        style={{
          color: BRAND,
          fontWeight: 700,
          display: 'inline-block',
          minWidth: 56,
        }}
      >
        {verb}
      </span>{' '}
      {rest}
    </div>
  );
}

function PlatformArrow({ rotate }: { rotate?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: BRAND,
        fontSize: 32,
        transform: rotate ? 'rotate(90deg)' : 'none',
      }}
    >
      <div>→</div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: TEXT_FAINT,
        }}
      >
        structured
      </div>
    </div>
  );
}

function PlatformOutputs() {
  return (
    <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 16 }}>
      <EventsCard />
      <VisionCard />
    </div>
  );
}

function EventsCard() {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        background: BG_ELEV,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CardHead title="events · errors · perf" right="inspect_ux + dev_server_*" />
      <div
        style={{
          padding: '18px 22px',
          fontFamily: FONT_MONO,
          fontSize: 13,
          lineHeight: 1.9,
          flex: 1,
        }}
      >
        <TickerRow>
          <K>event=</K><V>click</V> <K>route=</K><V>/gallery</V>
        </TickerRow>
        <TickerRow>
          <K>event=</K><V>upload</V> <K>size=</K><V>2.1mb</V>
        </TickerRow>
        <TickerRow>
          <K>perf=</K><V>render</V> <K>ms=</K><V>242</V>
        </TickerRow>
        <TickerRow>
          <K>error=</K>
          <span style={{ color: ERR }}>NPE</span>{' '}
          <K>file=</K><V>Page.tsx:42</V>
        </TickerRow>
        <TickerRow>
          <K>feedback=</K><V>&quot;lightbox stuck&quot;</V>
        </TickerRow>
      </div>
    </div>
  );
}

function VisionCard() {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        background: BG_ELEV,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CardHead title="vision capture" right="image + dom" />
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 1.3fr',
          minHeight: 0,
        }}
      >
        <div
          style={{
            borderRight: `1px solid ${BORDER}`,
            padding: '14px 16px',
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 9,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: TEXT_FAINT,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            screenshot
          </div>
          <div
            style={{
              background: BG,
              border: `1px solid ${BORDER}`,
              padding: 10,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 6,
            }}
          >
            <Thumb />
            <Thumb />
            <Thumb />
            <Thumb />
            <Thumb missing />
            <Thumb />
          </div>
        </div>
        <div
          style={{
            padding: '14px 18px',
            fontFamily: FONT_MONO,
            fontSize: 12,
            lineHeight: 1.6,
            color: TEXT,
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: TEXT_FAINT,
              fontWeight: 700,
              marginBottom: 6,
            }}
          >
            dom · structured
          </div>
          <div>{'{'}</div>
          <div style={{ paddingLeft: 14 }}>
            <K>&quot;tag&quot;</K>: <S>&quot;div&quot;</S>,
          </div>
          <div style={{ paddingLeft: 14 }}>
            <K>&quot;id&quot;</K>: <S>&quot;gallery&quot;</S>,
          </div>
          <div style={{ paddingLeft: 14 }}>
            <K>&quot;thumbs&quot;</K>: <span style={{ color: WARN }}>6</span>,
          </div>
          <div style={{ paddingLeft: 14 }}>
            <K>&quot;missing&quot;</K>: <span style={{ color: ERR }}>[5]</span>,
          </div>
          <div style={{ paddingLeft: 14 }}>
            <K>&quot;lightbox&quot;</K>: <span style={{ color: TEXT_FAINT }}>null</span>
          </div>
          <div>{'}'}</div>
        </div>
      </div>
    </div>
  );
}

function CardHead({ title, right }: { title: string; right: string }) {
  return (
    <div
      style={{
        padding: '12px 22px',
        borderBottom: `1px solid ${BORDER}`,
        fontFamily: FONT_MONO,
        fontSize: 11,
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        fontWeight: 700,
        color: BRAND,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <span>{title}</span>
      <span style={{ color: TEXT_FAINT }}>{right}</span>
    </div>
  );
}

function Thumb({ missing }: { missing?: boolean }) {
  return (
    <div
      style={{
        background: missing ? 'transparent' : 'rgba(255, 85, 0, 0.18)',
        border: `1px ${missing ? 'dashed' : 'solid'} ${missing ? ERR : BRAND}`,
        aspectRatio: '1',
      }}
    />
  );
}

function TickerRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
      {children}
    </div>
  );
}

function K({ children }: { children: React.ReactNode }) {
  return <span style={{ color: BRAND }}>{children}</span>;
}

function V({ children }: { children: React.ReactNode }) {
  return <span style={{ color: TEXT }}>{children}</span>;
}

function S({ children }: { children: React.ReactNode }) {
  return <span style={{ color: OK }}>{children}</span>;
}

// ===========================================================================
// 04 — THE BET
// ===========================================================================

function BetSection({ isDesktop }: { isDesktop: boolean }) {
  const rows: { model: string; w: number; score: string; price: string; us?: boolean }[] = [
    { model: 'ugly-studio + GLM-5.1', w: 95, score: '84.0', price: '$0.22', us: true },
    { model: 'claude code + Sonnet 4.6', w: 93, score: '82.8', price: '$0.31' },
    { model: 'claude code + Opus 4.7', w: 98, score: '86.8', price: '$1.46' },
  ];
  return (
    <LayerWrap num="04" lbl="The bet, in numbers" isDesktop={isDesktop}>
      <LayerHeading isDesktop={isDesktop}>
        Cheap model. <span style={{ color: BRAND }}>Same bar</span>.
      </LayerHeading>
      <LayerPromise>Eval suite · 100 tasks · no cherry-picking</LayerPromise>

      <div
        style={{
          border: `1px solid ${BORDER}`,
          background: BG_ELEV,
          padding: isDesktop ? '32px 36px' : 24,
          maxWidth: 760,
          marginTop: 56,
        }}
      >
        <BetRow
          head
          model="Model"
          scoreSlot="Score"
          score="%"
          price="$ / task"
        />
        {rows.map((r) => (
          <BetRow
            key={r.model}
            model={r.model}
            scoreFill={r.w}
            score={r.score}
            price={r.price}
            us={r.us ?? false}
          />
        ))}
      </div>

      <div
        style={{
          marginTop: 24,
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
        }}
      >
        Methodology · <span style={{ color: TEXT_MUTED }}>youtube/EP01_MEDIUM_ARTICLE.md</span>
      </div>
    </LayerWrap>
  );
}

function BetRow({
  head,
  model,
  scoreFill,
  scoreSlot,
  score,
  price,
  us,
}: {
  head?: boolean;
  model: string;
  scoreFill?: number;
  scoreSlot?: string;
  score: string;
  price: string;
  us?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '130px 1fr 90px 90px',
        gap: 18,
        alignItems: 'center',
        padding: '16px 0',
        borderBottom: head ? `1px solid ${BORDER}` : `1px solid ${BORDER}`,
        fontFamily: FONT_MONO,
        fontSize: head ? 10 : 13,
        letterSpacing: head ? '0.22em' : '0.02em',
        textTransform: head ? 'uppercase' : 'none',
        color: head ? TEXT_FAINT : TEXT,
        fontWeight: head ? 700 : us ? 700 : 500,
      }}
    >
      <div style={{ color: head ? TEXT_FAINT : us ? BRAND : TEXT }}>{model}</div>
      {head ? (
        <div>{scoreSlot}</div>
      ) : (
        <div
          style={{
            height: 12,
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${BORDER}`,
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${scoreFill ?? 0}%`,
              background: us ? BRAND : TEXT_MUTED,
              boxShadow: us ? `0 0 12px ${BRAND_GLOW_STRONG}` : 'none',
            }}
          />
        </div>
      )}
      <div
        style={{
          textAlign: 'right',
          fontWeight: head ? 700 : 700,
          color: head ? TEXT_FAINT : us ? BRAND : TEXT,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {score}
      </div>
      <div
        style={{
          textAlign: 'right',
          fontWeight: 700,
          color: head ? TEXT_FAINT : us ? BRAND : TEXT,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {price}
      </div>
    </div>
  );
}

// ===========================================================================
// 05 — INSTALL DEEP
// ===========================================================================

function InstallDeep({
  isDesktop,
  release,
  macArch,
  setMacArch,
}: {
  isDesktop: boolean;
  release: ReleaseInfo | null;
  macArch: MacArch;
  setMacArch: (a: MacArch) => void;
}) {
  return (
    <LayerWrap id="install" num="05" lbl="Install" isDesktop={isDesktop}>
      <LayerHeading isDesktop={isDesktop}>
        Pick a binary. <span style={{ color: BRAND }}>Open it</span>. Start a project.
      </LayerHeading>
      <LayerPromise>Mac · Windows · Linux</LayerPromise>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isDesktop ? 'repeat(3, 1fr)' : '1fr',
          gap: 18,
          marginTop: 56,
        }}
      >
        <InstallCard
          platform={
            <>
              Mac<span style={{ color: BRAND }}>OS</span>
            </>
          }
          req="macOS 13 Ventura or later · Apple Silicon or Intel"
          fileLabel=".dmg"
          shell={osShellHints.mac}
          info={macAssetFor(release?.platforms.mac, macArch)}
          archToggle={
            release?.platforms.mac &&
            (release.platforms.mac.arm64 || release.platforms.mac.x64) ? (
              <MacArchToggle macArch={macArch} setMacArch={setMacArch} />
            ) : undefined
          }
        />
        <InstallCard
          platform={
            <>
              Win<span style={{ color: BRAND }}>dows</span>
            </>
          }
          req="Windows 11 · 22H2 or later · x64 / ARM64"
          fileLabel=".exe"
          shell={osShellHints.win}
          info={release?.platforms.win ?? null}
        />
        <InstallCard
          platform={
            <>
              Lin<span style={{ color: BRAND }}>ux</span>
            </>
          }
          req="x86_64 · glibc 2.31+ · GTK 3"
          fileLabel=".AppImage"
          shell={osShellHints.linux}
          info={release?.platforms.linux ?? null}
        />
      </div>

      {/* Mobile — the Ugly Browser ships the IDE to phones too. */}
      <div
        style={{
          marginTop: 44,
          display: 'flex',
          flexDirection: isDesktop ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: TEXT_MUTED }}>
          On the go —
        </span>
        <a
          href="https://apps.apple.com/us/app/ugly-bot/id6752114252"
          target="_blank"
          rel="noopener noreferrer"
          style={mobileStoreBtn}
        >
          Ugly Browser for iOS <span style={{ color: BRAND }}>↗</span>
        </a>
        <a
          href="https://play.google.com/store/apps/details?id=bot.ugly.app"
          target="_blank"
          rel="noopener noreferrer"
          style={mobileStoreBtn}
        >
          Ugly Browser for Android <span style={{ color: BRAND }}>↗</span>
        </a>
      </div>

      <div
        style={{
          marginTop: 56,
          fontFamily: FONT_MONO,
          fontSize: 13,
          color: TEXT_MUTED,
          lineHeight: 1.7,
        }}
      >
        After install: open Ugly Studio, sign in to ugly.bot, start a project.
      </div>
    </LayerWrap>
  );
}

const mobileStoreBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 18px',
  fontFamily: FONT_DISPLAY,
  fontSize: 14,
  fontWeight: 600,
  color: TEXT,
  textDecoration: 'none',
  background: BG_ELEV,
  border: `1px solid ${BORDER_STRONG}`,
  borderRadius: 12,
};

function InstallCard({
  platform,
  req,
  fileLabel,
  shell,
  info,
  archToggle,
}: {
  platform: React.ReactNode;
  req: string;
  fileLabel: string;
  shell: string;
  info: PlatformInfo | null;
  archToggle?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        background: BG_ELEV,
        padding: 28,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: '-0.025em',
          color: TEXT,
        }}
      >
        {platform}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: TEXT_FAINT,
          fontWeight: 700,
          lineHeight: 1.7,
        }}
      >
        <span style={{ color: TEXT_MUTED, textTransform: 'none', letterSpacing: 0 }}>
          {req}
        </span>
      </div>
      {archToggle && <div style={{ alignSelf: 'flex-start' }}>{archToggle}</div>}
      <a
        href={info?.url ?? '#'}
        style={{
          ...primaryButtonStyle(!!info),
          alignSelf: 'flex-start',
        }}
        className="ugly-cta"
      >
        Download {fileLabel} →
      </a>
      {info?.deb && (
        <a
          href={info.deb.url}
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.06em',
            color: TEXT_MUTED,
            textDecoration: 'underline',
            alignSelf: 'flex-start',
            marginTop: -8,
          }}
        >
          or .deb (Debian/Ubuntu) →
        </a>
      )}
      <div
        style={{
          border: `1px solid ${BORDER}`,
          padding: '12px 14px',
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: TEXT,
          background: BG,
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: BRAND, marginRight: 8 }}>$</span>
        {shell}
      </div>
      {info && (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: TEXT_FAINT,
            letterSpacing: '0.06em',
            lineHeight: 1.6,
            wordBreak: 'break-all',
          }}
        >
          <span
            style={{
              color: BRAND,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              fontWeight: 700,
              marginRight: 8,
            }}
          >
            Size
          </span>
          {formatSize(info.size)}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// 06 — FROM THE SHOW
// ===========================================================================

function ShowEnd({ isDesktop }: { isDesktop: boolean }) {
  return (
    <LayerWrap num="06" lbl="From the show" isDesktop={isDesktop}>
      <LayerHeading isDesktop={isDesktop}>
        The same three layers,{' '}
        <span style={{ color: BRAND }}>walked through</span>.
      </LayerHeading>
      <LayerPromise>Episode 01 · The Bet · 22 min</LayerPromise>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isDesktop ? '1.5fr 1fr' : '1fr',
          gap: 48,
          alignItems: 'center',
          marginTop: 56,
        }}
      >
        <a
          href="https://www.youtube.com/@ugly.bot_app"
          target="_blank"
          rel="noreferrer"
          style={{
            aspectRatio: '16 / 9',
            background: BG_ELEV,
            border: `1px solid ${BORDER}`,
            position: 'relative',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            textDecoration: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                'repeating-linear-gradient(to bottom, transparent 0, transparent 3px, rgba(255,255,255,0.04) 3px, rgba(255,255,255,0.04) 4px)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              width: 84,
              height: 84,
              border: `1px solid ${BRAND}`,
              background: BRAND_GLOW,
              display: 'grid',
              placeItems: 'center',
              color: BRAND,
              fontSize: 28,
              zIndex: 1,
            }}
          >
            ▶
          </div>
          <div
            style={{
              position: 'absolute',
              bottom: 20,
              left: 20,
              right: 20,
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              fontWeight: 700,
              zIndex: 1,
            }}
          >
            <span style={{ color: BRAND }}>EP 01 · The Bet</span>
            <span style={{ color: TEXT }}>22:08</span>
          </div>
        </a>

        <div>
          <h3
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 40,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              marginBottom: 16,
              color: TEXT,
            }}
          >
            I&apos;m going to beat{' '}
            <span style={{ color: BRAND }}>Claude Code</span> with a
            fifteen-cent model.
          </h3>
          <p
            style={{
              fontFamily: FONT_BODY,
              fontSize: 16,
              color: TEXT_MUTED,
              lineHeight: 1.6,
              marginBottom: 24,
            }}
          >
            This is a bad idea. I can promise you it will be Ugly. The
            same three pillars you just read about — harness, IDE,
            platform — walked through with receipts on screen.
          </p>
          <a
            href="https://www.youtube.com/@ugly.bot_app"
            target="_blank"
            rel="noreferrer"
            className="ugly-cta"
            style={primaryButtonStyle(true)}
          >
            Watch on YouTube →
          </a>
        </div>
      </div>
    </LayerWrap>
  );
}

// ===========================================================================
// FOOTER
// ===========================================================================

function FooterSection() {
  return (
    <div
      style={{
        borderTop: `1px solid ${BORDER}`,
        padding: '64px 24px 48px',
        background: BG,
      }}
    >
      <Shell>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 32,
            flexWrap: 'wrap',
            marginBottom: 32,
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: TEXT_MUTED,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_DISPLAY,
                fontWeight: 800,
                fontSize: 20,
                letterSpacing: '-0.03em',
                color: TEXT,
                marginBottom: 8,
              }}
            >
              ugly<span style={{ color: BRAND }}>.</span>bot
            </div>
            <div
              style={{
                fontSize: 12,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: TEXT_FAINT,
              }}
            >
              One engineer. No investors. No sugarcoating.
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              fontSize: 11,
              fontWeight: 700,
              flexWrap: 'wrap',
            }}
          >
            <FooterLink href="/">← Home</FooterLink>
            <FooterLink href="#harness">Harness</FooterLink>
            <FooterLink href="#ide">IDE</FooterLink>
            <FooterLink href="#platform">Platform</FooterLink>
            <FooterLink href="#install">Install</FooterLink>
            <FooterLink href="/privacy">Privacy</FooterLink>
          </div>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: TEXT_FAINT,
          }}
        >
          © 2026 · ugly.bot
        </div>
      </Shell>
    </div>
  );
}

function FooterLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      className="ugly-link"
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      style={{
        color: TEXT_MUTED,
        textDecoration: 'none',
        transition: 'color 160ms ease',
      }}
    >
      {children}
    </a>
  );
}

// ===========================================================================
// Shared bits
// ===========================================================================

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', width: '100%' }}>
      {children}
    </div>
  );
}

function LayerWrap({
  children,
  id,
  num,
  lbl,
  isDesktop,
}: {
  children: React.ReactNode;
  id?: string;
  num: string;
  lbl: string;
  isDesktop: boolean;
}) {
  return (
    <div
      id={id}
      style={{
        padding: `${isDesktop ? 96 : 56}px 24px`,
        borderTop: `1px solid ${BORDER}`,
        background: BG,
      }}
    >
      <Shell>
        <ScrollAnimatedView animation="slideUp">
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 32,
              marginBottom: 56,
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: isDesktop ? 120 : 64,
                fontWeight: 800,
                letterSpacing: '-0.04em',
                lineHeight: 1,
                color: BRAND,
                opacity: 0.9,
              }}
            >
              {num}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  letterSpacing: '0.26em',
                  textTransform: 'uppercase',
                  color: BRAND,
                  fontWeight: 700,
                  marginBottom: 10,
                }}
              >
                {lbl}
              </div>
              {children}
            </div>
          </div>
        </ScrollAnimatedView>
      </Shell>
    </div>
  );
}

function LayerHeading({
  children,
  isDesktop,
}: {
  children: React.ReactNode;
  isDesktop: boolean;
}) {
  return (
    <h2
      style={{
        fontFamily: FONT_DISPLAY,
        fontWeight: 800,
        fontSize: isDesktop ? 'clamp(40px, 5vw, 64px)' : 36,
        letterSpacing: '-0.04em',
        lineHeight: 0.95,
        maxWidth: 700,
        color: TEXT,
        margin: 0,
      }}
    >
      {children}
    </h2>
  );
}

function LayerPromise({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: 14,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: TEXT_MUTED,
        fontWeight: 600,
        marginTop: 16,
      }}
    >
      {children}
    </div>
  );
}

function primaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 14,
    padding: '18px 28px',
    background: BRAND_GRAD,
    color: ON_BRAND,
    fontFamily: FONT_DISPLAY,
    fontSize: 14,
    fontWeight: 800,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.6,
    border: 'none',
    transition: 'all 160ms ease',
  };
}

function ghostButtonStyle(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    padding: '18px 28px',
    border: `1px solid ${BORDER_STRONG}`,
    background: 'transparent',
    color: TEXT,
    fontFamily: FONT_MONO,
    fontSize: 13,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    fontWeight: 700,
    textDecoration: 'none',
    cursor: 'pointer',
    transition: 'all 160ms ease',
  };
}

function navMetaStyle(): React.CSSProperties {
  return {
    color: TEXT_MUTED,
    borderBottom: '1px solid transparent',
    paddingBottom: 2,
    textDecoration: 'none',
    transition: 'color 160ms ease',
  };
}

// ===========================================================================
// Windows Trust Modal (preserved — warns about SmartScreen on unsigned exe)
// ===========================================================================

function WindowsTrustModal({
  url,
  onClose,
}: {
  url: string | null;
  onClose: () => void;
}) {
  if (!url) return null;
  const proceed = () => {
    window.location.href = url;
    onClose();
  };
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.72)',
          zIndex: 999,
        }}
      />
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            pointerEvents: 'auto',
            maxWidth: 520,
            width: '100%',
            // Opaque elevated surface. Was `var(--app-main)` — an undefined
            // variable on the landing page (the theme exposes --app-background
            // / --app-foreground, not --app-main), so the panel rendered
            // transparent over the dark overlay and the text was unreadable.
            backgroundColor: BG_ELEV,
            color: TEXT,
            padding: 32,
            fontFamily: FONT_MONO,
            fontSize: 14,
            lineHeight: 1.6,
            border: `1px solid ${BORDER_STRONG}`,
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
          }}
        >
          <h2
            style={{
              margin: 0,
              marginBottom: 16,
              fontFamily: FONT_DISPLAY,
              fontSize: 20,
              fontWeight: 800,
              color: TEXT,
              letterSpacing: '-0.02em',
            }}
          >
            Heads-up on the Windows download
          </h2>
          <p style={{ margin: 0, marginBottom: 14 }}>
            Windows will almost certainly block this installer on first
            launch with a &ldquo;Windows protected your PC&rdquo; dialog
            and &ldquo;Unknown publisher&rdquo; warning. The installer is
            safe &mdash; it&rsquo;s the same code behind the Mac download
            &mdash; it&rsquo;s just not code-signed yet.
          </p>
          <p style={{ margin: 0, marginBottom: 14 }}>
            I&rsquo;m sorry about this. Windows code-signing that removes
            the warning costs <strong>~$120/year</strong> (Azure Trusted
            Signing), and Ugly Studio is a solo project right now.
            I&rsquo;m not willing to spend that until there are enough
            real users to justify it. If that changes, the warning goes
            away.
          </p>
          <p
            style={{
              margin: 0,
              marginBottom: 20,
              padding: '12px 14px',
              backgroundColor: BRAND_GLOW,
              border: `1px solid ${BRAND}`,
              fontSize: 13,
              color: TEXT,
            }}
          >
            <strong>To install:</strong> when SmartScreen shows the
            dialog, click <em>More info</em>, then <em>Run anyway</em>.
          </p>
          <div
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={onClose}
              style={{
                border: `1px solid ${BORDER_STRONG}`,
                backgroundColor: 'transparent',
                color: TEXT,
                fontFamily: FONT_MONO,
                fontSize: 12,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                padding: '10px 18px',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={proceed}
              style={{
                border: 'none',
                background: BRAND_GRAD,
                color: ON_BRAND,
                fontFamily: FONT_DISPLAY,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                padding: '10px 18px',
                cursor: 'pointer',
              }}
            >
              Download anyway
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
