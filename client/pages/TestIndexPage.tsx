import React from 'react';
import { Card, PageLayout, Text } from 'ugly-app/client';

const testPages = [
  { path: '/test/ui', label: 'UI Components', description: 'Live demos of all built-in components' },
  { path: '/test/ai', label: 'AI Generation', description: 'Text and image generation test', auth: true },
  { path: '/test/audio', label: 'Audio (TTS / STT)', description: 'Text-to-speech and speech-to-text', auth: true },
  { path: '/test/search', label: 'Web Search', description: 'Search, summarize, and enrich via Kagi', auth: true },
  { path: '/test/todo', label: 'Todo CRUD', description: 'Create, toggle, delete todos', auth: true },
  { path: '/test/upload', label: 'File Upload', description: 'Upload files to storage', auth: true },
  { path: '/test/email', label: 'Email', description: 'Send test emails', auth: true },
  { path: '/test/push', label: 'Push Notifications', description: 'Register and send push notifications', auth: true },
  { path: '/test/scroll', label: 'Scroll Behavior', description: 'ScrollView, FlatList, and scroll utilities' },
  { path: '/test/chat', label: 'Chat / Conversations', description: 'Real-time messaging with AI streaming', auth: true },
  { path: '/test/three', label: '3D / Avatar', description: 'Three.js scenes and camera controller' },
  { path: '/test/video-room', label: 'Video Room', description: 'WebRTC video conferencing via mediasoup', auth: true },
  { path: '/test/collab', label: 'Real-time Collab', description: 'Collaborative editing with Yjs CRDTs', auth: true },
  { path: '/test/errors', label: 'Error Testing', description: 'Trigger client and server errors for testing', auth: true },
  { path: '/test/worker', label: 'Worker Tasks', description: 'Test throw exception, DB mutation, and console.error', auth: true },
  { path: '/test/strings', label: 'Localization', description: 'Language switching and translated strings' },
  { path: '/test/safe-area', label: 'Safe Area & Keyboard', description: 'Device insets, keyboard height, and keyboard-aware layout' },
];

export default function TestIndexPage(): React.ReactElement {
  return (
    <PageLayout
      header={
        <div>
          <a href="/">← Home</a>
        </div>
      }
    >
      <div>
        <h1>Test Pages</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {testPages.map((page) => (
            <a
              key={page.path}
              href={page.path}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <Text weight="bold">{page.label}</Text>
                    <Text size="sm" style={{ opacity: 0.6 }}>{page.description}</Text>
                  </div>
                  {page.auth && (
                    <Text size="xs" style={{ opacity: 0.4 }}>requires auth</Text>
                  )}
                </div>
              </Card>
            </a>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}
