import {useEffect,useState,type ReactNode} from 'react';
import {getBridge} from '../../desktop-bridge.js';
import {CoordinatorsModal} from '../modals/CoordinatorsModal.js';
import {ProvidersSettingsModal} from '../modals/ProvidersSettingsModal.js';
import {AutopilotLaunchModal} from '../modals/AutopilotLaunchModal.js';
import {WorkflowEditor} from '../modals/WorkflowEditor.js';
import {QuestionsQueue} from '../QuestionsQueue.js';
import {ActivitySection} from '../rail/ActivitySection.js';
import './workspace-navigation.css';
import {PersonaPickerModal} from '../modals/PersonaPickerModal.js';
import {SecretVaultPanel} from '../SecretVaultPanel.js';
type Destination='Board'|'Coordinator'|'Questions'|'Activity'|'Development'|'Providers'|'Autopilot'|'Settings';
export function WorkspaceNavigation({board,development,project,onTask,settings}:{board:ReactNode;development:ReactNode;project:string;onTask:(n:number)=>void;settings:Array<{name:string;description:string;open:()=>void}>}){
 const [view,setView]=useState<Destination>('Board');const [count,setCount]=useState(0);const [controller,setController]=useState('Checking coordinator…');
 useEffect(()=>{let alive=true;const refresh=async()=>{try{const b=getBridge();const [q,s]=await Promise.all([b?.coordinatorAction?.('questions-list'),b?.coordinatorState?.()]);if(!alive)return;setCount(q?.length??0);const w=s?.workspace;setController(w?.mode==='internal'?'KanBorg chat':s?.clients?.find((c:any)=>c.id===w?.controller)?.name??'Project coordinator');}catch{if(alive)setController('Connection unavailable');}};void refresh();const t=setInterval(refresh,5000);const open=()=>setView('Coordinator');window.addEventListener('kanbots:open-coordinator',open);return()=>{alive=false;clearInterval(t);window.removeEventListener('kanbots:open-coordinator',open);};},[]);
 const [personasOpen,setPersonasOpen]=useState(false);
 const [workflowOpen,setWorkflowOpen]=useState(false);
 const [visited,setVisited]=useState<Set<Destination>>(new Set(['Board']));
 useEffect(()=>setVisited(v=>new Set([...v,view])),[view]);
 const back=()=>setView('Board');
 return <div className="workspace-layout"><nav className="workspace-navigation" aria-label="Workspace navigation"><strong className="workspace-brand">◈ KanBorg</strong><button className="workspace-project" onClick={()=>settings.find(s=>s.name==='Projects')?.open()}>{project} ▾</button><div className="workspace-destinations">{(['Board','Coordinator','Questions','Activity','Development'] as Destination[]).map(v=><button key={v} aria-current={view===v?'page':undefined} onClick={()=>setView(v)}>{v}{v==='Questions'&&count>0?<span className="workspace-count">{count}</span>:null}</button>)}</div><div className="workspace-destinations workspace-bottom">{(['Autopilot','Providers','Settings'] as Destination[]).map(v=><button key={v} aria-current={view===v?'page':undefined} onClick={()=>setView(v)}>{v}</button>)}</div><button className="workspace-controller" onClick={()=>setView('Coordinator')}>{controller}</button></nav><main className="workspace-main" aria-label={view}>
 <div className="workspace-board-host" hidden={view!=='Board'}>{board}</div>
 {visited.has('Coordinator')?<div className="workspace-surface" hidden={view!=='Coordinator'}><CoordinatorsModal onClose={back}/></div>:null}
 {view==='Providers'?<div className="workspace-surface"><ProvidersSettingsModal onClose={back}/></div>:null}
 {view==='Autopilot'?<div className="workspace-surface"><AutopilotLaunchModal onClose={back}/></div>:null}
 {view==='Questions'?<QuestionsQueue inline/>:null}
 {view==='Activity'?<section className="workspace-page"><h1>Activity</h1><p>Recent worker events. Open an event to inspect the task and its evidence.</p><ActivitySection onSelectIssue={onTask}/></section>:null}
 {view==='Development'?<section className="workspace-page"><h1>Development</h1><p>Files, worktrees, live agents and saved chats.</p><div className="workspace-development">{development}</div></section>:null}
 {view==='Settings'?<section className="workspace-page"><h1>Settings</h1><p>Configure your project and how work moves forward.</p><div className="workspace-settings-grid"><button onClick={()=>setPersonasOpen(true)}><strong>Personas</strong><span>Edit workspace prompts and stage assignments</span><span>Open →</span></button>{settings.map(s=><button key={s.name} onClick={s.name==='Workflow'?()=>setWorkflowOpen(true):s.open}><strong>{s.name}</strong><span>{s.description}</span><span>Open →</span></button>)}</div><SecretVaultPanel/></section>:null}
 {personasOpen?<PersonaPickerModal manageOnly title="Workspace personas" subtitle="Edit names and instructions. Changes apply to future assignments; running agents keep their current prompt." onClose={()=>setPersonasOpen(false)} onPick={()=>{}}/>:null}
 {workflowOpen?<WorkflowEditor onClose={()=>setWorkflowOpen(false)}/>:null}</main></div>;
}
