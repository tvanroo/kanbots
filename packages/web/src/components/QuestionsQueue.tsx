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
  issueNumber?: number;
  commands?: Array<{title:string;code:string;language:string;where:string;expected:string}>;
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
  const [context, setContext] = useState<any>(null);
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(false);
  const contextSequence = useRef(0);
  const [copied, setCopied] = useState('');
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

  async function openContext(id: number, runId?: number, offset = 0) {
    const sequence = ++contextSequence.current;
    setContextLoading(true); setContextError('');
    if (!offset) setContext({id, events:[], messages:[], runs:[]});
    try {
      const result = await action?.('question-context', {id, runId, offset});
      if (sequence !== contextSequence.current) return;
      setContext((old:any)=>({...result,id,events:offset?[...(old?.events??[]),...result.events]:result.events,messages:offset?old.messages:result.messages}));
    } catch(error) { if(sequence===contextSequence.current) setContextError(errorMessage(error)); }
    finally { if(sequence===contextSequence.current) setContextLoading(false); }
  }
  async function copyCommand(key: string, code: string) {
    try { await navigator.clipboard.writeText(code); setCopied(key); }
    catch { setReceipt('Could not copy. Select the snippet text and copy it manually.'); }
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
          <div className="kb-question-origin"><small>{question.issueNumber ? `Task #${question.issueNumber} · ` : ''}Thread {threadId} · Run {question.runId}</small>
            <a href={`#question-${id}-conversation`} onClick={event=>{event.preventDefault();void openContext(id);}}>Open originating chat →</a></div>
          <h4>{question.question}</h4>
          {!question.commands?.length && /\b(command|snippet|script)\b/i.test(question.question) && <div className="kb-question-command"><strong>Command not attached yet</strong><p>Your coordinator needs to attach the exact snippet before you can run it.</p><button className="kb-btn" disabled={disabled||question.explanationPending} onClick={()=>void respond(question,undefined,true)}>{question.explanationPending?'Retrieving instructions…':'Get the command and instructions'}</button></div>}
          {!!question.commands?.length && <section className="kb-question-commands" aria-label="Requested commands">{question.commands.map((command,index)=><div key={index} className="kb-question-command">
            <header><strong>{command.title}</strong><button className="kb-btn" onClick={()=>void copyCommand(`${id}:${index}`,command.code)}>{copied===`${id}:${index}`?'Copied ✓':'Copy command'}</button></header>
            <p><strong>Run in:</strong> {command.where}</p><pre tabIndex={0}><code>{command.code}</code></pre>
            <p><strong>Expected result:</strong> {command.expected}</p><small>Copying does not execute this command.</small>
          </div>)}</section>}
          <div className="kb-coordinator-actions">
            {question.options.map(option => <button className="kb-btn" key={option.value} disabled={disabled}
              onClick={() => void respond(question, option.label)}>{option.label}</button>)}
            <button className="kb-btn ghost" disabled={disabled || question.explanationPending}
              onClick={() => void respond(question, undefined, true)}>Tell me more</button>
          </div>
          {status && <p role="status">{status}</p>}
          {errors[id] && <p role="alert">{errors[id]}</p>}
          {question.explanation && <section className="kb-question-explanation" aria-label="Explanation"><h5>What this means</h5><div dangerouslySetInnerHTML={{ __html: renderMarkdown(question.explanation) }} /></section>}
          <form onSubmit={event => { event.preventDefault(); void respond(question, drafts[id]); }}>
            <textarea aria-label={`Reply to: ${question.question}`} placeholder="Or answer in your own words…"
              className="kb-coordinator-input" maxLength={4000} value={drafts[id] ?? ''}
              onChange={event => setDrafts(current => ({ ...current, [id]: event.target.value }))} />
            <button className="kb-btn primary" disabled={disabled || !drafts[id]?.trim()}>Send answer</button>
          </form>
        </article>;
      })}
    </aside>}
    {context && <div className="kb-question-context" role="dialog" aria-modal="true" aria-label="Originating conversation" onKeyDown={event=>{if(event.key==='Escape'){++contextSequence.current;setContext(null);}}}>
      <header><div><h3>Originating conversation</h3><small>Thread {context.threadId ?? '…'} · Run {context.runId ?? '…'}</small></div><button autoFocus className="kb-btn" onClick={()=>{++contextSequence.current;setContext(null);}}>Back to question</button></header>
      {contextError && <p role="alert">{contextError} <button className="kb-btn" onClick={()=>void openContext(context.id)}>Retry</button></p>}
      {!!context.runs?.length && <label>Run <select value={context.runId} onChange={event=>void openContext(context.id,Number(event.target.value))}>{context.runs.map((run:any)=><option key={run.id} value={run.id}>#{run.id} · {run.status}{run.id===items.find(q=>q.id===context.id)?.runId?' · asked this question':''}</option>)}</select></label>}
      <div className="kb-question-history">
      {context.messages?.map((message:any,index:number)=><article key={`message:${index}`}><strong>{message.role==='user'?'You':message.role}</strong><div dangerouslySetInnerHTML={{__html:renderMarkdown(message.body)}} /></article>)}
      {context.events?.map((event:any)=><article key={event.seq}>{event.type==='text'||event.type==='result'?<><small>Agent · event {event.seq}</small><div dangerouslySetInnerHTML={{__html:renderMarkdown(typeof event.payload?.text==='string'?event.payload.text:typeof event.payload?.result==='string'?event.payload.result:JSON.stringify(event.payload))}} /></>:<details><summary>{event.type} · event {event.seq}</summary><pre>{JSON.stringify(event.payload,null,2)}</pre></details>}</article>)}
      {contextLoading && <p role="status">Loading conversation…</p>}
      {!contextLoading && context.nextOffset != null && <button className="kb-btn" onClick={()=>void openContext(context.id,context.runId,context.nextOffset)}>Load more conversation</button>}
      </div>
    </div>}
  </>;
}
