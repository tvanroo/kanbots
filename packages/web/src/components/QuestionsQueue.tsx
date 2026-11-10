import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from '../desktop-bridge.js';
import { renderMarkdown } from '../lib/markdown.js';

type Question = {
  id: number;
  threadId: number;
  runId: number;
  question: string;
  options: Array<{ value: string; label: string }>;
  state: string;
  busy: boolean;
  explanation?: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function QuestionsQueue({ inline = false }: { inline?: boolean }) {
  const [items, setItems] = useState<Question[]>([]);
  const [open, setOpen] = useState(inline);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState<Record<number, 'sending' | 'slow'>>({});
  const sendingThreads = useRef(new Map<number, { questionId: number }>());
  const refreshSequence = useRef(0);
  const refreshPending = useRef(false);
  const action = getBridge()?.coordinatorAction;

  const refresh = useCallback(async (replacePending = false) => {
    if (!action || (refreshPending.current && !replacePending)) return;
    const sequence = ++refreshSequence.current;
    refreshPending.current = true;
    setRefreshing(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rows = await Promise.race([
        action('questions-list'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('KanBorg did not respond in time.')), 8000);
        }),
      ]);
      if (sequence !== refreshSequence.current) return;
      const questions: Question[] = rows ?? [];
      for (const [threadId, delivery] of sendingThreads.current) {
        if (questions.some(question => question.id === delivery.questionId)) continue;
        // Authoritative refresh confirms this question has left the queue.
        // Release a lost IPC wait without replaying the answer.
        sendingThreads.current.delete(threadId);
        setSending(current => {
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      }
      setItems(questions);
      setRefreshError('');
    } catch (error) {
      if (sequence === refreshSequence.current) setRefreshError(errorMessage(error));
    } finally {
      clearTimeout(timer);
      if (sequence === refreshSequence.current) {
        refreshPending.current = false;
        setRefreshing(false);
      }
    }
  }, [action]);

  useEffect(() => {
    if (!action) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      clearInterval(timer);
      ++refreshSequence.current;
      refreshPending.current = false;
    };
  }, [action, refresh]);

  async function respond(question: Question, reply?: string, explain = false) {
    const { id, threadId } = question;
    if (!action || question.busy || question.state !== 'pending' || sendingThreads.current.has(threadId)) return;
    if (!explain && !reply?.trim()) return;
    const delivery = { questionId: id };
    sendingThreads.current.set(threadId, delivery);
    setSending(current => ({ ...current, [threadId]: 'sending' }));
    setErrors(current => ({ ...current, [id]: '' }));
    const timer = setTimeout(() => {
      if (sendingThreads.current.get(threadId) === delivery) {
        setSending(current => ({ ...current, [threadId]: 'slow' }));
      }
    }, 8000);
    try {
      await action('question-reply', { id, reply, explain });
      if (!explain) {
        setItems(current => current.filter(item => item.id !== id));
        setDrafts(current => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    } catch (error) {
      if (sendingThreads.current.get(threadId) === delivery) {
        setErrors(current => ({ ...current, [id]: errorMessage(error) }));
      }
    } finally {
      clearTimeout(timer);
      if (sendingThreads.current.get(threadId) === delivery) {
        sendingThreads.current.delete(threadId);
        setSending(current => {
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      }
      // Refresh independently. A delayed list request cannot keep answers locked.
      void refresh(true);
    }
  }

  if (!action) return null;
  return <>
    {!inline && <button className="kb-btn kb-questions-launch" onClick={() => setOpen(!open)}>
      Questions for you · {items.length}
    </button>}
    {open && <aside className="kb-questions-panel" aria-label="Questions for you">
      <header>
        <h3>Questions for you</h3>
        <div className="kb-coordinator-actions">
          <button className="kb-btn ghost" onClick={() => void refresh(true)}>
            {refreshing ? 'Refreshing…' : 'Refresh questions'}
          </button>
          {!inline && <button className="kb-btn ghost" onClick={() => setOpen(false)}>Close</button>}
        </div>
      </header>
      <p>Answers return to the thread that asked. Questions stay here until answered.</p>
      {refreshError && <p role="alert">Couldn’t refresh questions. {refreshError}</p>}
      {!items.length && !refreshError && <p>{refreshing ? 'Checking for questions…' : 'No unanswered questions.'}</p>}
      {items.map(question => {
        const { id, threadId } = question;
        const submitting = sending[threadId];
        const disabled = Boolean(submitting) || question.busy || question.state !== 'pending';
        const status = submitting === 'slow'
          ? 'This response is taking longer than usual. You can refresh or answer questions from other threads.'
          : submitting || question.state === 'sending'
            ? 'Sending a response to this thread…'
            : question.busy ? 'This thread is responding…' : null;
        return <article key={id}>
          <small>Thread {threadId} · Run {question.runId}</small>
          <h4>{question.question}</h4>
          <div className="kb-coordinator-actions">
            {question.options.map(option => <button className="kb-btn" key={option.value} disabled={disabled}
              onClick={() => void respond(question, option.label)}>{option.label}</button>)}
            <button className="kb-btn ghost" disabled={disabled}
              onClick={() => void respond(question, undefined, true)}>Tell me more</button>
          </div>
          {status && <p role="status">{status}</p>}
          {errors[id] && <p role="alert">{errors[id]}</p>}
          {question.explanation && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(question.explanation) }} />}
          <form onSubmit={event => { event.preventDefault(); void respond(question, drafts[id]); }}>
            <textarea aria-label={`Reply to: ${question.question}`} placeholder="Or answer in your own words…"
              className="kb-coordinator-input" maxLength={4000} value={drafts[id] ?? ''}
              onChange={event => setDrafts(current => ({ ...current, [id]: event.target.value }))} />
            <button className="kb-btn primary" disabled={disabled || !drafts[id]?.trim()}>Send answer</button>
          </form>
        </article>;
      })}
    </aside>}
  </>;
}
