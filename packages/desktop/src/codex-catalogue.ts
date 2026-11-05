import { spawn } from 'node:child_process';

export interface CodexDetails {
  hasKey: boolean;
  authenticationLabel: string;
  models: Array<{ id: string; label: string }>;
  catalogueError?: string;
}

// Use the same CLI and account as task execution. Never forward account details,
// raw protocol errors, or credential material to the renderer.
export async function getCodexDetails(): Promise<CodexDetails> {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let sequence = 0;
  let buffer = '';
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = () => {
    for (const request of pending.values()) request.reject(new Error('Codex unavailable'));
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error('Codex request failed'));
        else request.resolve(message.result);
      } catch { /* Ignore non-protocol output. */ }
    }
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 15000);
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const details: CodexDetails = { hasKey: false, authenticationLabel: 'Authentication could not be checked', models: [] };
  try {
    await call('initialize', { clientInfo: { name: 'kanbots_local', version: '1.1.2' }, capabilities: null });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const { account } = await call('account/read', { refreshToken: false });
    details.hasKey = account != null;
    details.authenticationLabel = account?.type === 'chatgpt'
      ? 'ChatGPT subscription'
      : account?.type === 'apiKey' ? 'OpenAI API billing'
      : account ? 'Other Codex authentication' : 'Signed out of Codex';
    let cursor: string | null = null;
    do {
      const page = await call('model/list', { cursor, includeHidden: false });
      for (const model of page.data) {
        if (typeof model.model === 'string' && typeof model.displayName === 'string') {
          details.models.push({ id: model.model, label: model.displayName });
        }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
  } catch {
    details.catalogueError = 'Could not load models from Codex. Check that the CLI is up to date and signed in, then refresh.';
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
  return details;
}
