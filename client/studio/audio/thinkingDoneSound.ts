/**
 * One-shot notification chime fired when a session transitions to
 * "thinking-done" while the user isn't actively viewing it. Triggered
 * from `ProjectsContext` on every `project:aggregate-changed` push
 * whose `thinkingDone` flag flipped false → true.
 *
 * Lazy + idempotent — the audio element is created on first call and
 * reused thereafter so we don't burn an HTMLAudioElement per finish.
 * A 1500ms cooldown coalesces bursts (e.g. max-mode where several peer
 * sessions finish within a few hundred ms of each other) into one
 * chime; otherwise the rapid-fire would sound like a stutter.
 *
 * `play()` rejections are swallowed: in Electron renderers the
 * autoplay policy can block until first user gesture, after which
 * subsequent calls succeed silently. There's no need to surface the
 * error — the visual tab-dot indicator is the load-bearing signal,
 * the sound is just an extra peripheral cue.
 */
const SOUND_URL = '/sounds/thinking-done.wav';
const COOLDOWN_MS = 1500;

let audio: HTMLAudioElement | null = null;
let lastPlayedAt = 0;

export function playThinkingDoneSound(): void {
  const now = Date.now();
  if (now - lastPlayedAt < COOLDOWN_MS) return;
  lastPlayedAt = now;
  if (!audio) {
    audio = new Audio(SOUND_URL);
    audio.preload = 'auto';
  }
  // Rewind to start so a second play within the cooldown window
  // (after the cooldown elapses) doesn't get truncated by lingering
  // playback position.
  audio.currentTime = 0;
  audio.play().catch(() => {
    /* autoplay policy blocked the first call before any user gesture;
       harmless — the visual dot is the primary signal */
  });
}
