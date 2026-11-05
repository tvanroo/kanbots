import { execFile, spawn, type ChildProcess } from 'node:child_process';

let login: ChildProcess | undefined;

export function getClaudeDetails(): Promise<{ hasKey: boolean; authenticationLabel: string; cliAvailable: boolean }> {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status', '--json'], { timeout: 5000 }, (error, stdout) => {
      try {
        if (error && !stdout.trim()) throw error;
        const status = JSON.parse(stdout);
        resolve({ cliAvailable: true, hasKey: status.loggedIn === true, authenticationLabel: status.loggedIn !== true ? 'Sign in to your Claude subscription' : status.authMethod === 'claude.ai'
          ? 'Claude subscription' : status.authMethod === 'api_key' ? 'Anthropic API billing' : 'Claude authentication detected — billing method unconfirmed' });
      } catch { const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'; resolve({ hasKey: false, cliAvailable: !missing, authenticationLabel: missing ? 'Claude Code needs to be installed' : 'Claude sign-in could not be checked. Try signing in again.' }); }
    });
  });
}
export async function isClaudeAuthenticated(): Promise<boolean> {
  return (await getClaudeDetails()).hasKey;
}

export async function startClaudeLogin(installIfMissing = false): Promise<{ ok: true } | { ok: false; error: string }> {
  cancelClaudeLogin();
  if (!(await getClaudeDetails()).cliAvailable) {
    if (!installIfMissing || process.platform !== 'darwin') return { ok: false, error: 'Install Claude Code to connect your subscription.' };
    const installed = await new Promise<boolean>((resolve) => {
      // Fixed official installer only; no user-provided shell commands.
      const child = spawn('/bin/bash', ['-o', 'pipefail', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'], { stdio: 'ignore' });
      login = child;
      const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
      const finish = (ok: boolean) => { clearTimeout(timer); if (login === child) login = undefined; resolve(ok); };
      child.once('error', () => finish(false));
      child.once('close', code => finish(code === 0));
    });
    if (!installed) return { ok: false, error: 'Claude Code installation did not finish. Check your internet connection and try again.' };
  }
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
