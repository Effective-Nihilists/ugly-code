import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  PageLayout,
  Text,
  useSafeAreaInsets,
} from 'ugly-app/client';

export default function SafeAreaTestPage() {
  const insets = useSafeAreaInsets();
  // The keyboard is part of the safe-area object (`bottom` already accounts for
  // it); `keyboard.height`/`keyboard.showing` expose the raw state.
  const kbHeight = insets.keyboard.height;
  const isKbOpen = insets.keyboard.showing;
  const [debug, setDebug] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('debugSafeArea'),
  );
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).__debugSafeArea = debug;
  }, [debug]);

  const toggleDebug = () => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (debug) {
      params.delete('debugSafeArea');
    } else {
      params.set('debugSafeArea', 'true');
    }
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
    );
    setDebug(!debug);
    window.location.reload();
  };

  return (
    <PageLayout>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Text size="xl" weight="bold">Safe Area Test</Text>

        <div
          data-id="sa-values"
          style={{
            padding: 12,
            background: 'var(--app-main, #fff)',
            border: '1px solid var(--app-border, #e5e7eb)',
            borderRadius: 8,
            fontFamily: 'monospace',
            fontSize: 13,
          }}
        >
          <div>safe-area.top: <span data-id="sa-top">{insets.top}</span></div>
          <div>safe-area.right: <span data-id="sa-right">{insets.right}</span></div>
          <div>safe-area.bottom: <span data-id="sa-bottom">{insets.bottom}</span></div>
          <div>safe-area.left: <span data-id="sa-left">{insets.left}</span></div>
          <div>keyboard-height: <span data-id="kb-height">{kbHeight}</span></div>
          <div>keyboard-open: <span data-id="kb-open">{isKbOpen ? 'true' : 'false'}</span></div>
        </div>

        <Button data-id="toggle-debug-overlay" onClick={toggleDebug}>
          {debug ? 'Disable' : 'Enable'} debug overlay
        </Button>

        <Text size="sm">
          Scroll down and focus the input at the bottom to verify the keyboard
          spacer keeps it visible.
        </Text>

        {Array.from({ length: 40 }).map((_, i) => (
          <div
            key={i}
            style={{
              padding: 12,
              background: i % 2 === 0 ? 'rgba(0,0,0,0.03)' : 'transparent',
              borderRadius: 4,
            }}
          >
            <Text size="sm">Filler row {i + 1}</Text>
          </div>
        ))}

        <Input
          data-id="sa-input"
          value={inputValue}
          onChange={setInputValue}
          placeholder="Focus me to open the keyboard"
        />
      </div>
    </PageLayout>
  );
}
