import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, PageLayout, Text, useApp } from 'ugly-app/client';

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function VideoRoomTestPage(): React.ReactElement {
  const { socket } = useApp();
  const [roomId, setRoomId] = useState('test-room-1');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    const prefix = '[VideoRoomTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  // Listen for room events
  useEffect(() => {
    const handler = (raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as { type: string; data: Record<string, unknown> };
      const { type, data } = msg;

      if (type === 'vr:peer-joined') {
        addLog(`Peer joined: ${data.peerId as string}`, 'ok');
      } else if (type === 'vr:peer-left') {
        addLog(`Peer left: ${data.peerId as string}`);
      } else if (type === 'vr:new-producer') {
        addLog(`New producer: ${data.kind as string} from ${data.peerId as string}`, 'ok');
      } else if (type === 'vr:room-closed') {
        addLog('Room closed');
        setJoined(false);
      }
    };

    const unsub = socket.on('message', handler);
    return () => { unsub(); };
  }, [socket]);

  async function handleGetMedia(): Promise<MediaStream> {
    addLog('Requesting camera & microphone…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: true,
    });
    setLocalStream(stream);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    addLog(`Got media: ${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio`, 'ok');
    return stream;
  }

  async function handleJoin(): Promise<void> {
    if (!roomId.trim()) return;
    setLoading(true);
    const started = Date.now();
    setLogs([]);
    addLog(`Joining room: ${roomId}`);

    try {
      const stream = await handleGetMedia();

      // Request to join the video room via WebSocket
      const _result = await socket.send('vr:join', { roomId }) as { routerRtpCapabilities: unknown };
      addLog(`Joined room in ${fmt(Date.now() - started)}`, 'ok');
      addLog(`Router RTP capabilities received`);

      // In a full implementation you would:
      // 1. Load the mediasoup-client Device with routerRtpCapabilities
      // 2. Create send/recv transports via vr:create-transport
      // 3. Produce local tracks via vr:produce
      // 4. Consume remote tracks via vr:consume
      addLog('Note: Full WebRTC negotiation requires mediasoup-client (see docs)');

      setJoined(true);
      void stream; // used above
    } catch (err) {
      addLog(`Join failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setLoading(false);
    }
  }

  async function handleLeave(): Promise<void> {
    addLog('Leaving room…');
    try {
      await socket.send('vr:leave', { roomId });
      addLog('Left room', 'ok');
    } catch (err) {
      addLog(`Leave failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }

    // Stop local media
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      setLocalStream(null);
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setJoined(false);
  }

  function toggleAudio(): void {
    if (!localStream) return;
    const enabled = !audioEnabled;
    for (const track of localStream.getAudioTracks()) track.enabled = enabled;
    setAudioEnabled(enabled);
    addLog(`Audio ${enabled ? 'unmuted' : 'muted'}`);
  }

  function toggleVideo(): void {
    if (!localStream) return;
    const enabled = !videoEnabled;
    for (const track of localStream.getVideoTracks()) track.enabled = enabled;
    setVideoEnabled(enabled);
    addLog(`Video ${enabled ? 'enabled' : 'disabled'}`);
  }

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>Video Room Test</h1>

        {/* Room controls */}
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Input
                label="Room ID"
                value={roomId}
                onChange={setRoomId}
                placeholder="test-room-1"
              />
            </div>
            {!joined ? (
              <Button data-id="vr-join" onClick={() => { void handleJoin(); }} disabled={loading || !roomId.trim()}>
                {loading ? 'Joining…' : 'Join Room'}
              </Button>
            ) : (
              <Button data-id="vr-leave" onClick={() => { void handleLeave(); }}>
                Leave Room
              </Button>
            )}
          </div>
        </Card>

        {/* Video feeds */}
        <div style={{ display: 'flex', gap: 8 }}>
          <Card>
            <Text size="sm" weight="bold">Local</Text>
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                maxWidth: 320,
                height: 240,
                borderRadius: 8,
                background: '#000',
                objectFit: 'cover',
              }}
            />
            {joined && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button data-id="vr-toggle-audio" onClick={toggleAudio}>
                  {audioEnabled ? 'Mute' : 'Unmute'}
                </Button>
                <Button data-id="vr-toggle-video" onClick={toggleVideo}>
                  {videoEnabled ? 'Hide Video' : 'Show Video'}
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <Text size="sm" weight="bold">Remote</Text>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              style={{
                width: '100%',
                maxWidth: 320,
                height: 240,
                borderRadius: 8,
                background: '#000',
                objectFit: 'cover',
              }}
            />
            {!joined && (
              <Text size="sm" style={{ opacity: 0.4, marginTop: 8 }}>
                Join a room to see remote participants
              </Text>
            )}
          </Card>
        </div>

        {/* How it works */}
        <Card>
          <h2>How it works</h2>
          <ol>
            <li>Server uses <code>VideoRoomServer</code> with mediasoup SFU for WebRTC</li>
            <li><code>vr:join</code> creates/joins a room and returns router RTP capabilities</li>
            <li><code>vr:create-transport</code> sets up send/receive WebRTC transports</li>
            <li><code>vr:produce</code> publishes local audio/video tracks</li>
            <li><code>vr:consume</code> subscribes to remote peers&apos; tracks</li>
            <li>Supports VP8, VP9, H264 video and Opus audio codecs</li>
            <li>Server-side: use <code>enableVideoRooms(configurator, config)</code> in your server setup</li>
          </ol>
        </Card>

        {/* Log panel */}
        {logs.length > 0 && (
          <div style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
            {logs.map((entry, i) => (
              <div key={i}>
                {entry.kind === 'err' ? '✗' : entry.kind === 'ok' ? '✓' : '·'}{' '}
                {entry.msg}
              </div>
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
