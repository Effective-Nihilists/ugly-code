import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, PageLayout, Text } from 'ugly-app/client';
import * as THREE from 'three';
import { DynamicCameraController } from 'ugly-app/three/client';

type DemoScene = 'cube' | 'avatar-placeholder' | 'postprocessing';

interface LogEntry {
  ts: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function createCubeScene(scene: THREE.Scene): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x4f8fff, roughness: 0.4, metalness: 0.3 });
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);

  const light = new THREE.DirectionalLight(0xffffff, 1.5);
  light.position.set(3, 4, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
  grid.position.y = -0.5;
  scene.add(grid);

  return cube;
}

function createAvatarPlaceholder(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();

  // Head
  const headGeo = new THREE.SphereGeometry(0.25, 16, 16);
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xf0c8a0, roughness: 0.6 });
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = 1.6;
  head.name = 'Head';
  group.add(head);

  // Body
  const bodyGeo = new THREE.CapsuleGeometry(0.2, 0.6, 8, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4488cc, roughness: 0.5 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 1.0;
  body.name = 'Hips';
  group.add(body);

  // Arms
  const armGeo = new THREE.CapsuleGeometry(0.08, 0.5, 4, 8);
  const leftArm = new THREE.Mesh(armGeo, bodyMat);
  leftArm.position.set(-0.35, 1.05, 0);
  leftArm.rotation.z = 0.2;
  group.add(leftArm);

  const rightArm = new THREE.Mesh(armGeo, bodyMat);
  rightArm.position.set(0.35, 1.05, 0);
  rightArm.rotation.z = -0.2;
  group.add(rightArm);

  // Legs
  const legGeo = new THREE.CapsuleGeometry(0.1, 0.5, 4, 8);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.5 });
  const leftLeg = new THREE.Mesh(legGeo, legMat);
  leftLeg.position.set(-0.15, 0.35, 0);
  group.add(leftLeg);

  const rightLeg = new THREE.Mesh(legGeo, legMat);
  rightLeg.position.set(0.15, 0.35, 0);
  group.add(rightLeg);

  // Floor
  const floorGeo = new THREE.CircleGeometry(2, 32);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Lighting
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
  keyLight.position.set(2, 4, 3);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8888ff, 0.5);
  fillLight.position.set(-2, 2, -1);
  scene.add(fillLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  scene.add(group);
  return group;
}

export default function ThreeTestPage(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeScene, setActiveScene] = useState<DemoScene>('cube');
  const [fps, setFps] = useState(0);
  const [cameraMode, setCameraMode] = useState<'orbit' | 'cinematic'>('orbit');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  function addLog(msg: string, kind: LogEntry['kind'] = 'info'): void {
    const prefix = '[ThreeTest]';
    if (kind === 'err') console.error(prefix, msg);
    else console.log(prefix, msg);
    setLogs((prev) => [...prev, { ts: Date.now(), msg, kind }]);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Cleanup previous scene
    if (cleanupRef.current) cleanupRef.current();

    const started = Date.now();
    addLog(`Initializing scene: ${activeScene}`);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setClearColor(0x111111, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    camera.position.set(0, 1.5, 3);
    camera.lookAt(0, 0.8, 0);

    let animatable: THREE.Object3D | null = null;
    let cameraController: DynamicCameraController | null = null;

    if (activeScene === 'cube') {
      animatable = createCubeScene(scene);
      camera.position.set(2, 2, 3);
      camera.lookAt(0, 0, 0);
    } else if (activeScene === 'avatar-placeholder') {
      const avatar = createAvatarPlaceholder(scene);
      animatable = avatar;

      if (cameraMode === 'cinematic') {
        try {
          cameraController = new DynamicCameraController(camera);
          cameraController.addAvatar('placeholder', avatar, { x: 0, y: 0, z: 0 });
          addLog('DynamicCameraController attached', 'ok');
        } catch (err) {
          addLog(`CameraController error: ${err instanceof Error ? err.message : String(err)}`, 'err');
        }
      }
    } else {
      // activeScene === 'postprocessing'
      animatable = createCubeScene(scene);
      camera.position.set(2, 2, 3);
      camera.lookAt(0, 0, 0);
      addLog('Post-processing effects are server-side only (HeadlessEnvironment)');
    }

    addLog(`Scene ready in ${fmt(Date.now() - started)}`, 'ok');

    // Animation loop
    let frameCount = 0;
    let lastFpsUpdate = performance.now();
    let animFrameId: number;

    function animate(): void {
      animFrameId = requestAnimationFrame(animate);
      const time = performance.now() * 0.001;

      if (animatable) {
        if (activeScene === 'cube') {
          animatable.rotation.x = time * 0.5;
          animatable.rotation.y = time * 0.7;
        } else if (activeScene === 'avatar-placeholder') {
          // Gentle idle sway
          animatable.rotation.y = Math.sin(time * 0.5) * 0.1;
          const head = animatable.getObjectByName('Head');
          if (head) {
            head.rotation.x = Math.sin(time * 0.8) * 0.05;
            head.rotation.y = Math.sin(time * 0.3) * 0.1;
          }
        }
      }

      if (cameraController) {
        cameraController.update(1 / 60);
      }

      renderer.render(scene, camera);

      // FPS counter
      frameCount++;
      const now = performance.now();
      if (now - lastFpsUpdate >= 1000) {
        setFps(Math.round(frameCount * 1000 / (now - lastFpsUpdate)));
        frameCount = 0;
        lastFpsUpdate = now;
      }
    }

    animate();

    // Resize handler
    function onResize(): void {
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', onResize);

    cleanupRef.current = () => {
      cancelAnimationFrame(animFrameId);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      scene.clear();
      if (cameraController) cameraController.disable();
    };

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [activeScene, cameraMode]);

  const scenes: { key: DemoScene; label: string }[] = [
    { key: 'cube', label: 'Rotating Cube' },
    { key: 'avatar-placeholder', label: 'Avatar Placeholder' },
    { key: 'postprocessing', label: 'Post-Processing Info' },
  ];

  return (
    <PageLayout
      header={
        <div>
          <a href="/test">← Tests</a>
        </div>
      }
    >
      <div>
        <h1>3D / Avatar Test</h1>

        {/* Scene selector */}
        <Card>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {scenes.map((s) => (
              <Button
                key={s.key}
                data-id={`three-scene-${s.key}`}
                onClick={() => { setActiveScene(s.key); setLogs([]); }}
                disabled={activeScene === s.key}
              >
                {s.label}
              </Button>
            ))}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {activeScene === 'avatar-placeholder' && (
                <Button
                  data-id="three-camera-mode"
                  onClick={() => { setCameraMode((m) => m === 'orbit' ? 'cinematic' : 'orbit'); }}
                >
                  Camera: {cameraMode}
                </Button>
              )}
              <Text size="sm" style={{ opacity: 0.5 }}>{fps} FPS</Text>
            </div>
          </div>
        </Card>

        {/* Canvas */}
        <Card>
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: 400,
              display: 'block',
              borderRadius: 8,
              background: '#111',
            }}
          />
        </Card>

        {/* How it works */}
        <Card>
          <h2>How it works</h2>
          <ol>
            <li><strong>Client-side:</strong> Import <code>DynamicCameraController</code> and <code>PostProcessingManager</code> from <code>ugly-app/three/client</code></li>
            <li><strong>Server-side:</strong> <code>HeadlessEnvironment</code> provides JSDOM + WebGL for server-rendered 3D</li>
            <li><strong>Video export:</strong> <code>VideoEncoder</code> converts rendered frames to H.264/MP4 via FFmpeg</li>
            <li><strong>Camera:</strong> <code>DynamicCameraController</code> auto-cycles cinematic shots tracking avatar bones</li>
            <li><strong>Post-processing:</strong> Bloom, vignette, chromatic aberration, scan lines via <code>PostProcessingManager</code></li>
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
