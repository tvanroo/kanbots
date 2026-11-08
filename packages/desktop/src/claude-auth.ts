import { claudeSignInNeedsRefresh } from '@kanborg/api';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export function claudeExecutable(): string {
  for(const directory of [...(process.env.PATH??'').split(delimiter),join(homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin']){
    if(!directory)continue;const candidate=join(directory,'claude');
    try{accessSync(candidate,constants.X_OK);return candidate;}catch{}
  }
  return 'claude';
}


let login: ChildProcess | undefined;

export function getClaudeDetails(): Promise<{ hasKey: boolean; authenticationLabel: string; cliAvailable: boolean }> {
  return new Promise((resolve) => {
    execFile(claudeExecutable(), ['auth', 'status', '--json'], { timeout: 15000 }, (error, stdout) => {
      try {
        if (error && !stdout.trim()) throw error;
        const status = JSON.parse(stdout);
        resolve({ cliAvailable: true, hasKey: status.loggedIn === true && (!status.loginExpiresAt || Date.parse(status.loginExpiresAt)>Date.now()), authenticationLabel: status.loggedIn !== true ? 'Sign in to your Claude subscription' : status.authMethod === 'claude.ai'
          ? 'Claude subscription' : status.authMethod === 'api_key' ? 'Anthropic API billing' : 'Claude authentication detected — billing method unconfirmed' });
      } catch { const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'; resolve({ hasKey: false, cliAvailable: !missing, authenticationLabel: missing ? 'Claude Code needs to be installed' : 'Claude sign-in could not be checked. Try signing in again.' }); }
    });
  });
}
export async function isClaudeAuthenticated(requireFreshUsageToken=false): Promise<boolean> {
  return (await getClaudeDetails()).hasKey && (!requireFreshUsageToken || !await claudeSignInNeedsRefresh());
}

export async function startClaudeLogin(installIfMissing = true): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await isClaudeAuthenticated() && !await claudeSignInNeedsRefresh()) return { ok: true };
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
    const child = spawn(claudeExecutable(), ['auth', 'login', '--claudeai'], { stdio: 'ignore' });
    login = child;
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
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
