import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStoreInMemory, type Store } from '@kanbots/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectWorktreeGarbage,
  reclaimWorktree,
  restoreRunWorktree,
  retentionDaysFromEnv,
  slimWorktree,
} from '../src/agent-runs/worktree-gc.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

let root: string;
let repo: string;
let store: Store;
let threadId: number;

const DAY = 24 * 60 * 60 * 1000;

function addWorktree(issue: number, runId: number): { path: string; branch: string } {
  const path = join(repo, '.kanbots', 'worktrees', `issue-${issue}-${runId}`);
  const branch = `kanbots/issue-${issue}-${runId}`;
  mkdirSync(join(repo, '.kanbots', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-b', branch, path);
  return { path, branch };
}

function makeRun(path: string, branch: string, status: 'complete' | 'running' = 'complete') {
  const run = store.agentRuns.create({ threadId, worktreePath: path, branchName: branch });
  return store.agentRuns.update(run.id, {
    status,
    endedAt: status === 'complete' ? new Date(Date.now() - 10 * DAY).toISOString() : null,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kanbots-gc-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n.kanbots/\n.env\n');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  store = openStoreInMemory();
  threadId = store.threads.getOrCreate({ repoOwner: 'o', repoName: 'r', issueNumber: 1 }).id;
});

afterEach(() => {
  store.close?.();
  rmSync(root, { recursive: true, force: true });
});

describe('retentionDaysFromEnv', () => {
  it('defaults to 3 days and can be disabled', () => {
    expect(retentionDaysFromEnv(undefined)).toBe(3);
    expect(retentionDaysFromEnv('7')).toBe(7);
    expect(retentionDaysFromEnv('0')).toBeNull();
    expect(retentionDaysFromEnv('off')).toBeNull();
    expect(retentionDaysFromEnv('junk')).toBe(3);
  });
});

describe('slimWorktree', () => {
  it('removes only git-ignored regenerable dirs', async () => {
    const { path } = addWorktree(1, 1);
    mkdirSync(join(path, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(path, 'pkg', 'dist'), { recursive: true });
    writeFileSync(join(path, '.env'), 'SECRET=1');
    mkdirSync(join(path, 'build')); // not ignored → must survive
    writeFileSync(join(path, 'build', 'keep.txt'), 'k');
    const removed = await slimWorktree(path);
    expect(removed.sort()).toEqual(['node_modules', 'pkg/dist']);
    expect(existsSync(join(path, 'node_modules'))).toBe(false);
    expect(existsSync(join(path, '.env'))).toBe(true);
    expect(existsSync(join(path, 'build', 'keep.txt'))).toBe(true);
  });
});

describe('reclaimWorktree', () => {
  it('removes a clean worktree and deletes a branch already merged into base', async () => {
    const { path, branch } = addWorktree(1, 1);
    mkdirSync(join(path, 'node_modules'));
    const out = await reclaimWorktree(path, { branch, dirtyPolicy: 'auto' });
    expect(out).toEqual({ kind: 'removed', branchDeleted: true, snapshotted: false });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', branch).trim()).toBe('');
  });

  it('keeps the branch when it has unmerged commits', async () => {
    const { path, branch } = addWorktree(1, 2);
    writeFileSync(join(path, 'b.txt'), 'b');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'work');
    const out = await reclaimWorktree(path, { branch, dirtyPolicy: 'auto' });
    expect(out).toMatchObject({ kind: 'removed', branchDeleted: false });
    expect(git(repo, 'branch', '--list', branch).trim()).toContain(branch);
  });

  it('auto policy never removes a dirty worktree, only slims it', async () => {
    const { path, branch } = addWorktree(1, 3);
    writeFileSync(join(path, 'wip.txt'), 'unsaved');
    mkdirSync(join(path, 'node_modules'));
    const out = await reclaimWorktree(path, { branch, dirtyPolicy: 'auto' });
    expect(out).toEqual({ kind: 'slimmed', removedDirs: ['node_modules'] });
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);
  });

  it('snapshot policy commits uncommitted work onto the branch before removing', async () => {
    const { path, branch } = addWorktree(1, 4);
    writeFileSync(join(path, 'wip.txt'), 'unsaved');
    const out = await reclaimWorktree(path, { branch, dirtyPolicy: 'snapshot' });
    expect(out).toEqual({ kind: 'removed', branchDeleted: false, snapshotted: true });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'show', `${branch}:wip.txt`)).toBe('unsaved');
  });
});

describe('collectWorktreeGarbage', () => {
  it('reclaims idle and superseded runs but leaves active and recent ones', async () => {
    const idle = addWorktree(1, 1);
    const idleRun = makeRun(idle.path, idle.branch);
    const active = addWorktree(1, 2);
    const activeRun = makeRun(active.path, active.branch, 'running');
    const report = await collectWorktreeGarbage({ store, retentionDays: 3 });
    expect(report.removed).toContain(idle.path);
    expect(existsSync(idle.path)).toBe(false);
    expect(existsSync(active.path)).toBe(true);
    expect(store.agentRuns.findById(idleRun.id)?.worktreePath).toBeNull();
    expect(store.agentRuns.findById(activeRun.id)?.worktreePath).toBe(active.path);
  });

  it('keeps the latest run of a thread within retention, reclaims older superseded runs', async () => {
    const older = addWorktree(1, 1);
    const olderRun = store.agentRuns.create({
      threadId,
      worktreePath: older.path,
      branchName: older.branch,
    });
    store.agentRuns.update(olderRun.id, { status: 'complete', endedAt: new Date().toISOString() });
    const latest = addWorktree(1, 2);
    const latestRun = store.agentRuns.create({
      threadId,
      worktreePath: latest.path,
      branchName: latest.branch,
    });
    store.agentRuns.update(latestRun.id, { status: 'complete', endedAt: new Date().toISOString() });
    await collectWorktreeGarbage({ store, retentionDays: 3 });
    expect(existsSync(older.path)).toBe(false);
    expect(existsSync(latest.path)).toBe(true);
  });

  it('reclaims stale orphan worktrees no run references, and ignores fresh ones', async () => {
    const orphan = addWorktree(9, 99);
    const fresh = addWorktree(9, 100);
    const old = new Date(Date.now() - 10 * DAY);
    utimesSync(orphan.path, old, old);
    const adminIndex = git(orphan.path, 'rev-parse', '--git-path', 'index').trim();
    const adminHead = git(orphan.path, 'rev-parse', '--git-path', 'HEAD').trim();
    for (const p of [adminIndex, adminHead]) {
      const abs = p.startsWith('/') ? p : join(orphan.path, p);
      if (existsSync(abs)) utimesSync(abs, old, old);
    }
    await collectWorktreeGarbage({ store, retentionDays: 3, repoPaths: [repo] });
    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
  });
});

describe('restoreRunWorktree', () => {
  it('recreates a reclaimed worktree from its branch', async () => {
    const { path, branch } = addWorktree(1, 1);
    writeFileSync(join(path, 'b.txt'), 'b');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'work');
    const run = makeRun(path, branch);
    await collectWorktreeGarbage({ store, retentionDays: 3 });
    const reclaimed = store.agentRuns.findById(run.id)!;
    expect(reclaimed.worktreePath).toBeNull();
    expect(reclaimed.branchName).toBe(branch);
    const restored = await restoreRunWorktree(store, reclaimed, repo, { worktreePath: path });
    expect(restored?.worktreePath).toBe(path);
    expect(existsSync(join(path, 'b.txt'))).toBe(true);
  });
});
