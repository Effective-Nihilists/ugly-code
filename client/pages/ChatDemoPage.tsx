import React, { useCallback, useState } from 'react';
import { Button, Card, PageLayout, Text } from 'ugly-app/client';
import {
  ChatView,
  ChatTextInput,
  ChatTextContent,
  ChatMarkdownInput,
  ChatMarkdownContent,
} from 'ugly-app/conversation/client';
import type { ChatMessage, ChatUser } from 'ugly-app/conversation/shared';

// ─── Mock data ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = 'user-alice';

const MOCK_USERS: Record<string, ChatUser> = {
  'user-alice': { id: 'user-alice', name: 'Alice' },
  'user-bob': { id: 'user-bob', name: 'Bob' },
  'bot-helper': { id: 'bot-helper', name: 'Helper Bot', isBot: true },
};

let nextId = 100;
function makeId(): string {
  return `msg-${++nextId}`;
}

const now = Date.now();

function makeSeedMessages(): ChatMessage[] {
  return [
    {
      id: 'msg-1',
      conversationId: 'conv-demo',
      userId: 'user-bob',
      text: 'Hey Alice, have you seen the new chat components?',
      created: now - 600_000,
      updated: now - 600_000,
    },
    {
      id: 'msg-2',
      conversationId: 'conv-demo',
      userId: MOCK_USER_ID,
      text: 'Not yet! What do they look like?',
      created: now - 540_000,
      updated: now - 540_000,
    },
    {
      id: 'msg-3',
      conversationId: 'conv-demo',
      userId: 'user-bob',
      markdown:
        'They support **bold**, *italic*, `inline code`, and even code blocks:\n\n```ts\nconst greeting = "Hello, world!";\nconsole.log(greeting);\n```\n\nPlus [links](https://example.com) work too.',
      text: 'They support bold, italic, inline code, and even code blocks.',
      created: now - 480_000,
      updated: now - 480_000,
    },
    {
      id: 'msg-4',
      conversationId: 'conv-demo',
      userId: MOCK_USER_ID,
      markdown: 'That looks great! Let me try a list:\n\n- Item one\n- Item two\n- **Item three** with emphasis',
      text: 'That looks great! Let me try a list.',
      created: now - 420_000,
      updated: now - 420_000,
    },
    {
      id: 'msg-5',
      conversationId: 'conv-demo',
      userId: 'bot-helper',
      markdown:
        'Here is a quick summary:\n\n| Feature | Status |\n|---------|--------|\n| Bold / Italic | Supported |\n| Code blocks | Supported |\n| Links | Supported |\n| Tables | Supported |\n\n> Tip: Switch between **basic** and **markdown** mode using the toggle above.',
      text: 'Here is a quick summary of supported features.',
      created: now - 360_000,
      updated: now - 360_000,
      reactionCount: { thumbsUp: 2, heart: 1 },
      reactionUsers: {
        thumbsUp: [MOCK_USER_ID, 'user-bob'],
        heart: [MOCK_USER_ID],
      },
    },
    {
      id: 'msg-6',
      conversationId: 'conv-demo',
      userId: 'user-bob',
      text: 'Nice work on the reactions too!',
      created: now - 300_000,
      updated: now - 300_000,
      reactionCount: { tearsOfJoy: 1 },
      reactionUsers: { tearsOfJoy: [MOCK_USER_ID] },
    },
  ];
}

// ─── ChatDemoPage ──────────────────────────────────────────────────────────

export default function ChatDemoPage(): React.ReactElement {
  const [mode, setMode] = useState<'markdown' | 'basic'>('markdown');
  const [messages, setMessages] = useState<ChatMessage[]>(makeSeedMessages);

  const getUser = useCallback((userId: string): ChatUser | null => {
    return MOCK_USERS[userId] ?? null;
  }, []);

  const handleSend = useCallback((text: string) => {
    const msg: ChatMessage = {
      id: makeId(),
      conversationId: 'conv-demo',
      userId: MOCK_USER_ID,
      text,
      created: Date.now(),
      updated: Date.now(),
      ...(mode === 'markdown' ? { markdown: text } : {}),
    };
    setMessages((prev) => [...prev, msg]);

    // Simulate a bot reply after a short delay
    setTimeout(() => {
      const reply: ChatMessage = {
        id: makeId(),
        conversationId: 'conv-demo',
        userId: 'bot-helper',
        text: `Got it! You said: "${text.slice(0, 80)}"`,
        created: Date.now(),
        updated: Date.now(),
        ...(mode === 'markdown'
          ? { markdown: `Got it! You said:\n\n> ${text.slice(0, 120)}` }
          : {}),
      };
      setMessages((prev) => [...prev, reply]);
    }, 800);
  }, [mode]);

  const handleDelete = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  return (
    <PageLayout
      header={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text weight="bold">Chat Demo</Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text size="sm" style={{ opacity: 0.6 }}>Mode:</Text>
            <Button
              size="sm"
              variant={mode === 'basic' ? 'primary' : 'secondary'}
              onClick={() => { setMode('basic'); }}
            >
              Basic Text
            </Button>
            <Button
              size="sm"
              variant={mode === 'markdown' ? 'primary' : 'secondary'}
              onClick={() => { setMode('markdown'); }}
            >
              Full Markdown
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>

        {/* Description card */}
        <Card>
          <Text size="xl" weight="bold">
            {mode === 'markdown' ? 'Markdown Chat' : 'Basic Text Chat'}
          </Text>
          <Text size="sm" style={{ marginTop: 4 }}>
            {mode === 'markdown'
              ? 'Using ChatView + ChatMarkdownInput + ChatMarkdownContent. Supports bold, italic, code, links, tables, and more.'
              : 'Using ChatView + ChatTextInput + ChatTextContent. Plain text only, no formatting.'}
          </Text>
          <Text size="sm" style={{ marginTop: 4, opacity: 0.6 }}>
            Demonstrates: mock messages, reactions, bot replies, send/delete, mode toggle
          </Text>
        </Card>

        {/* Chat area */}
        <div
          style={{
            flex: 1,
            minHeight: 400,
            border: '1px solid var(--app-border, #ddd)',
            borderRadius: 12,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {mode === 'basic' ? (
            <ChatView
              messages={messages}
              userId={MOCK_USER_ID}
              onSend={handleSend}
              onDelete={handleDelete}
              getUser={getUser}
              renderContent={(msg) => (
                <ChatTextContent text={msg.text ?? ''} />
              )}
            >
              <ChatTextInput placeholder="Type a message..." autoFocus />
            </ChatView>
          ) : (
            <ChatView
              messages={messages}
              userId={MOCK_USER_ID}
              onSend={handleSend}
              onDelete={handleDelete}
              getUser={getUser}
              renderContent={(msg, width) => (
                <ChatMarkdownContent
                  markdown={msg.markdown ?? msg.text ?? ''}
                  width={width}
                />
              )}
            >
              <ChatMarkdownInput placeholder="Type markdown..." autoFocus />
            </ChatView>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
