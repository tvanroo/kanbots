import { getBridge } from '../../desktop-bridge.js';
import { Logo } from '../Logo.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { listPersonas, type Persona } from '../../personas.js';
import { ModelPicker, type ModelPickerValue } from '../forms/ModelPicker.js';

export interface AutopilotLaunchModalProps {
  onClose: () => void;
  onStarted?: (result: { sessionId: number; issueNumber: number }) => void;
}

type Tab = 'feature-dev' | 'qa';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Parallelism = 1 | 2 | 3 | 4;

const PARALLELISM_OPTIONS: Parallelism[] = [1, 2, 3, 4];

export function AutopilotLaunchModal({ onClose, onStarted }: AutopilotLaunchModalProps) {
  const bridge=getBridge();const coordinated=!!bridge?.coordinatorAction;
  const [coordinator,setCoordinator]=useState<any>(null);
  useEffect(()=>{let live=true;const refresh=()=>void bridge?.coordinatorState?.().then(s=>{if(live)setCoordinator(s);}).catch(()=>{});refresh();const timer=setInterval(refresh,2000);return()=>{live=false;clearInterval(timer);};},[]);
  const openCoordinator=()=>{onClose();window.dispatchEvent(new CustomEvent('kanbots:open-coordinator'));};
  async function control(action:string){setSubmitting(true);setError(null);setNotice(null);try{setCoordinator(await bridge?.coordinatorAction?.('autopilot',{action}));}catch(e){setError(String(e));}finally{setSubmitting(false);}}
  const [tab, setTab] = useState<Tab>('feature-dev');
  const [personas, setPersonas] = useState<Persona[]>(() => listPersonas());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [modelSelection, setModelSelection] = useState<ModelPickerValue | null>(null);
  const [effort, setEffort] = useState<Effort>('medium');
  const [parallelism, setParallelism] = useState<Parallelism>(1);
  const [submitting, setSubmitting] = useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [error, setError] = useState<string | null>(null);

  const restoredSettings=useRef<string|null>(null);
  useEffect(()=>{
    const workspace=coordinator?.workspace;
    if(!workspace||restoredSettings.current===workspace.workspaceId)return;
    restoredSettings.current=workspace.workspaceId;
    const saved=workspace.autopilot;
    if(!saved)return;
    setSelectedIds(new Set(saved.personas.map((p:Persona)=>p.id)));
    setPersonas(current=>[...current.filter(p=>!saved.personas.some((s:Persona)=>s.id===p.id)),...saved.personas.map((p:Persona)=>({...current.find(c=>c.id===p.id),...p}))]);
    setEffort(saved.effort);setParallelism(saved.parallelism);
    setTab(saved.personas.length===1&&saved.personas[0].id==='qa'?'qa':'feature-dev');
  },[coordinator]);

  const selected = useMemo(
    () => personas.filter((p) => selectedIds.has(p.id)),
    [personas, selectedIds],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  function refreshPersonas(): void {
    setPersonas(listPersonas());
  }

  function toggle(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function start(): Promise<void> {
    if (tab !== 'feature-dev'&&!coordinated) return;
    if ((tab==='feature-dev'&&selected.length === 0) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if(coordinated){
        setCoordinator(await bridge!.coordinatorAction!('autopilot',{action:coordinator?.workspace?.autopilot?(coordinator.workspace.autopilot.status==='active'?'update':'resume'):'start',personas:tab==='qa'?[{id:'qa',name:'QA reviewer',prompt:'Assess the current project against its acceptance criteria. Delegate independent checks, collect reproducible evidence, file defects without automatically implementing them, and report findings through the coordinator.'}]:selected.map(p=>({id:p.id,name:p.name,prompt:p.prompt})),effort,parallelism,...(tab==='qa'?{objective:'Complete a QA assessment of the current project and deliver findings. End this assignment when the assessment is delivered.'}:{objective:coordinator?.workspace?.autopilot?.personas?.[0]?.id!=='qa'&&coordinator?.workspace?.autopilot?.objective||'Continuously discover and deliver useful improvements within the project scope.'})}));
        setNotice('Settings saved. Autopilot is On.');return;
      }
      const result = await api.startAutopilot({
        kind: 'feature-dev',
        config: {
          kind: 'feature-dev',
          personas: selected.map((p) => ({ id: p.id, name: p.name, prompt: p.prompt })),
          ...(modelSelection
            ? { model: modelSelection.model, provider: modelSelection.provider }
            : {}),
          effort,
          parallelism,
        },
      });
      onStarted?.(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="kb-modal-scrim kb-app" onClick={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal sm" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <h2>Autopilot</h2>
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
          <div style={{ padding: '14px 22px 0' }}>
            <div className="kb-tdm-tabs" style={{ marginBottom: 18 }}>
              <button
                type="button"
                className={`kb-tdm-tab${tab === 'feature-dev' ? ' active' : ''}`}
                onClick={() => setTab('feature-dev')}
              >
                Feature dev
              </button>
              <button
                type="button"
                className={`kb-tdm-tab${tab === 'qa' ? ' active' : ''}`}
                onClick={() => setTab('qa')}
              >
                QA {!coordinated?<span style={{ color: 'var(--ink-4)', fontSize: 10, marginLeft: 6 }}>soon</span>:null}
              </button>
            </div>
          </div>

          {coordinated?<div style={{padding:'16px 22px',color:'var(--ink-2)'}}><strong>Managed by your {coordinator?.workspace?.mode==='external'?'external':'built-in'} coordinator</strong><p>Discovery, implementation and QA use automatic routing. Your coordinator chooses the next work and reports here or in your connected harness.</p>{coordinator?.workspace?.autopilot?<div><p>{coordinator.workspace.autopilot.label ?? coordinator.workspace.autopilot.status} · {coordinator.workspace.autopilot.personas.map((p:any)=>p.name).join(', ')}</p><button className="kb-btn" disabled={submitting} onClick={()=>void (coordinator.workspace.autopilot.status==='active'?control('pause'):start())}>{coordinator.workspace.autopilot.status==='active'?'Turn Off':'Turn On'}</button> <button className="kb-btn" disabled={submitting} onClick={()=>void control('complete')}>End assignment</button> <button className="kb-btn" onClick={openCoordinator}>Open coordinator</button><p>Off stops new assignments. Existing work finishes; review and release remain available.</p>{coordinator.workspace.autopilot.remaining>0&&coordinator.workspace.autopilot.status!=='active'?<button className="kb-btn" disabled={submitting} onClick={()=>void control('expedite')}>Expedite wind-down</button>:null}{coordinator.workspace.autopilot.workers?.filter((worker:any)=>worker.active||worker.checkpoint)?.map((worker:any)=><div key={worker.runId} style={{marginTop:10}}>Task #{worker.number} · Run {worker.runId} · {worker.state}{worker.active?<button className="kb-btn ghost" onClick={async()=>{if(!window.confirm('Stop this worker now? Available work is preserved, but recovery may be needed.'))return;try{setCoordinator(await bridge?.coordinatorAction?.('stop-wind-down-worker',{runId:worker.runId}));}catch(e){setError(String(e));}}}>Stop now</button>:null}{worker.checkpoint?<p>{worker.checkpoint.summary} {worker.checkpoint.remainingValidation}</p>:null}</div>)}</div>:null}</div>:null}
          {coordinated&&coordinator?.workspace?.autopilot?<div role="status" aria-live="polite" style={{padding:'12px 22px',color:'var(--ink-2)'}}>
            {notice?<strong>{notice}</strong>:null}
            {(()=>{const request=coordinator.workspace.requests?.find((r:any)=>r.kind==='autopilot');return <p>{request?.error?`Could not notify the coordinator: ${request.error}. Use Apply settings or Start Autopilot to retry.`:request?.state==='queued'?(coordinator.workspace.mode==='external'?'Waiting for your external coordinator to check in. Settings are saved; no new workers have been started by this request yet.':'Waiting for the built-in coordinator. It will apply these settings when its current turn finishes.'):request?.state==='received'?'Your coordinator received the settings and is managing the assignment.':'Settings are saved. Your coordinator manages assignments and reports progress.'}</p>;})()}
            <button className="kb-btn ghost" onClick={openCoordinator}>View coordinator</button>
          </div>:null}
          <div style={{ padding: '0 22px 18px' }}>
            {tab === 'feature-dev' ? (
              <FeatureDevTab
                personas={personas}
                selectedIds={selectedIds}
                onToggle={toggle}
                onPersonasChanged={refreshPersonas}
                coordinated={coordinated}
                modelSelection={modelSelection}
                onModelChange={setModelSelection}
                effort={effort}
                onEffortChange={setEffort}
                parallelism={parallelism}
                onParallelismChange={setParallelism}
              />
            ) : (
              coordinated?<div><h3>Coordinator-led QA</h3><p>Your coordinator delegates independent checks, tracks defects and reports findings in your existing harness. Checks follow the project workflow.</p></div>:<QaComingSoon />
            )}
          </div>
        </div>

        <div className="kb-modal-foot">
          {tab === 'feature-dev' ? (
            <span className="hint">
              {selected.length === 0
                ? 'Pick one or more personas.'
                : `Round-robin across ${selected.length} persona${selected.length === 1 ? '' : 's'} · ${parallelism} in parallel · ${effort} effort · ${coordinated?'automatic routing':modelSelection?.model ?? 'default model'}. Runs until you stop it.`}
            </span>
          ) : null}
          <span className="grow" />
          {error ? (
            <span style={{ color: 'var(--failed)', fontSize: 11, marginRight: 8 }}>{error}</span>
          ) : null}
          <button
            type="button"
            className="kb-btn ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          {tab === 'feature-dev'||coordinated ? (
            <button
              type="button"
              className="kb-btn primary"
              disabled={(tab==='feature-dev'&&selected.length === 0) || submitting || (coordinated&&!coordinator)}
              onClick={() => void start()}
              style={{ marginLeft: 8 }}
            >
              {submitting
                ? 'Starting…'
                : coordinated?(coordinator?.workspace?.autopilot?.status==='active'?'Apply settings':'Start Autopilot'):`Start autopilot${selected.length > 0 ? ` (${selected.length})` : ''}`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FeatureDevTab({
  personas,
  selectedIds,
  onToggle,
  onPersonasChanged,
  coordinated,
  modelSelection,
  onModelChange,
  effort,
  onEffortChange,
  parallelism,
  onParallelismChange,
}: {
  personas: Persona[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onPersonasChanged: () => void;
  coordinated: boolean;
  modelSelection: ModelPickerValue | null;
  onModelChange: (m: ModelPickerValue) => void;
  effort: Effort;
  onEffortChange: (e: Effort) => void;
  parallelism: Parallelism;
  onParallelismChange: (p: Parallelism) => void;
}) {
  return (
    <>
      <div style={{ color: 'var(--ink-2)', fontSize: 12.5, marginBottom: 12 }}>
        Pick perspectives for discovering improvements. Your coordinator prioritizes useful proposals, delegates work, and keeps you informed.
      </div>
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}
      >
        {coordinated?<span className="kb-pill-select">Automatic routing · subscriptions, grants and allowed API capacity</span>:<label className="kb-pill-select">
          <span className="lbl">model</span>
          <ModelPicker
            value={modelSelection}
            onChange={onModelChange}
            agentRunsOnly
            className="kb-pill-select-native mono"
          />
          <span className="caret">▾</span>
        </label>}
        <label className="kb-pill-select">
          <span className="lbl">effort</span>
          <select
            value={effort}
            onChange={(e) => onEffortChange(e.target.value as Effort)}
            className="kb-pill-select-native mono"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
          <span className="caret">▾</span>
        </label>
        <label className="kb-pill-select" title="How many child tasks run at once">
          <span className="lbl">parallel</span>
          <select
            value={parallelism}
            onChange={(e) => onParallelismChange(Number(e.target.value) as Parallelism)}
            className="kb-pill-select-native mono"
          >
            {PARALLELISM_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="caret">▾</span>
        </label>
      </div>
      <div className="kb-persona-grid">
        {personas.map((p) => {
          const isSelected = selectedIds.has(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className={`kb-persona-card${isSelected ? ' selected' : ''}`}
              onClick={() => onToggle(p.id)}
              title={p.prompt}
              aria-pressed={isSelected}
            >
              <div className="kb-persona-emoji" aria-hidden>
                {p.emoji}
              </div>
              <div className="kb-persona-name">{p.name}</div>
              <div className="kb-persona-tagline">{p.tagline}</div>
              {isSelected ? (
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
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-3)' }}>
        Need a different perspective?{' '}
        <button
          type="button"
          className="kb-btn ghost"
          style={{ padding: '2px 8px', fontSize: 11 }}
          onClick={onPersonasChanged}
        >
          Refresh personas
        </button>{' '}
        — create custom ones from the Suggest feature flow on the Backlog column.
      </div>
    </>
  );
}

function QaComingSoon() {
  return (
    <div
      style={{
        padding: '24px 16px',
        textAlign: 'center',
        color: 'var(--ink-3)',
        fontSize: 12.5,
        border: '1px dashed var(--hairline)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 14, color: 'var(--ink-2)', marginBottom: 6 }}>
        QA autopilot — coming soon
      </div>
      <div>
        Will run code-level checks (typecheck/tests/lint/build) and live UI testing against this workspace,
        filing a bug ticket and dispatching an agent for each failure it finds.
      </div>
    </div>
  );
}
