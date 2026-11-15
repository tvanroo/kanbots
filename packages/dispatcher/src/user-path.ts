import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Directories where agent CLIs (claude, codex) are usually installed per user.
 * A GUI app launched by the OS (Finder, Dock, launchd) inherits only
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `claude` spawn fails with ENOENT
 * even though it works from a terminal. 2026-11-15: after such a relaunch every
 * run spawned without a pid for twelve hours.
 */
export function userBinDirs(home: string = homedir()): string[] {
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * Return `env` with the user bin directories appended to PATH when they are
 * missing. Existing entries keep their order and precedence; nothing is added
 * on Windows, where PATH resolution works differently.
 */
export function withUserBinPath(
  env: NodeJS.ProcessEnv,
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  if ((opts.platform ?? process.platform) === 'win32') return env;
  const current = (env.PATH ?? '').split(delimiter).filter((p) => p !== '');
  const missing = userBinDirs(opts.home).filter((dir) => !current.includes(dir));
  if (missing.length === 0) return env;
  return { ...env, PATH: [...current, ...missing].join(delimiter) };
}
