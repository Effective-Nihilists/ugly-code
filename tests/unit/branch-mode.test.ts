import { describe, expect, it } from 'vitest';
import {
  CodingSessionSchema,
  CodingSessionMessageSchema,
  codingCollections,
} from '../../shared/codingCollections';
import { requests } from '../../shared/api';

describe('CodingSessionSchema — branch field', () => {
  it('accepts a session without branch (backward compat)', () => {
    const result = CodingSessionSchema.safeParse({
      sessionId: 'cs:abc123',
      projectId: 'proj-1',
      userId: 'user-1',
      title: 'Fix login',
      model: 'claude-sonnet-4-20250514',
      status: 'idle',
      messageCount: 5,
      costUsd: 0.02,
      archived: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a session with a worktree branch', () => {
    const result = CodingSessionSchema.safeParse({
      sessionId: 'cs:abc123',
      projectId: 'proj-1',
      userId: 'user-1',
      title: 'Fix login',
      model: 'claude-sonnet-4-20250514',
      status: 'idle',
      messageCount: 5,
      costUsd: 0.02,
      archived: false,
      branch: 'ugly-studio/session/cs_abc123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a session with branch=main', () => {
    const result = CodingSessionSchema.safeParse({
      sessionId: 'cs:abc123',
      projectId: 'proj-1',
      userId: 'user-1',
      title: 'Main-branch session',
      model: 'auto',
      status: 'idle',
      messageCount: 0,
      costUsd: 0,
      archived: false,
      branch: 'main',
    });
    expect(result.success).toBe(true);
  });

  it('branch field is optional in the schema', () => {
    const branchField = CodingSessionSchema.shape.branch;
    expect(branchField).toBeDefined();
    expect(branchField!.safeParse(undefined).success).toBe(true);
    expect(branchField!.safeParse('main').success).toBe(true);
    expect(branchField!.safeParse('ugly-studio/session/test').success).toBe(
      true,
    );
  });

  it('codingCollections defines codingSession and codingSessionMessage', () => {
    const cs = codingCollections.codingSession;
    expect(cs.schema).toBe(CodingSessionSchema);
    expect(cs.indexes).toHaveLength(1);

    const csm = codingCollections.codingSessionMessage;
    expect(csm.schema).toBeDefined();
    expect(csm.indexes).toHaveLength(2);
  });
});

describe('API schemas — branch field', () => {
  it('codingSessionUpsert input accepts branch', () => {
    const schema = requests.codingSessionUpsert.inputSchema!;
    // With branch
    const r1 = schema.safeParse({
      sessionId: 'cs:abc',
      projectId: 'proj-1',
      branch: 'ugly-studio/session/test',
    });
    expect(r1.success).toBe(true);

    // Without branch (backward compat)
    const r2 = schema.safeParse({
      sessionId: 'cs:abc',
      projectId: 'proj-1',
    });
    expect(r2.success).toBe(true);
  });

  it('codingSessionList output session includes branch', () => {
    const schema = requests.codingSessionList.outputSchema!;
    const r1 = schema.safeParse({
      sessions: [
        {
          sessionId: 'cs:abc',
          title: 'Test',
          model: 'claude-sonnet-4-20250514',
          status: 'idle',
          messageCount: 0,
          costUsd: 0,
          created: 1700000000000,
          updated: 1700000000000,
          branch: 'ugly-studio/session/test',
        },
      ],
    });
    expect(r1.success).toBe(true);

    // Without branch (backward compat)
    const r2 = schema.safeParse({
      sessions: [
        {
          sessionId: 'cs:abc',
          title: 'Test',
          model: 'auto',
          status: 'idle',
          messageCount: 0,
          costUsd: 0,
          created: 1700000000000,
          updated: 1700000000000,
        },
      ],
    });
    expect(r2.success).toBe(true);
  });
});

describe('CodingSessionMessageSchema', () => {
  it('validates a valid message row', () => {
    const result = CodingSessionMessageSchema.safeParse({
      sessionId: 'cs:abc',
      userId: 'user-1',
      seq: 1,
      role: 'user',
      kind: 'message',
      compacted: false,
      content: JSON.stringify('hello'),
    });
    expect(result.success).toBe(true);
  });
});
