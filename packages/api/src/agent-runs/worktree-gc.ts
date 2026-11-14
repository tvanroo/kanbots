/**
 * Worktree garbage collection.
 *
 * Every agent run gets its own `git worktree` under
 * `<repo>/.kanbots/worktrees/issue-<N>-<runId>`. Each one is a full checkout,
 * and once an agent has run `pnpm install` / a build inside it, it easily
 * weighs hundreds of megabytes. Nothing used to remove them unless the user
 * explicitly marked a card done or promoted a commit, so they piled up by
 * the thousand.
 *
 * Safety policy (the same everywhere in this module):
 *
 *   - Committed work is never destroyed. Removing a worktree keeps its
 *     branch; the branch is only deleted when it has zero commits beyond the
 *     local base branch (i.e. the work is already in main/master).
 *   - Uncommitted work is never destroyed by the automatic collector. A
 *     dirty worktree is not removed; instead only git-ignored, regenerable
 *     directories inside it (node_modules, dist, .next, target, …) are
 *     deleted, which is where nearly all of the disk goes.
 *   - Explicit cleanups (card marked done, commit promoted) snapshot any
 *     uncommitted changes into a commit on the run's branch first, so the
 *     work survives in the branch after the worktree is gone.
 *   - Runs that are active, awaiting input, or serving a preview are never
 *     touched.
 *
 * A removed worktree can be recreated from its branch on demand (see
 * `restoreRunWorktree`), so a user replying to an old card still resumes
 * the agent in the same place.
 */

import { execFile } from 'node:child_process';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRun, Store } from '@kanbots/local-store';

const execFileAsync = promisify(execFile);

/** Directory names that are safe to delete when git ignores them: they are
 *  dependency installs, build outputs and caches that a re-install or
 *  re-build recreates. Only removed when `git` reports them as ignored. */
export const DEFAULT_REGENERABLE_DIRS: readonly string[] = [
  'node_modules',
  '.pnpm-store',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.angular',
  '.expo',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
  'target',
  '.gradle',
  'DerivedData',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
];

const ACTIVE_STATUSES = new Set<AgentRun['status']>(['starting', 'running', 'awaiting_input']);

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RETENTION_DAYS = 3;

/** Parse `KANBOTS_WORKTREE_RETENTION_DAYS`; `0` or `off` disables the
 *  automatic collector. Returns null when disabled. */
export function retentionDaysFromEnv(
  raw: string | undefined = process.env.KANBOTS_WORKTREE_RETENTION_DAYS,
): number | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === 'never') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  if (n === 0) return null;
  return n;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<string>;
}

const defaultGit: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Repo root that owns a linked worktree (via `--git-common-dir`), or null
 *  if the path isn't a git checkout. */
export async function owningRepoOf(
  worktreePath: string,
  git: GitRunner = defaultGit,
): Promise<string | null> {
  try {
    const out = (await git(['rev-parse', '--git-common-dir'], worktreePath)).trim();
    if (!out) return null;
    const common = isAbsolute(out) ? out : resolve(worktreePath, out);
    return basename(common) === '.git' ? dirname(common) : common;
  } catch {
    return null;
  }
}

/** Repo root inferred from the kanbots worktree layout, used when the
 *  worktree directory is already gone. */
export function repoFromWorktreeLayout(worktreePath: string): string | null {
  const marker = `${sep}.kanbots${sep}worktrees${sep}`;
  const idx = worktreePath.indexOf(marker);
  if (idx <= 0) return null;
  return worktreePath.slice(0, idx);
}

export async function isDirty(path: string, git: GitRunner = defaultGit): Promise<boolean> {
  // Ignored files are excluded by default, so regenerable dirs don't count.
  const out = await git(['status', '--porcelain', '--untracked-files=normal'], path);
  return out.trim() !== '';
}

export async function detectBaseBranch(
  repoPath: string,
  git: GitRunner = defaultGit,
): Promise<string | null> {
  for (const ref of ['main', 'master']) {
    try {
      await git(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], repoPath);
      return ref;
    } catch {
      // try next
    }
  }
  return null;
}

async function branchExists(repoPath: string, branch: string, git: GitRunner): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

/** True only when we can prove the branch has no commits beyond base. */
async function isMergedIntoBase(
  repoPath: string,
  base: string | null,
  branch: string,
  git: GitRunner,
): Promise<boolean> {
  if (base === null || branch === base) return false;
  try {
    const out = await git(['rev-list', '--count', `${base}..${branch}`], repoPath);
    return out.trim() === '0';
  } catch {
    return false;
  }
}

/**
 * Delete git-ignored regenerable directories (node_modules, dist, …) inside
 * a worktree. Tracked files and untracked-but-not-ignored files are never
 * touched. Returns the repo-relative paths removed.
 */
export async function slimWorktree(
  worktreePath: string,
  opts: { git?: GitRunner; regenerableDirs?: readonly string[] } = {},
): Promise<string[]> {
  const git = opts.git ?? defaultGit;
  const names = new Set(opts.regenerableDirs ?? DEFAULT_REGENERABLE_DIRS);
  let out: string;
  try {
    out = await git(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      worktreePath,
    );
  } catch {
    return [];
  }
  const root = resolve(worktreePath);
  const removed: string[] = [];
  for (const entry of out.split('\0')) {
    if (!entry.endsWith('/')) continue; // directories only
    const rel = entry.slice(0, -1);
    if (!names.has(basename(rel))) continue;
    const abs = resolve(root, rel);
    // Defence in depth: never escape the worktree.
    if (abs === root || !abs.startsWith(root + sep)) continue;
    try {
      await rm(abs, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // best-effort
    }
  }
  return removed;
}

/**
 * Commit any uncommitted changes in a worktree onto its branch so they
 * survive the worktree being removed. Returns true if a commit was made.
 * Throws if the snapshot could not be made (callers must then keep the
 * worktree).
 */
export async function snapshotUncommitted(
  worktreePath: string,
  git: GitRunner = defaultGit,
): Promise<boolean> {
  if (!(await isDirty(worktreePath, git))) return false;
  await git(['add', '-A'], worktreePath);
  await git(
    [
      '-c',
      'user.name=kanbots',
      '-c',
      'user.email=kanbots@localhost',
      'commit',
      '--no-verify',
      '-m',
      'kanbots: snapshot uncommitted work before worktree cleanup',
    ],
    worktreePath,
  );
  return true;
}

export type ReclaimOutcome =
  | { kind: 'removed'; branchDeleted: boolean; snapshotted: boolean }
  | { kind: 'slimmed'; removedDirs: string[] }
  | { kind: 'missing'; branchDeleted: boolean }
  | { kind: 'kept'; reason: string };

export interface ReclaimOptions {
  /** Repo the worktree belongs to, used when it can't be derived from the
   *  worktree itself (e.g. the directory is already gone). */
  fallbackRepoPath?: string | null;
  branch?: string | null;
  /** `auto` never removes a dirty worktree (slims it instead).
   *  `snapshot` commits dirty changes onto the branch, then removes. */
  dirtyPolicy: 'auto' | 'snapshot';
  /** Delete the branch when it has zero commits beyond base. Default true.
   *  A branch that received a snapshot commit is always kept. */
  deleteMergedBranch?: boolean;
  git?: GitRunner;
  regenerableDirs?: readonly string[];
}

/** Remove (or, if it holds uncommitted work, slim) one worktree. */
export async function reclaimWorktree(
  worktreePath: string,
  opts: ReclaimOptions,
): Promise<ReclaimOutcome> {
  const git = opts.git ?? defaultGit;
  const deleteMerged = opts.deleteMergedBranch ?? true;
  const exists = await pathExists(worktreePath);
  const repoPath =
    (exists ? await owningRepoOf(worktreePath, git) : null) ??
    repoFromWorktreeLayout(worktreePath) ??
    opts.fallbackRepoPath ??
    null;

  const maybeDeleteBranch = async (): Promise<boolean> => {
    if (!deleteMerged || !opts.branch || repoPath === null) return false;
    if (!(await branchExists(repoPath, opts.branch, git))) return false;
    const base = await detectBaseBranch(repoPath, git);
    if (!(await isMergedIntoBase(repoPath, base, opts.branch, git))) return false;
    try {
      await git(['branch', '-D', opts.branch], repoPath);
      return true;
    } catch {
      return false;
    }
  };

  if (!exists) {
    if (repoPath !== null) {
      await git(['worktree', 'prune'], repoPath).catch(() => '');
    }
    return { kind: 'missing', branchDeleted: await maybeDeleteBranch() };
  }
  if (repoPath === null) {
    return { kind: 'kept', reason: 'not a git worktree' };
  }
  if (resolve(repoPath) === resolve(worktreePath)) {
    return { kind: 'kept', reason: 'main checkout' };
  }

  let dirty: boolean;
  try {
    dirty = await isDirty(worktreePath, git);
  } catch {
    return { kind: 'kept', reason: 'git status failed' };
  }

  let snapshotted = false;
  if (dirty) {
    if (opts.dirtyPolicy === 'auto') {
      const removedDirs = await slimWorktree(worktreePath, {
        git,
        ...(opts.regenerableDirs ? { regenerableDirs: opts.regenerableDirs } : {}),
      });
      return { kind: 'slimmed', removedDirs };
    }
    try {
      snapshotted = await snapshotUncommitted(worktreePath, git);
    } catch (err) {
      return {
        kind: 'kept',
        reason: `could not snapshot uncommitted work: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    // No --force: git refuses if anything uncommitted appeared meanwhile.
    // Ignored files (node_modules etc.) don't block removal.
    await git(['worktree', 'remove', worktreePath], repoPath);
  } catch (err) {
    return {
      kind: 'kept',
      reason: `git worktree remove failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const branchDeleted = snapshotted ? false : await maybeDeleteBranch();
  return { kind: 'removed', branchDeleted, snapshotted };
}

/**
 * Recreate a run's worktree from its retained branch so the run can be
 * resumed after the collector removed it. If the run still records a path
 * that no longer exists on disk, the worktree is recreated at that path;
 * otherwise at `opts.worktreePath`. Returns the (possibly updated) run, or
 * null if there's nothing to restore from.
 */
export async function restoreRunWorktree(
  store: Store,
  run: AgentRun,
  repoPath: string,
  opts: { worktreePath: string; git?: GitRunner },
): Promise<AgentRun | null> {
  const git = opts.git ?? defaultGit;
  if (run.worktreePath !== null && (await pathExists(run.worktreePath))) return run;
  if (!run.branchName) return null;
  if (!(await branchExists(repoPath, run.branchName, git))) return null;
  const target = run.worktreePath ?? opts.worktreePath;
  if (await pathExists(target)) return null;
  await git(['worktree', 'prune'], repoPath).catch(() => '');
  try {
    await git(['worktree', 'add', target, run.branchName], repoPath);
  } catch {
    return null;
  }
  return store.agentRuns.update(run.id, { worktreePath: target });
}

export interface WorktreeGcOptions {
  store: Store;
  /** Repos to scan for orphaned worktree directories in addition to the
   *  ones referenced by agent_runs rows. */
  repoPaths?: readonly string[] | (() => readonly string[]);
  /** Terminal runs idle for this long are reclaimed. */
  retentionDays?: number;
  /** Return true for runs the caller knows are live (in-memory handles). */
  isRunActive?: (runId: number) => boolean;
  now?: () => number;
  git?: GitRunner;
  regenerableDirs?: readonly string[];
}

export interface WorktreeGcReport {
  removed: string[];
  slimmed: string[];
  kept: Array<{ path: string; reason: string }>;
  branchesDeleted: number;
}

function runIdleSince(run: AgentRun): number {
  const iso = run.endedAt ?? run.startedAt;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** A terminal run is superseded when a later run exists in the same
 *  (thread, chat session) scope — only the latest run in a scope can be
 *  resumed, so older worktrees are dead weight. */
function supersededRunIds(runs: readonly AgentRun[]): Set<number> {
  const latest = new Map<string, number>();
  for (const r of runs) {
    const key = `${r.threadId}:${r.chatSessionId ?? 'none'}`;
    const prev = latest.get(key);
    if (prev === undefined || r.id > prev) latest.set(key, r.id);
  }
  const out = new Set<number>();
  for (const r of runs) {
    const key = `${r.threadId}:${r.chatSessionId ?? 'none'}`;
    if (latest.get(key) !== r.id) out.add(r.id);
  }
  return out;
}

async function lastActivityMs(dir: string, git: GitRunner): Promise<number> {
  let latest = 0;
  const bump = async (p: string): Promise<void> => {
    try {
      const s = await stat(p);
      latest = Math.max(latest, s.mtimeMs);
    } catch {
      // ignore
    }
  };
  await bump(dir);
  try {
    const idx = (await git(['rev-parse', '--git-path', 'index'], dir)).trim();
    if (idx) await bump(isAbsolute(idx) ? idx : resolve(dir, idx));
    const head = (await git(['rev-parse', '--git-path', 'HEAD'], dir)).trim();
    if (head) await bump(isAbsolute(head) ? head : resolve(dir, head));
  } catch {
    // not a worktree
  }
  return latest;
}

/**
 * One collection pass. Safe to call repeatedly; never throws.
 *
 *   1. Runs with a recorded worktree that are terminal and either superseded
 *      by a later run or idle past the retention window are reclaimed.
 *   2. Directories under `<repo>/.kanbots/worktrees/` and
 *      `<repo>/.kanbots/promote/` that no run references (left over from
 *      forks, cloud runs, crashes or a reset database) and that have been
 *      untouched past the retention window are reclaimed.
 *   3. `git worktree prune` drops admin entries for vanished directories.
 */
export async function collectWorktreeGarbage(opts: WorktreeGcOptions): Promise<WorktreeGcReport> {
  const git = opts.git ?? defaultGit;
  const now = opts.now ?? Date.now;
  const retentionMs = (opts.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  const report: WorktreeGcReport = { removed: [], slimmed: [], kept: [], branchesDeleted: 0 };
  const reclaimOpts = {
    git,
    ...(opts.regenerableDirs ? { regenerableDirs: opts.regenerableDirs } : {}),
  };

  const record = (path: string, outcome: ReclaimOutcome): void => {
    switch (outcome.kind) {
      case 'removed':
      case 'missing':
        report.removed.push(path);
        if (outcome.branchDeleted) report.branchesDeleted += 1;
        break;
      case 'slimmed':
        if (outcome.removedDirs.length > 0) report.slimmed.push(path);
        else report.kept.push({ path, reason: 'uncommitted changes' });
        break;
      case 'kept':
        report.kept.push({ path, reason: outcome.reason });
        break;
    }
  };

  let runs: AgentRun[];
  try {
    runs = opts.store.agentRuns.listWithWorktree();
  } catch {
    return report;
  }
  const superseded = supersededRunIds(runs);
  const referenced = new Set<string>();
  const extraRepos =
    typeof opts.repoPaths === 'function' ? opts.repoPaths() : (opts.repoPaths ?? []);
  const repos = new Set<string>(extraRepos.map((p) => resolve(p)));

  for (const run of runs) {
    if (!run.worktreePath) continue;
    const wt = resolve(run.worktreePath);
    referenced.add(wt);
    const layoutRepo = repoFromWorktreeLayout(wt);
    if (layoutRepo) repos.add(layoutRepo);

    if (ACTIVE_STATUSES.has(run.status)) continue;
    if (opts.isRunActive?.(run.id)) continue;
    if (run.previewPid !== null) continue;
    const idle = now() - runIdleSince(run);
    if (!superseded.has(run.id) && idle < retentionMs) continue;

    try {
      const outcome = await reclaimWorktree(wt, {
        ...reclaimOpts,
        branch: run.branchName,
        dirtyPolicy: 'auto',
      });
      record(wt, outcome);
      if (outcome.kind === 'removed' || outcome.kind === 'missing') {
        opts.store.agentRuns.update(run.id, {
          worktreePath: null,
          ...(outcome.branchDeleted ? { branchName: null } : {}),
        });
      }
    } catch (err) {
      report.kept.push({ path: wt, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const repo of repos) {
    for (const sub of ['worktrees', 'promote']) {
      const parent = join(repo, '.kanbots', sub);
      let entries: string[];
      try {
        entries = await readdir(parent);
      } catch {
        continue;
      }
      for (const name of entries) {
        const dir = resolve(parent, name);
        if (referenced.has(dir)) continue;
        try {
          const s = await stat(dir);
          if (!s.isDirectory()) continue;
          if (now() - (await lastActivityMs(dir, git)) < retentionMs) continue;
          const children = await readdir(dir);
          if (children.length === 0) {
            await rmdir(dir);
            report.removed.push(dir);
            continue;
          }
          let branch: string | null = null;
          try {
            const b = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir)).trim();
            branch = b || null;
          } catch {
            branch = null;
          }
          // Only ever delete kanbots-owned branches.
          const ownBranch = branch !== null && branch.startsWith('kanbots/') ? branch : null;
          record(
            dir,
            await reclaimWorktree(dir, {
              ...reclaimOpts,
              fallbackRepoPath: repo,
              branch: ownBranch,
              dirtyPolicy: 'auto',
            }),
          );
        } catch (err) {
          report.kept.push({ path: dir, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    await git(['worktree', 'prune'], repo).catch(() => '');
  }

  return report;
}

export interface WorktreeGcScheduler {
  /** Run a pass now (coalesced with any pass already in flight). */
  runNow(): Promise<WorktreeGcReport | null>;
  stop(): void;
}

/**
 * Run `collectWorktreeGarbage` shortly after startup and then periodically.
 * Timers are unref'd so they never keep the process alive.
 */
export function scheduleWorktreeGc(
  opts: WorktreeGcOptions & {
    initialDelayMs?: number;
    intervalMs?: number;
    onReport?: (report: WorktreeGcReport) => void;
  },
): WorktreeGcScheduler {
  let inFlight: Promise<WorktreeGcReport | null> | null = null;
  let stopped = false;
  const runNow = (): Promise<WorktreeGcReport | null> => {
    if (stopped) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = collectWorktreeGarbage(opts)
      .then((report) => {
        opts.onReport?.(report);
        return report;
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const initial = setTimeout(() => void runNow(), opts.initialDelayMs ?? 60_000);
  initial.unref?.();
  const interval = setInterval(() => void runNow(), opts.intervalMs ?? 60 * 60 * 1000);
  interval.unref?.();
  return {
    runNow,
    stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}
