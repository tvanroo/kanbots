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
  explanationPending?: boolean;
  originBusy?: boolean;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function QuestionsQueue({ inline = false }: { inline?: boolean }) {
  const [items, setItems] = useState<Question[]>([]);
  const [open, setOpen] = useState(inline);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [receipt, setReceipt] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState<Record<number, 'sending' | 'slow'>>({});
  const sendingQuestions = useRef(new Map<number, { questionId: number }>());
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
      for (const [questionId, delivery] of sendingQuestions.current) {
        if (questions.some(question => question.id === delivery.questionId && !question.explanationPending)) continue;
        // Authoritative refresh confirms this question has left the queue.
        // Release a lost IPC wait without replaying the answer.
        sendingQuestions.current.delete(questionId);
        setSending(current => {
          const next = { ...current };
          delete next[questionId];
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
    const { id } = question;
    if (!action || question.state !== 'pending' || sendingQuestions.current.has(id)) return;
    if (!explain && !reply?.trim()) return;
    const delivery = { questionId: id };
    sendingQuestions.current.set(id, delivery);
    setSending(current => ({ ...current, [id]: 'sending' }));
    setErrors(current => ({ ...current, [id]: '' }));
    const timer = setTimeout(() => {
      if (sendingQuestions.current.get(id) === delivery) {
        setSending(current => ({ ...current, [id]: 'slow' }));
      }
    }, 8000);
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        action('question-reply', { id, reply, explain }),
        new Promise<never>((_, reject) => {
          responseTimer = setTimeout(() => reject(new Error('The save confirmation did not arrive. Refresh questions to check. Retrying the same answer is safe.')), 8000);
        }),
      ]);
      setReceipt(explain ? 'Explanation requested from your coordinator. You can keep answering questions.' : 'Answer saved and queued for your coordinator.');
      if (!explain) {
        setItems(current => current.filter(item => item.id !== id));
        setDrafts(current => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    } catch (error) {
      if (sendingQuestions.current.get(id) === delivery) {
        setErrors(current => ({ ...current, [id]: errorMessage(error) }));
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(responseTimer);
      if (sendingQuestions.current.get(id) === delivery) {
        sendingQuestions.current.delete(id);
        setSending(current => {
          const next = { ...current };
          delete next[id];
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
      <p>Answers are saved for your current coordinator, with the original question and thread attached. You can reply while workers are busy.</p>
      {receipt && <p role="status">{receipt}</p>}
      {refreshError && <p role="alert">Couldn’t refresh questions. {refreshError}</p>}
      {!items.length && !refreshError && <p>{refreshing ? 'Checking for questions…' : 'No unanswered questions.'}</p>}
      {items.map(question => {
        const { id, threadId } = question;
        const submitting = sending[id];
        const disabled = Boolean(submitting) || question.state !== 'pending';
        const status = submitting === 'slow'
          ? 'Checking whether your response was saved. Refresh questions to recover; other questions remain available.'
          : submitting || question.state === 'sending'
            ? 'Sending a response to this thread…'
            : question.explanationPending ? 'Your coordinator is preparing an explanation. You can still answer below.' : question.originBusy ? 'The original worker is busy. Your answer will be saved for your coordinator.' : null;
        return <article key={id}>
          <small>Thread {threadId} · Run {question.runId}</small>
          <h4>{question.question}</h4>
          <div className="kb-coordinator-actions">
            {question.options.map(option => <button className="kb-btn" key={option.value} disabled={disabled}
              onClick={() => void respond(question, option.label)}>{option.label}</button>)}
            <button className="kb-btn ghost" disabled={disabled || question.explanationPending}
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
