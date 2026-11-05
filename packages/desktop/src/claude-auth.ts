import { execFile, spawn, type ChildProcess } from 'node:child_process';

let login: ChildProcess | undefined;

export function isClaudeAuthenticated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status', '--json'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(false);
      try {
        const status = JSON.parse(stdout) as { loggedIn?: boolean };
        resolve(status.loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

export async function startClaudeLogin(): Promise<{ ok: true } | { ok: false; error: string }> {
  cancelClaudeLogin();
  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'login', '--claudeai'], { stdio: 'ignore' });
    login = child;
    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
    child.once('error', () => {
      clearTimeout(timer);
      if (login === child) login = undefined;
      resolve({ ok: false, error: 'Install or update Claude Code, then try signing in again.' });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (login === child) login = undefined;
      resolve(code === 0
        ? { ok: true }
        : { ok: false, error: 'Claude sign-in did not complete. Run claude auth login --claudeai in Terminal and try again.' });
    });
  });
}

export function cancelClaudeLogin(): void {
  login?.kill();
  login = undefined;
}
