import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStoreInMemory, type Store } from '../src/index.js';

describe('prepared statement reuse', () => {
  let store: Store;
  beforeEach(() => {
    store = openStoreInMemory();
  });
  afterEach(() => {
    store.close();
  });

  it('returns the same compiled statement for the same SQL', () => {
    const sql = 'SELECT * FROM agent_runs WHERE id = ?';
    expect(store.db.prepare(sql)).toBe(store.db.prepare(sql));
  });

  it('keeps reads current after writes through a reused statement', () => {
    const threadId = store.threads.create({ repoOwner: 'a', repoName: 'b', issueNumber: 1 }).id;
    const run = store.agentRuns.create({ threadId });
    expect(store.agentRuns.findById(run.id)?.status).toBe('starting');
    store.agentRuns.update(run.id, { status: 'complete' });
    expect(store.agentRuns.findById(run.id)?.status).toBe('complete');
  });

  it('findByIds matches findById across chunk boundaries and ignores unknown ids', () => {
    const threadId = store.threads.create({ repoOwner: 'a', repoName: 'b', issueNumber: 1 }).id;
    const ids: number[] = [];
    for (let i = 0; i < 450; i++) ids.push(store.agentRuns.create({ threadId }).id);
    const found = store.agentRuns.findByIds([...ids, ids[0]!, 999_999]);
    expect(found.size).toBe(ids.length);
    for (const id of ids) expect(found.get(id)).toEqual(store.agentRuns.findById(id));
    expect(found.has(999_999)).toBe(false);
  });
});
