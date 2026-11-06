import { Logo } from '../Logo.js';
import { useEffect, useMemo, useState } from 'react';
import { createPersona, deletePersona, listPersonas, type Persona } from '../../personas.js';
import type { ProviderId } from '../../types.js';

export interface PersonaPickerModalProps {
  onClose: () => void;
  onPick: (persona: Persona, provider?: ProviderId, userNotes?: string) => void;
  /** If true, the user can pick multiple personas before confirming. */
  multiSelect?: boolean;
  /** Confirm button label override in multi-select mode. */
  multiSelectConfirmLabel?: string;
  /** Called with the selected personas when the user confirms in multi-select mode. */
  onConfirm?: (personas: Persona[], provider?: ProviderId, userNotes?: string) => void;
  /** Headline shown next to the kanbots crumb. */
  title?: string;
  /** Subhead shown above the persona grid. */
  subtitle?: string;
}

export function PersonaPickerModal({
  onClose,
  onPick,
  multiSelect = false,
  multiSelectConfirmLabel,
  onConfirm,
  title,
  subtitle,
}: PersonaPickerModalProps) {
  const [personas, setPersonas] = useState<Persona[]>(() => listPersonas());
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftEmoji, setDraftEmoji] = useState('');
  const [draftTagline, setDraftTagline] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [userNotes, setUserNotes] = useState('');

  const selectedPersonas = useMemo(
    () => personas.filter((p) => selectedIds.has(p.id)),
    [personas, selectedIds],
  );

  const trimmedNotes = userNotes.trim();
  const notesArg = trimmedNotes.length > 0 ? trimmedNotes : undefined;

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function reload(): void {
    setPersonas(listPersonas());
  }

  function resetDraft(): void {
    setDraftName('');
    setDraftEmoji('');
    setDraftTagline('');
    setDraftPrompt('');
    setError(null);
  }

  function saveDraft(): void {
    const name = draftName.trim();
    const tagline = draftTagline.trim();
    const prompt = draftPrompt.trim();
    if (name.length === 0) {
      setError('Name is required.');
      return;
    }
    if (prompt.length < 20) {
      setError('Prompt should be at least 20 characters — describe the perspective in a sentence or two.');
      return;
    }
    const emoji = draftEmoji.trim();
    const created = createPersona({
      name,
      tagline,
      prompt,
      ...(emoji ? { emoji } : {}),
    });
    reload();
    resetDraft();
    setCreating(false);
    if (multiSelect) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.add(created.id);
        return next;
      });
    } else {
      onPick(created, undefined, notesArg);
    }
  }

  function handleCardClick(persona: Persona): void {
    if (!multiSelect) {
      onPick(persona, undefined, notesArg);
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(persona.id)) {
        next.delete(persona.id);
      } else {
        next.add(persona.id);
      }
      return next;
    });
  }

  function handleConfirm(): void {
    if (!multiSelect || selectedPersonas.length === 0) return;
    if (onConfirm) {
      onConfirm(selectedPersonas, undefined, notesArg);
    } else {
      // Backwards-compat fallback: emit each pick individually.
      for (const p of selectedPersonas) onPick(p, undefined, notesArg);
    }
  }

  function removeCustom(id: string): void {
    deletePersona(id);
    reload();
  }

  return (
    <div className="kb-modal-scrim kb-app" onClick={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal sm" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <h2>{title ?? 'Pick a perspective'}</h2>
          <span className="grow" />
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body" style={{ display: 'block', overflowY: 'auto' }}>
          <div style={{ padding: '18px 22px' }}>
            <div style={{ marginBottom: 16, color: 'var(--ink-2)', fontSize: 12.5 }}>
              {subtitle ??
                'Choose a perspective for your coordinator to explore. It will review existing work and bring useful suggestions onto the board.'}
            </div>

            <p style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>
              Your coordinator delegates this review using automatic provider routing.
            </p>

            <div className="kb-field" style={{ marginBottom: 16 }}>
              <label className="kb-field-label" htmlFor="kb-suggest-notes">
                Notes (optional) — narrow the suggestion to a topic, area, or constraint
              </label>
              <textarea
                id="kb-suggest-notes"
                className="kb-textarea"
                placeholder="e.g. focus on the onboarding flow, only API/server-side changes, must be doable in a single PR…"
                value={userNotes}
                onChange={(e) => setUserNotes(e.target.value)}
                rows={3}
                maxLength={4000}
                style={{ fontSize: 12.5 }}
              />
            </div>

            <div className="kb-persona-grid">
              {personas.map((p) => {
                const isSelected = multiSelect && selectedIds.has(p.id);
                return (
                <button
                  key={p.id}
                  type="button"
                  className={`kb-persona-card${isSelected ? ' selected' : ''}`}
                  onClick={() => handleCardClick(p)}
                  title={p.prompt}
                  aria-pressed={multiSelect ? isSelected : undefined}
                >
                  <div className="kb-persona-emoji" aria-hidden>
                    {p.emoji}
                  </div>
                  <div className="kb-persona-name">{p.name}</div>
                  <div className="kb-persona-tagline">{p.tagline}</div>
                  {multiSelect && isSelected ? (
                    <span
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 10,
                        fontSize: 11,
                        color: 'var(--accent)',
                      }}
                      aria-hidden
                    >
                      ✓
                    </span>
                  ) : null}
                  {!p.builtIn ? (
                    <span
                      className="kb-persona-del"
                      role="button"
                      aria-label={`Delete ${p.name}`}
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeCustom(p.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          e.preventDefault();
                          removeCustom(p.id);
                        }
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </button>
                );
              })}

              {!creating ? (
                <button
                  type="button"
                  className="kb-persona-card kb-persona-card-add"
                  onClick={() => {
                    setCreating(true);
                    setError(null);
                  }}
                >
                  <div className="kb-persona-emoji" aria-hidden>
                    +
                  </div>
                  <div className="kb-persona-name">New persona</div>
                  <div className="kb-persona-tagline">Define your own perspective</div>
                </button>
              ) : null}
            </div>

            {creating ? (
              <div className="kb-persona-create">
                <div className="kb-persona-create-row">
                  <div style={{ flex: '0 0 64px' }}>
                    <label className="kb-field-label">Emoji</label>
                    <input
                      className="kb-input"
                      placeholder="✨"
                      maxLength={4}
                      value={draftEmoji}
                      onChange={(e) => setDraftEmoji(e.target.value)}
                      style={{ textAlign: 'center', fontSize: 16 }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="kb-field-label">Name</label>
                    <input
                      className="kb-input"
                      placeholder="e.g. Indie hacker"
                      maxLength={60}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>

                <div className="kb-field" style={{ marginTop: 10 }}>
                  <label className="kb-field-label">Tagline</label>
                  <input
                    className="kb-input"
                    placeholder="One short line — what they care about"
                    maxLength={80}
                    value={draftTagline}
                    onChange={(e) => setDraftTagline(e.target.value)}
                  />
                </div>

                <div className="kb-field" style={{ marginTop: 10 }}>
                  <label className="kb-field-label">Prompt</label>
                  <textarea
                    className="kb-textarea"
                    placeholder='"You are a ____ who prioritizes ____. You think in terms of ____. You frame proposals around ____."'
                    value={draftPrompt}
                    onChange={(e) => setDraftPrompt(e.target.value)}
                    rows={5}
                    style={{ fontSize: 12.5 }}
                  />
                  <div className="kb-field-hint" style={{ marginTop: 4 }}>
                    Guides the worker reviewing your project from this perspective.
                  </div>
                </div>

                {error ? (
                  <div className="composer-error" role="alert" style={{ marginTop: 8 }}>
                    {error}
                  </div>
                ) : null}

                <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="kb-btn ghost"
                    onClick={() => {
                      setCreating(false);
                      resetDraft();
                    }}
                  >
                    Cancel
                  </button>
                  <button type="button" className="kb-btn primary" onClick={saveDraft}>
                    Save and use
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="kb-modal-foot">
          <span className="hint">
            Custom personas are stored locally on this machine.
          </span>
          <span className="grow" />
          <button type="button" className="kb-btn ghost" onClick={onClose}>
            Cancel
          </button>
          {multiSelect ? (
            <button
              type="button"
              className="kb-btn primary"
              disabled={selectedPersonas.length === 0}
              onClick={handleConfirm}
              style={{ marginLeft: 8 }}
            >
              {multiSelectConfirmLabel ??
                `Use ${selectedPersonas.length} persona${selectedPersonas.length === 1 ? '' : 's'}`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
