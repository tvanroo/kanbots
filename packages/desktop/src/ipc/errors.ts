export interface IpcError {
  name: string;
  message: string;
  details?: unknown;
}

export function toIpcError(err: unknown): IpcError {
  if (err instanceof Error) {
    const { name, message } = err;
    if (name === 'ValidationError' && Array.isArray((err as { issues?: unknown }).issues)) {
      const fields = ((err as unknown as { issues: Array<{ path?: unknown[] }> }).issues)
        .map(issue => issue.path?.at(-1)).filter((field): field is string => typeof field === 'string');
      // Return field names only, never submitted values or raw validation details.
      return { name, message, details: { fields } };
    }
    const e = err as { run?: unknown; cooldown?: unknown };
    const details = e.run !== undefined ? e.run : e.cooldown;
    return details !== undefined ? { name, message, details } : { name, message };
  }
  return { name: 'UnknownError', message: String(err) };
}
