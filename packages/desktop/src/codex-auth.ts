import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { shell } from 'electron';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

let pending: PendingLogin | null = null;

interface PendingLogin {
  child: ChildProcess;
  resolve: (result: CodexLoginResult | CodexLoginError) => void;
  timer: NodeJS.Timeout;
  stderrBuf: string;
  settled: boolean;
}

export async function isCodexAuthenticated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('codex', ['login', 'status'], { timeout: 5000 }, (error) => resolve(!error));
  });
}

export interface CodexLoginResult {
  ok: true;
}

export interface CodexLoginError {
  ok: false;
  error: string;
}

export async function startCodexLogin(): Promise<CodexLoginResult | CodexLoginError> {
  if (await isCodexAuthenticated()) return { ok: true };
  if (pending) {
    cancelCodexLogin();
  }
  return new Promise<CodexLoginResult | CodexLoginError>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('codex', ['login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const entry: PendingLogin = {
      child,
      resolve,
      stderrBuf: '',
      settled: false,
      timer: setTimeout(() => {
        settle({ ok: false, error: 'Sign-in timed out after 5 minutes.' });
      }, LOGIN_TIMEOUT_MS),
    };
    pending = entry;

    function settle(result: CodexLoginResult | CodexLoginError): void {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      try {
        // If the child is still running, kill it. Codex's login subprocess
        // owns a loopback HTTP server; we want it gone before we resolve.
        if (entry.child.exitCode === null) {
          entry.child.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
      if (pending === entry) pending = null;
      resolve(result);
    }

    let openedExternal = false;
    const handleStream = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      if (!openedExternal) {
        // codex prints "https://auth.openai.com/oauth/authorize?..." early in
        // its stdout. Open it ourselves via Electron — codex's own
        // browser-open call may fail when launched from a non-TTY child.
        const match = text.match(/https?:\/\/auth\.openai\.com\/[^\s]+/);
        if (match) {
          openedExternal = true;
          void shell.openExternal(match[0]);
        }
      }
    };
    child.stdout?.on('data', handleStream);
    child.stderr?.on('data', (chunk: Buffer) => {
      entry.stderrBuf += chunk.toString('utf-8');
      handleStream(chunk);
    });

    child.on('error', (err) => {
      settle({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    child.on('close', (code) => {
      if (code === 0) {
        settle({ ok: true });
      } else {
        const stderr = entry.stderrBuf.trim();
        const detail = stderr.length > 0 ? stderr : `codex login exited with code ${code ?? 'null'}`;
        settle({ ok: false, error: detail });
      }
    });
  });
}

export function cancelCodexLogin(): void {
  if (!pending) return;
  const entry = pending;
  pending = null;
  if (entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  try {
    entry.child.kill('SIGTERM');
  } catch {
    // ignore
  }
  entry.resolve({ ok: false, error: 'Sign-in cancelled by user.' });
}
