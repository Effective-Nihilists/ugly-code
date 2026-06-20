import { useEffect, useState } from 'react';
import { Input, PageLayout, Text } from 'ugly-app/client';
import { useRouter } from '../router';

/**
 * Test fixture for `window.__uglyInspect()` / `ugly-app/playwright`.
 * Each `?simulate=` value renders a known-bad layout so the inspect
 * helper can assert "yes the report caught it".
 *
 * Used by:
 *   - templates/tests/e2e/inspect.spec.ts (Tier 2 in the studio spec)
 *   - the studio integration test in app/studio/tests/inspect-ux-end-to-end.test.ts (Tier 3)
 */
export default function InspectFixturePage() {
  const router = useRouter();
  const params =
    typeof window === 'undefined'
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const simulate = params.get('simulate') ?? '';
  const [delayedMounted, setDelayedMounted] = useState(false);

  useEffect(() => {
    if (simulate === 'cls') {
      const t = setTimeout(() => {
        setDelayedMounted(true);
      }, 400);
      return () => {
        clearTimeout(t);
      };
    }
    return undefined;
  }, [simulate]);

  return (
    <PageLayout>
      <div
        style={{
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <Text size="xl" weight="bold">
          Inspect Fixture · simulate={simulate || 'none'}
        </Text>

        {/* Default content — always rendered so [data-id] selector fires */}
        <button
          data-id="nav-to-other"
          onClick={() => {
            router.push('test/inspect-fixture-other', {});
          }}
        >
          Navigate to other page
        </button>

        <button
          data-id="nav-to-cls-page"
          onClick={() => {
            router.push('test/inspect-fixture', { simulate: 'cls' });
          }}
        >
          Navigate (re-load) with CLS sim
        </button>

        {simulate === 'cls' && (
          <>
            {/* Forces a layout shift when the delayed block mounts and
                shoves siblings down by ~240px. */}
            {delayedMounted && (
              <div
                data-id="delayed-banner"
                style={{
                  height: 240,
                  background: 'crimson',
                  color: 'white',
                  padding: 16,
                }}
              >
                Delayed mount — pushes content down
              </div>
            )}
            <div data-id="below-the-shift" style={{ padding: 24 }}>
              This block moves when the delayed banner mounts.
            </div>
          </>
        )}

        {simulate === 'overlap' && (
          <div style={{ position: 'relative', height: 200 }}>
            <button
              data-id="overlap-a"
              style={{
                position: 'absolute',
                left: 40,
                top: 40,
                width: 160,
                height: 60,
              }}
            >
              Button A
            </button>
            <button
              data-id="overlap-b"
              style={{
                position: 'absolute',
                left: 120,
                top: 60,
                width: 160,
                height: 60,
              }}
            >
              Button B
            </button>
          </div>
        )}

        {simulate === 'safearea' && (
          <button
            data-id="fab"
            style={{
              position: 'fixed',
              left: 16,
              right: 16,
              bottom: 0,
              height: 56,
              background: '#0a84ff',
              color: 'white',
              border: 0,
            }}
          >
            Floating action button (no bottom safe-area padding)
          </button>
        )}

        {simulate === 'keyboard' && (
          <div style={{ paddingTop: 600 }}>
            <Input
              data-id="fixture-input"
              value=""
              onChange={() => {
                /* no-op for fixture */
              }}
              placeholder="Focus me to test keyboard coverage"
            />
          </div>
        )}

        {simulate === 'jank' && <JankSim />}

        {simulate === 'popup' && <PopupSim />}
      </div>
    </PageLayout>
  );
}

function JankSim() {
  const [running, setRunning] = useState(false);
  return (
    <>
      <button
        data-id="start-jank"
        onClick={() => {
          setRunning(true);
          // Spawn a long task during the animation.
          const start = performance.now();
          while (performance.now() - start < 250) {
            // Busy-loop — guaranteed long task.
          }
          setTimeout(() => {
            setRunning(false);
          }, 1000);
        }}
      >
        Start janky animation
      </button>
      {running && (
        <div
          data-id="janky-animation"
          style={{
            width: 100,
            height: 100,
            background: 'orange',
            animation: 'spin 800ms linear',
          }}
        />
      )}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

function PopupSim() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        data-id="open-modal"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open modal
      </button>
      {open && (
        <div
          role="dialog"
          data-id="modal-content"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
            animation: 'fade-in 300ms ease',
          }}
        >
          <div style={{ background: 'white', padding: 24, borderRadius: 8 }}>
            <Text>Modal body</Text>
            <button
              data-id="close-modal"
              onClick={() => {
                setOpen(false);
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </>
  );
}
