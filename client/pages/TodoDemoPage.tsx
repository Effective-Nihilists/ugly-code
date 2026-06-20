import React, { useEffect, useState } from 'react';
import { Button, Card, PageLayout, Text, useApp } from 'ugly-app/client';
import type { Todo } from '../../shared/collections';

// ─── TodoDetail ───────────────────────────────────────────────────────────────
// Demonstrates getDoc: a one-time fetch of a single document by ID.
// Use this when you need to load full details for a specific item on demand,
// without subscribing to ongoing changes (contrast with trackDoc for live updates).
function TodoDetail({ todoId }: { todoId: string }): React.ReactElement {
  const { socket } = useApp();
  const [todo, setTodo] = useState<Todo | null>(null);

  useEffect(() => {
    setTodo(null);
    // getDoc sends a storeGetDoc request to the server and resolves once.
    // Returns null if the document does not exist.
    void socket.getDoc<Todo>('todo', todoId).then(setTodo);
  }, [socket, todoId]);

  if (!todo) {
    return (
      <Card>
        <Text size="sm">Loading…</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text weight="bold">Selected todo — loaded via getDoc</Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        <Text size="sm">id: {todo._id}</Text>
        <Text size="sm">text: {todo.text}</Text>
        <Text size="sm">done: {todo.done ? 'true' : 'false'}</Text>
        <Text size="sm">created: {todo.created instanceof Date ? todo.created.toLocaleString() : new Date(todo.created).toLocaleString()}</Text>
      </div>
    </Card>
  );
}

// ─── TodoDemoPage ─────────────────────────────────────────────────────────────
// Demonstrates the full ugly-app real-time data stack:
//
//   Custom collection  shared/collections.ts  todo collection with trackKeys
//   trackDocs          live list subscription  updates automatically on any change
//   trackKeys          keys: { userId }        scopes NATS channel per user
//   getDoc             TodoDetail component    one-time fetch by ID
//   Custom requests    createTodo / toggleTodo / deleteTodo via socket.request()
export default function TodoDemoPage(): React.ReactElement {
  const { socket, userId } = useApp();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');

  useEffect(() => {
    // trackDocs: subscribe to a live list of documents in a collection.
    // The callback fires immediately with the current snapshot, then fires again
    // whenever any document in the subscription changes (create, update, delete).
    //
    // trackKeys — keys: { userId } scopes this subscription to a NATS channel
    // specific to this user (dbkey.todo.userId.<userId>). Without trackKeys the
    // server would broadcast all todo changes to all connected clients.
    const unsub = socket.trackDocs<Todo>(
      'todo',
      { keys: { userId } },
      (updated) => { setTodos(updated); },
    );
    // Return the unsubscribe function so React cleans up on unmount.
    return unsub;
  }, [socket, userId]);

  async function handleCreate(): Promise<void> {
    const text = inputText.trim();
    if (!text) return;
    // Custom server request: createTodo is an authReq defined in shared/api.ts
    // and implemented in server/index.ts. The server writes to MongoDB and
    // publishes a NATS change event — trackDocs fires automatically with the new list.
    await socket.request('createTodo', { text });
    setInputText('');
  }

  async function handleToggle(todoId: string): Promise<void> {
    // Custom server request: toggleTodo flips the done flag server-side.
    // The live list re-fires via trackDocs as soon as the change is published.
    await socket.request('toggleTodo', { todoId });
  }

  async function handleDelete(todoId: string): Promise<void> {
    if (selectedId === todoId) setSelectedId(null);
    // Custom server request: deleteTodo removes the document and publishes a
    // NATS delete event. trackDocs fires again with the document removed from the list.
    await socket.request('deleteTodo', { todoId });
  }

  return (
    <PageLayout
      header={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text weight="bold">Todo Demo</Text>
          <a href="/test" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">← Tests</Button>
          </a>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Description */}
        <Card>
          <Text size="xl" weight="bold">Dynamic Todo List</Text>
          <Text size="sm" style={{ marginTop: 4 }}>
            Demonstrates: custom collection · trackDocs · trackKeys · getDoc · custom server requests
          </Text>
        </Card>

        {/* Add a todo — custom server request */}
        <Card>
          <Text weight="medium">Add a todo</Text>
          <Text size="sm" style={{ marginBottom: 8 }}>
            Calls <strong>socket.request('createTodo', {'{ text }'})</strong> — a custom authReq
          </Text>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={inputText}
              onChange={(e) => { setInputText(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
              placeholder="What needs to be done?"
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid #ccc',
                fontSize: 14,
              }}
            />
            <Button
              onClick={() => void handleCreate()}
              disabled={!inputText.trim()}
            >
              Add
            </Button>
          </div>
        </Card>

        {/* Live list — trackDocs + trackKeys */}
        <Card>
          <Text weight="medium">
            Todos ({todos.length}) — live via trackDocs + trackKeys
          </Text>
          <Text size="sm" style={{ marginBottom: 12 }}>
            <strong>trackDocs</strong> subscribes to real-time changes.{' '}
            <strong>trackKeys {'{ userId }'}</strong> scopes the NATS channel per user.
            Open a second tab — changes appear in both instantly.
          </Text>

          {todos.length === 0 && (
            <Text size="sm">No todos yet — add one above.</Text>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {todos.map((todo) => (
              <div
                key={todo._id}
                onClick={() => { setSelectedId(selectedId === todo._id ? null : todo._id); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: selectedId === todo._id ? 'rgba(0,0,0,0.05)' : 'transparent',
                  opacity: todo.done ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => { void handleToggle(todo._id); }}
                  onClick={(e) => { e.stopPropagation(); }}
                  style={{ cursor: 'pointer', flexShrink: 0 }}
                />
                <span
                  style={{
                    flex: 1,
                    fontSize: 14,
                    textDecoration: todo.done ? 'line-through' : 'none',
                  }}
                >
                  {todo.text}
                </span>
                <Button
                  size="sm"
                  variant="error"
                  onClick={(e?: React.MouseEvent) => {
                    e?.stopPropagation();
                    void handleDelete(todo._id);
                  }}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
        </Card>

        {/* Detail panel — getDoc */}
        {selectedId && (
          <div>
            <Text size="sm" style={{ marginBottom: 8 }}>
              <strong>getDoc</strong> — click a todo row to fetch its full document by ID:
            </Text>
            <TodoDetail todoId={selectedId} />
          </div>
        )}

      </div>
    </PageLayout>
  );
}
