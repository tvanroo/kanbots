import { useEffect, useState } from 'react';
import { getBridge, type RecentWorkspace } from '../desktop-bridge.js';
import { Logo } from '../components/Logo.js';

export function WorkspacePicker({ initialRecents, onOpened }: {
  initialRecents: RecentWorkspace[];
  onOpened: () => void;
}) {
  const [recents, setRecents] = useState<RecentWorkspace[]>(initialRecents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    void bridge.recentWorkspaces().then(setRecents);
  }, []);

  async function open(repoPath: string): Promise<void> {
    const bridge = getBridge();
    if (!bridge) {
      setError('Desktop bridge not available — open the desktop app instead.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await bridge.openWorkspace(repoPath);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    onOpened();
  }

  async function pickFolder(): Promise<void> {
    const bridge = getBridge();
    if (!bridge) {
      setError('Desktop bridge not available — open the desktop app instead.');
      return;
    }
    const path = await bridge.pickFolder();
    if (!path) return;
    await open(path);
  }

  return (
    <div className="picker">
      <div className="picker-card">
        <h1 className="picker-title">
          <Logo size={28} withWordmark />
        </h1>
        <p className="picker-sub">Pick a project folder to open its workspace.</p>
        <button
          type="button"
          className="picker-primary"
          onClick={() => void pickFolder()}
          disabled={busy}
        >
          {busy ? 'Opening…' : 'Open folder…'}
        </button>
        {error ? (
          <p className="composer-error" role="alert">
            {error}
          </p>
        ) : null}
        {recents.length > 0 ? (
          <div className="picker-recents">
            <h2 className="picker-recents-heading">Recent</h2>
            <ul className="picker-recents-list">
              {recents.map((r) => (
                <li key={r.repoPath}>
                  <button
                    type="button"
                    className="picker-recent"
                    onClick={() => void open(r.repoPath)}
                    disabled={busy}
                  >
                    <span className="picker-recent-name">{r.displayName}</span>
                    <span className="picker-recent-path muted">{r.repoPath}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted picker-empty">No recent workspaces yet.</p>
        )}

      </div>
    </div>
  );
}
