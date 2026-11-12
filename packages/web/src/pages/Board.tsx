import {boardStatus} from '../components/board/board-status.js';
import '../styles/board-focus.css';
import { useWorkflow } from '../hooks/useWorkflow.js';
import { WorkflowEditor } from '../components/modals/WorkflowEditor.js';
import { getBridge } from '../desktop-bridge.js';
import {
  DndContext,
  closestCenter,
  pointerWithin,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { api } from '../api.js';
import { AutopilotLaunchModal } from '../components/modals/AutopilotLaunchModal.js';
import { BoardViewsModal } from '../components/modals/BoardViewsModal.js';
import { BoardErrorBanner } from '../components/board/BoardErrorBanner.js';
import { BoardFilters } from '../components/board/BoardFilters.js';
import { BoardToolbar } from '../components/board/BoardToolbar.js';
import { BoardUsageRow } from '../components/board/BoardUsageRow.js';
import { BulkActionBar, type BulkStatusTarget } from '../components/board/BulkActionBar.js';
import { CardPreview, type CardSelectModifiers } from '../components/Card.js';
import { Column, type SuggestActivity } from '../components/Column.js';
import { PersonaPickerModal } from '../components/modals/PersonaPickerModal.js';
import { useBoardAgentStreams } from '../hooks/useBoardAgentStreams.js';
import { useBoardViews, boardViewStateEqual } from '../hooks/useBoardViews.js';
import { useCardSelection } from '../hooks/useCardSelection.js';
import { useCloudBoardStreams } from '../hooks/useCloudBoardStreams.js';
import { getCloudCtx } from '../api.js';
import { useBoardFilters } from '../hooks/useBoardFilters.js';
import { useFetch } from '../hooks/useFetch.js';
import { useFocusedRepo } from '../hooks/useFocusedRepo.js';
import { useIssues, dispatchIssuesRefetch } from '../hooks/useIssues.js';
import { useSelection } from '../hooks/useSelection.js';
import { useWorkspace } from '../hooks/useWorkspace.js';
import { usePrefsStore, type BoardSortMode } from '../stores/usePrefsStore.js';
import { COLUMNS, priorityFromLabels, withStatus, type Priority } from '../labels.js';
import type { Persona } from '../personas.js';
import type { Issue, ProviderId, StatusKey } from '../types.js';

type SortMode = BoardSortMode;
const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

function sortIssues(issues: Issue[], mode: SortMode): Issue[] {
  if (mode === 'manual') return issues;
  const out = [...issues];
  if (mode === 'priority') {
    out.sort((a, b) => {
      const ap = priorityFromLabels(a.labels);
      const bp = priorityFromLabels(b.labels);
      const ar = ap === null ? 99 : PRIORITY_RANK[ap];
      const br = bp === null ? 99 : PRIORITY_RANK[bp];
      if (ar !== br) return ar - br;
      // Tiebreak on createdAt desc so newer items surface within the same priority.
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return out;
  }
  const field = mode === 'createdAt' ? 'createdAt' : 'updatedAt';
  out.sort((a, b) => new Date(b[field]).getTime() - new Date(a[field]).getTime());
  return out;
}

const STATUS_KEYS: readonly StatusKey[] = ['backlog', 'todo', 'inProgress', 'review', 'done'];

function issueNumberFromDragId(id: UniqueIdentifier): number | null {
  if (typeof id !== 'string' || !id.startsWith('card:')) return null;
  const n = Number.parseInt(id.slice(5), 10);
  return Number.isFinite(n) ? n : null;
}

function statusFromDropId(id: UniqueIdentifier): StatusKey | null | undefined {
  if (typeof id !== 'string' || !id.startsWith('col:')) return undefined;
  const rest = id.slice(4);
  if (rest === 'inbox') return null;
  return (STATUS_KEYS as readonly string[]).includes(rest) ? (rest as StatusKey) : undefined;
}

interface GroupedIssues {
  byKey: Record<StatusKey, Issue[]>;
  untagged: Issue[];
}

function groupByStatus(issues: Issue[]): GroupedIssues {
  const grouped: GroupedIssues = {
    byKey: { backlog: [], todo: [], inProgress: [], review: [], done: [] },
    untagged: [],
  };
  for (const issue of issues) {
    if (issue.status === null) {
      grouped.untagged.push(issue);
    } else {
      grouped.byKey[issue.status].push(issue);
    }
  }
  // Inbox order: unreviewed (no sentryMeta or sentryMeta.status === 'imported')
  // first, analyzed last. Manual entries treated as unreviewed since they
  // also need attention. Ties broken by createdAt desc.
  grouped.untagged.sort((a, b) => {
    const aReviewed = a.sentryMeta?.status === 'analyzed';
    const bReviewed = b.sentryMeta?.status === 'analyzed';
    if (aReviewed !== bReviewed) return aReviewed ? 1 : -1;
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    return bt - at;
  });
  return grouped;
}

export interface BoardProps {
  onOpenDetail?: (issueNumber: number) => void;
  onOpenCreate?: () => void;
  onOpenPalette?: () => void;
  /** Optional handler for the toolbar's workspace cost meter — typically
   *  opens the Stats & cost modal. Omit to render the meter as static. */
  onOpenStats?: () => void;
}

export function Board({ onOpenDetail, onOpenCreate, onOpenPalette, onOpenStats }: BoardProps = {}) {
  const { data: config } = useFetch('config', () => api.config());
  const { issues, loading, error, mutate } = useIssues();
  const { data: costToday, refetch: refetchCostToday } = useFetch('cost:today', () =>
    api.costToday(),
  );
  const { data: costUsage, refetch: refetchCostUsage } = useFetch('cost:usage', () =>
    api.costUsage(),
  );
  const workflow=useWorkflow(config?.repo);
  const [enabledStages, setEnabledStages] = useState<string[] | null>(null);
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [locateQuery,setLocateQuery]=useState('');
  const [locateRequest,setLocateRequest]=useState(0);
  const [locatedNumber,setLocatedNumber]=useState<number|null>(null);
  const [trackedByWorkspace, setTrackedByWorkspace] = useState<Record<string, number[]>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('kanborg:tracked-cards') ?? '{}');
      return Object.fromEntries(Object.entries(saved).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).filter((n): n is number => Number.isInteger(n) && Number(n) > 0)]));
    } catch { return {}; }
  });
  const [workflowEditor,setWorkflowEditor]=useState<number|null>(null);
  useEffect(()=>{const open=()=>setWorkflowEditor(0);window.addEventListener('kanborg:open-workflow',open);return()=>window.removeEventListener('kanborg:open-workflow',open);},[]);
  const workflowIssues:Issue[]=workflow?workflow.issues.map((i:Issue)=>{const card=workflow.cards[i.number];const stage=workflow.config.stages.find((s:any)=>s.id===card?.stageId);return stage?{...i,status:stage.category,state:stage.category==='done'?'closed':'open'}:i;}):issues;
  const filterApi = useBoardFilters(workflowIssues, !!workflow);
  const { focusedRepoId } = useFocusedRepo();
  const sortMode = usePrefsStore((s) => s.board.sortMode);
  const setSortMode = usePrefsStore((s) => s.setBoardSortMode);

  // Poll the usage meters (claude.ai OAuth windows) once a minute — the
  // backend caches /usage for 60s anyway, so polling faster just thrashes
  // the renderer. The workspace cost rollup (`cost:today`) refreshes on a
  // tighter 30s cadence so the toolbar meter feels responsive as agent
  // runs accumulate spend. Both pause when the tab is hidden so a
  // background window doesn't burn requests.
  useEffect(() => {
    let cancelled = false;
    function tickUsage(): void {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        void refetchCostUsage();
      }
    }
    function tickToday(): void {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        void refetchCostToday();
      }
    }
    const usageId = window.setInterval(tickUsage, 60_000);
    const todayId = window.setInterval(tickToday, 30_000);
    function onVisibility(): void {
      if (!document.hidden) {
        tickUsage();
        tickToday();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(usageId);
      window.clearInterval(todayId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refetchCostUsage, refetchCostToday]);

  const [activeNumber, setActiveNumber] = useState<number | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestActivity, setSuggestActivity] = useState<SuggestActivity[]>([]);
  const [suggestStartedAt, setSuggestStartedAt] = useState<string | null>(null);
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
  const [autopilotLaunchOpen, setAutopilotLaunchOpen] = useState(false);
  const [selectedNumber, setSelectedNumber] = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [manageViewsOpen, setManageViewsOpen] = useState(false);
  const cardSelection = useCardSelection();
  const workspaceMeta = useWorkspace();
  const viewsApi = useBoardViews(workspaceMeta.workspace.id);
  const trackedNumbers = new Set(trackedByWorkspace[workspaceMeta.workspace.id] ?? []);
  const toggleTracked = (number: number) => setTrackedByWorkspace(current => {
    const selected = new Set(current[workspaceMeta.workspace.id] ?? []);
    if (selected.has(number)) selected.delete(number); else selected.add(number);
    return {...current, [workspaceMeta.workspace.id]: [...selected]};
  });
  useEffect(() => { try { localStorage.setItem('kanborg:tracked-cards', JSON.stringify(trackedByWorkspace)); } catch { setMoveError('Tracked cards could not be saved on this device.'); } }, [trackedByWorkspace]);
  useEffect(() => { setLocatedNumber(null); setLocateQuery(''); }, [workspaceMeta.workspace.id]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const locatedIssue=workflowIssues.find(i=>i.number===locatedNumber);
  const locatedStage=locatedNumber!==null?workflow?.cards[locatedNumber]?.stageId:undefined;
  const trackedStages = new Set(workflowIssues.filter(i => trackedNumbers.has(i.number)).map(i => workflow?.cards[i.number]?.stageId ?? i.status));
  const list = [...filterApi.filtered, ...workflowIssues.filter(i => (i.number === locatedNumber || trackedNumbers.has(i.number)) && !filterApi.filtered.some(visible => visible.number === i.number))];
  useEffect(()=>{
    if(locatedNumber===null)return;
    const frame=requestAnimationFrame(()=>document.querySelector(`[data-board-card="${locatedNumber}"]`)?.scrollIntoView({behavior:'smooth',block:'center',inline:'center'}));
    return()=>cancelAnimationFrame(frame);
  },[locatedNumber,locatedStage,locateRequest]);
  const locateMatches=locateQuery.trim()?workflowIssues.filter(i=>String(i.number)===locateQuery.trim().replace(/^#/, '')||i.title.toLowerCase().includes(locateQuery.trim().toLowerCase())).slice(0,12):[];
  const activeRunIds = useMemo(
    () => list.filter((i) => i.activeRun !== null).map((i) => i.activeRun!.id),
    [list],
  );
  const liveByRunLocal = useBoardAgentStreams(activeRunIds);

  // Cloud board cards carry their cloud-run KSUID on activeRun.cloudRunId
  // (set by cardToIssue); subscribe per-card so live tool/arg ticks the
  // way it does locally. The two RunLiveMaps share the same key shape
  // (activeRun.id), so merging them is a flat spread.
  const cloudCtx = getCloudCtx();
  const cloudEntries = useMemo(
    () =>
      list
        .filter(
          (i): i is typeof i & { activeRun: NonNullable<typeof i.activeRun> } =>
            i.activeRun !== null && typeof i.activeRun.cloudRunId === 'string',
        )
        .map((i) => ({ key: i.activeRun.id, cloudRunId: i.activeRun.cloudRunId as string })),
    [list],
  );
  const liveByRunCloud = useCloudBoardStreams(
    cloudCtx?.orgSlug ?? null,
    cloudCtx?.projectSlug ?? null,
    cloudEntries,
  );
  const liveByRun = useMemo(() => {
    if (liveByRunCloud.size === 0) return liveByRunLocal;
    const merged = new Map(liveByRunLocal);
    for (const [k, v] of liveByRunCloud) merged.set(k, v);
    return merged;
  }, [liveByRunLocal, liveByRunCloud]);

  useEffect(() => {
    if (!suggesting) return;
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    const unsub = bridge.subscribe('composer:suggest:event', (payload) => {
      const ev = payload as Partial<SuggestActivity> | null;
      if (!ev || typeof ev !== 'object') return;
      if (ev.kind === 'tool' && typeof ev.name === 'string') {
        const tool: SuggestActivity = {
          kind: 'tool',
          name: ev.name,
          summary: typeof ev.summary === 'string' ? ev.summary : '',
        };
        setSuggestActivity((prev) => [...prev, tool].slice(-10));
      } else if (ev.kind === 'thought' && typeof ev.text === 'string') {
        const thought: SuggestActivity = { kind: 'thought', text: ev.text };
        setSuggestActivity((prev) => [...prev, thought].slice(-10));
      }
    });
    return () => {
      unsub();
    };
  }, [suggesting]);

  // Memoised before the loading/error guards so the hook order stays
  // stable across renders — the early returns below add zero hooks when
  // they fire, but any new hook added _after_ them would skip on the first
  // render and break the Rules of Hooks.
  const grouped = useMemo(() => {
    const base = groupByStatus(list);
    if (sortMode === 'manual') return base;
    return {
      byKey: {
        backlog: sortIssues(base.byKey.backlog, sortMode),
        todo: sortIssues(base.byKey.todo, sortMode),
        inProgress: sortIssues(base.byKey.inProgress, sortMode),
        review: sortIssues(base.byKey.review, sortMode),
        done: sortIssues(base.byKey.done, sortMode),
      },
      untagged: base.untagged,
    };
  }, [list, sortMode]);

  // The next three memos must be declared before the loading/error guards
  // so the hook-call order stays stable across renders. They depend only
  // on values already computed above (grouped, filterApi, sortMode,
  // viewsApi) so hoisting them is a no-op semantically — the prior
  // location after the guards caused a `useMemo` to be skipped on the
  // first render and added on later renders, tripping the Rules of Hooks.

  const orderedNumbers = useMemo<number[]>(() => {
    const out: number[] = [];
    if(workflow) return workflow.config.stages.flatMap((s:any)=>filterApi.filtered.filter(i=>workflow.cards[i.number]?.stageId===s.id).map(i=>i.number));
    for (const issue of grouped.untagged) out.push(issue.number);
    if (filterApi.includeBacklog) {
      for (const issue of grouped.byKey.backlog) out.push(issue.number);
    }
    for (const issue of grouped.byKey.todo) out.push(issue.number);
    for (const issue of grouped.byKey.inProgress) out.push(issue.number);
    for (const issue of grouped.byKey.review) out.push(issue.number);
    for (const issue of grouped.byKey.done) out.push(issue.number);
    return out;
  }, [grouped, filterApi.includeBacklog, filterApi.filtered, workflow]);

  const currentViewState = useMemo(
    () => ({
      filters: {
        hasAgent: filterApi.filters.hasAgent,
        priorities: [...filterApi.filters.priorities],
        areas: [...filterApi.filters.areas],
      },
      sortMode,
      includeBacklog: filterApi.includeBacklog,
    }),
    [filterApi.filters, sortMode, filterApi.includeBacklog],
  );

  const matchedViewId = useMemo(() => {
    for (const v of viewsApi.views) {
      if (boardViewStateEqual(v, currentViewState)) return v.id;
    }
    return null;
  }, [viewsApi.views, currentViewState]);

  const loadedBoard = useRef(false);
  if (!loading) loadedBoard.current = true;
  if (loading && issues.length === 0 && !loadedBoard.current) {
    return (
      <div className="kb-app" style={{ padding: 32, color: 'var(--ink-2)' }}>
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-app" style={{ padding: 32 }}>
        <h2 style={{ color: 'var(--ink)', fontSize: 16, marginBottom: 12 }}>
          Failed to load issues
        </h2>
        <pre style={{ color: 'var(--failed)' }}>{error.message}</pre>
      </div>
    );
  }
  const activeIssue =
    activeNumber !== null ? (issues.find((i) => i.number === activeNumber) ?? null) : null;

  const stats = {
    issues: list.length,
    ...boardStatus(list,workflow?.cards),
    costToday: costToday?.totalUsd ?? 0,
  };

  function onDragStart(event: DragStartEvent): void {
    const n = issueNumberFromDragId(event.active.id);
    setActiveNumber(n);
  }

  function stageIssues(stageId: string): Issue[] {
    const order: number[] = workflow?.stageOrder?.[stageId] ?? [];
    const items = sortIssues(list.filter(i=>workflow.cards[i.number]?.stageId===stageId),sortMode);
    const rank=(n:number)=>{const index=order.indexOf(n);return index<0?Infinity:index;};
    return items.sort((a,b)=>Number(!!b.activeRun)-Number(!!a.activeRun)||(sortMode==='manual'?rank(a.number)-rank(b.number):0));
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    setActiveNumber(null);
    const { active, over } = event;
    if (!over) return;

    const issueNumber = issueNumberFromDragId(active.id);
    if (issueNumber === null) return;

    if(workflow && String(over.id).startsWith('priority:')) {
      const targetNumber=Number(String(over.id).slice(9));
      const stage=workflow.cards[issueNumber]?.stageId;
      if(!stage || workflow.cards[targetNumber]?.stageId!==stage){setMoveError('To change stages, drop on the stage background.');return;}
      const target=list.find(i=>i.number===targetNumber);
      const waiting=stageIssues(stage).filter(i=>!i.activeRun && i.number!==issueNumber);
      const below=(active.rect.current.translated?.top??0)+(active.rect.current.translated?.height??0)/2>over.rect.top+over.rect.height/2;
      let beforeNumber:number|null=targetNumber;
      if(below&&!target?.activeRun){const index=waiting.findIndex(i=>i.number===targetNumber);beforeNumber=waiting[index+1]?.number??null;}
      if(targetNumber===issueNumber)return;
      try{await getBridge()?.coordinatorAction?.('workflow:card',{number:issueNumber,priorityStage:stage,beforeNumber,reason:'Reordered waiting work on board',evidence:'Owner-selected next-work priority'});setSortMode('manual');setLocatedNumber(issueNumber);dispatchIssuesRefetch();setMoveError(null);}catch(e){setMoveError(String(e));}return;
    }
    if(workflow&&String(over.id).startsWith('col:')){
      const to=String(over.id).slice(4);if(workflow.cards[issueNumber]?.stageId===to){try{await getBridge()?.coordinatorAction?.('workflow:card',{number:issueNumber,priorityStage:to,beforeNumber:null,reason:'Moved to end of waiting queue',evidence:'Owner-selected next-work priority'});setSortMode('manual');setLocatedNumber(issueNumber);dispatchIssuesRefetch();setMoveError(null);}catch(e){setMoveError(String(e));}return;}
      try{await getBridge()?.coordinatorAction?.('workflow:card',{number:issueNumber,to,reason:'Moved on board',evidence:'User-directed stage move'});setMoveError(null);}catch(e){setMoveError(String(e));setWorkflowEditor(issueNumber);}return;
    }
    const targetStatus = statusFromDropId(over.id);
    if (targetStatus === undefined) return;

    const current = list.find((i) => i.number === issueNumber);
    if (!current) return;
    if (current.status === targetStatus) return;

    const fromStatus = current.status;
    const nextLabels = withStatus(current.labels, targetStatus);
    const before = list;

    mutate((prev) =>
      (prev ?? []).map((i) =>
        i.number === issueNumber ? { ...i, status: targetStatus, labels: nextLabels } : i,
      ),
    );

    try {
      const updated = await api.updateIssue(issueNumber, { labels: nextLabels });
      mutate((prev) => (prev ?? []).map((i) => (i.number === issueNumber ? updated : i)));
      setMoveError(null);
    } catch (err) {
      mutate(before);
      const message = err instanceof Error ? err.message : String(err);
      setMoveError(`Couldn't move #${issueNumber}: ${message}`);
      return;
    }

    if (targetStatus === 'inProgress' && current.activeRun == null) {
      try {
        await api.dispatchIssue(issueNumber, {
          fromStatus,
          ...(focusedRepoId !== null ? { repoId: focusedRepoId } : {}),
        });
        dispatchIssuesRefetch();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMoveError(`Moved #${issueNumber}, but couldn't start an agent: ${message}`);
      }
    }
  }

  function openPersonaPicker(): void {
    if (suggesting) return;
    setPersonaPickerOpen(true);
  }

  async function runSuggestionWith(
    persona: Persona,
    provider?: ProviderId,
    userNotes?: string,
  ): Promise<void> {
    setPersonaPickerOpen(false);
    if (suggesting) return;
    setSuggestActivity([]);
    setSuggestStartedAt(new Date().toISOString());
    setSuggesting(true);
    setMoveError(null);
    try {
      const bridge = getBridge();
      if (bridge?.coordinatorAction) {
        await bridge.coordinatorAction('request-perspective', {
          name: persona.name, prompt: persona.prompt, notes: userNotes ?? '',
        });
        window.dispatchEvent(new CustomEvent('kanbots:open-coordinator'));
        return;
      }
      const drafted = await api.suggestFeature(persona.prompt, provider, userNotes);
      await api.createIssue({
        title: drafted.title,
        body: drafted.body,
        labels: ['status:backlog', 'type:feat'],
      });
      dispatchIssuesRefetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMoveError(`Couldn't suggest a feature: ${message}`);
    } finally {
      setSuggesting(false);
      setSuggestStartedAt(null);
    }
  }

  /**
   * Stable rendered order across columns. Used by shift-range selection
   * so a range can span columns the same way a Trello / Linear board
   * does. Order matches the visible top-to-bottom layout:
   * inbox → backlog (if shown) → todo → inProgress → review → done.
   *
   * NOTE: declared at the top of the component (above the loading/error
   * guards) so the hook order stays stable across renders. See the
   * `grouped` / `currentViewState` / `matchedViewId` comments for the
   * same constraint.
   */
  // (`orderedNumbers` / `currentViewState` / `matchedViewId` are declared
  // earlier in the function — see the block before the loading/error
  // early returns. Kept here as documentation only.)

  function handleCardSelect(n: number, modifiers: CardSelectModifiers): void {
    if (modifiers.shiftKey) {
      cardSelection.selectRange(cardSelection.anchor, n, orderedNumbers);
      return;
    }
    if (modifiers.metaOrCtrlKey) {
      cardSelection.toggle(n);
      return;
    }
    // Plain click — focus the card and clear any multi-select. The
    // selection ring (single) lives on the route hash; the multi-select
    // ring lives in the ephemeral hook state.
    if (cardSelection.selected.size > 0) cardSelection.clear();
    setSelectedNumber(n);
  }

  function handleBoardBackgroundClick(e: ReactMouseEvent<HTMLDivElement>): void {
    // Only clear the multi-select if the click landed on the empty
    // background — clicks that bubble from a card should be left alone.
    if (e.target === e.currentTarget && cardSelection.selected.size > 0) {
      cardSelection.clear();
    }
  }

  async function withBulkBusy<T>(fn: () => Promise<T>): Promise<T | null> {
    setBulkBusy(true);
    setMoveError(null);
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMoveError(`Bulk action failed: ${message}`);
      return null;
    } finally {
      setBulkBusy(false);
    }
  }

  // v1 of bulk ops piggybacks on the per-issue endpoints via
  // Promise.allSettled so we don't have to ship a new backend channel
  // for what's mostly a fan-out. If any subset fails, the rest still
  // succeed and the error banner surfaces an aggregate message.
  async function bulkMoveToStatus(status: BulkStatusTarget): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0) return;
    await withBulkBusy(async () => {
      const before = issues;
      const results = await Promise.allSettled(
        targets.map(async (n) => {
          const issue = before.find((i) => i.number === n);
          if (!issue) return null;
          if(workflow){const stage=workflow.config.stages.find((s:any)=>s.id===status)??workflow.config.stages.find((s:any)=>s.category===(status??'backlog'));if(!stage)throw Error('Choose a stage in Card decisions.');return getBridge()?.coordinatorAction?.('workflow:card',{number:n,to:stage.id,reason:'Bulk board move',evidence:'User-directed stage move'});}
          const nextLabels = withStatus(issue.labels, status);
          return api.updateIssue(n, { labels: nextLabels });
        }),
      );
      dispatchIssuesRefetch();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(`${failed} of ${targets.length} card(s) failed to move`);
      }
    });
  }

  async function bulkAddLabels(labels: string[]): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0 || labels.length === 0) return;
    await withBulkBusy(async () => {
      const before = issues;
      const results = await Promise.allSettled(
        targets.map(async (n) => {
          const issue = before.find((i) => i.number === n);
          if (!issue) return null;
          const set = new Set(issue.labels);
          for (const l of labels) set.add(l);
          return api.updateIssue(n, { labels: [...set] });
        }),
      );
      dispatchIssuesRefetch();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(`${failed} of ${targets.length} card(s) failed to label`);
      }
    });
  }

  async function bulkDispatch(): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0) return;
    await withBulkBusy(async () => {
      const before = issues;
      const results = await Promise.allSettled(
        targets.map(async (n) => {
          const issue = before.find((i) => i.number === n);
          if (!issue) return null;
          if (issue.activeRun !== null) return null;
          return api.dispatchIssue(n, {
            fromStatus: issue.status,
            ...(focusedRepoId !== null ? { repoId: focusedRepoId } : {}),
          });
        }),
      );
      dispatchIssuesRefetch();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(
          `${failed} of ${targets.length} card(s) failed to dispatch`,
        );
      }
    });
  }

  async function bulkArchive(): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0) return;
    const ok = window.confirm(
      `Archive ${targets.length} card${targets.length === 1 ? '' : 's'}?`,
    );
    if (!ok) return;
    await withBulkBusy(async () => {
      const results = await Promise.allSettled(
        targets.map((n) => api.archiveIssue(n)),
      );
      dispatchIssuesRefetch();
      cardSelection.clear();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(
          `${failed} of ${targets.length} card(s) failed to archive`,
        );
      }
    });
  }

  // --- Saved views ---------------------------------------------------------
  //
  // (`currentViewState` + `matchedViewId` are declared earlier in the
  // function — see the block before the loading/error early returns.)

  function applyView(id: string | null): void {
    viewsApi.setActiveView(id);
    if (id === null) {
      // Reset to a clean slate.
      filterApi.clear();
      setSortMode('manual');
      if (filterApi.includeBacklog) filterApi.toggleIncludeBacklog();
      return;
    }
    const v = viewsApi.views.find((x) => x.id === id);
    if (!v) return;
    // Reset and re-apply each filter so we don't carry over stale state.
    filterApi.clear();
    if (v.filters.hasAgent) filterApi.toggleHasAgent();
    for (const p of v.filters.priorities) filterApi.togglePriority(p);
    for (const a of v.filters.areas) filterApi.toggleArea(a);
    setSortMode(v.sortMode);
    if (filterApi.includeBacklog !== v.includeBacklog) {
      filterApi.toggleIncludeBacklog();
    }
  }

  function saveCurrentAsView(name: string): void {
    viewsApi.saveView(name, currentViewState);
  }

  return (
    <DndContext collisionDetection={args=>{const hits=pointerWithin(args);const cards=hits.filter(h=>String(h.id).startsWith('priority:'));return cards.length?cards:hits.length?hits:closestCenter(args);}} sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <BoardToolbar
        crumbs={
          <>
            {config ? (
              <>
                <span>
                  {config.mode === 'local' ? config.repo : `${config.owner}/${config.repo}`}
                </span>
                <span className="kb-sep">/</span>
              </>
            ) : null}
            <span className="kb-crumb-active">Board</span>
          </>
        }
        onOpenPalette={onOpenPalette}
        onOpenAutopilot={() => setAutopilotLaunchOpen(true)}
        onCreate={onOpenCreate}
        // null while the first fetch is in flight so the meter shows its
        // placeholder; once loaded it lights up in the clay accent when
        // any spend has accumulated this calendar day.
        costTodayUsd={costToday === null ? null : costToday.totalUsd}
        {...(onOpenStats ? { onOpenCostMeter: onOpenStats } : {})}
      />
      <BoardFilters
        stats={stats}
        controls={{
          hasAgent: filterApi.filters.hasAgent,
          priorities: filterApi.filters.priorities as ReadonlySet<string>,
          areas: filterApi.filters.areas,
          availablePriorities: filterApi.availablePriorities,
          availableAreas: filterApi.availableAreas,
          includeBacklog: filterApi.includeBacklog,
          backlogCount: issues.filter((i) => i.status === 'backlog').length,
          sortMode,
          onToggleHasAgent: filterApi.toggleHasAgent,
          onTogglePriority: (p) => filterApi.togglePriority(p as (typeof filterApi.availablePriorities)[number]),
          onToggleArea: filterApi.toggleArea,
          onToggleIncludeBacklog: filterApi.toggleIncludeBacklog,
          onChangeSortMode: setSortMode,
          onClear: filterApi.clear,
          views: {
            views: viewsApi.views.map((v) => ({ id: v.id, name: v.name })),
            activeViewId: viewsApi.activeViewId,
            matchedViewId,
            onPickView: applyView,
            onSaveAsView: saveCurrentAsView,
            onManageViews: () => setManageViewsOpen(true),
          },
        }}
      />
      <BoardUsageRow
        issueCount={issues.length}
        workspaceId={workspaceMeta.workspace.id}
        stale={costUsage?.stale ?? false}
        fiveHour={costUsage?.fiveHour ?? null}
        sevenDay={costUsage?.sevenDay ?? null}
      />
      {workflow?<div className="kb-coordinator-strip"><button className="kb-btn ghost" onClick={()=>setWorkflowEditor(0)}>Workflow · {workflow.config.name}</button><span className="kb-provider-desc">Version {workflow.version}</span></div>:null}
      {workflowEditor!==null?<WorkflowEditor onClose={()=>setWorkflowEditor(null)} {...(workflowEditor?{cardNumber:workflowEditor}:{})}/>:null}
      <BoardErrorBanner message={moveError} onDismiss={() => setMoveError(null)} />
      <div className="kb-board-heading"><div><h1>Move the right work forward</h1><span>Plan, follow progress, and unblock your team.</span></div><button className="kb-btn" aria-pressed={relatedOnly} onClick={()=>setRelatedOnly(!relatedOnly)}>Related work{relatedOnly ? ' · On' : ''}</button></div>
      <section className="kb-board-overview" aria-label="Visible task progress">
        <div><strong>{list.filter(i => i.status === 'done').length} / {list.length}</strong><span> visible tasks complete</span></div>
        <progress aria-label="Visible tasks complete" max={Math.max(1,list.length)} value={list.filter(i => i.status === 'done').length} />
        <span>{stats.runs} running workers</span>
        <span>{stats.awaiting} workers awaiting input</span>
        <span>{stats.waitingCards} cards waiting</span>
      </section>
      {enabledStages?.length===0 && <p role="status">No stages selected. Toggle a stage below or choose All stages.</p>}
      <nav className="kb-stage-navigation" aria-label="Visible stages"><button aria-pressed={enabledStages===null} onClick={()=>setEnabledStages(null)}>All stages</button>{(workflow?.config.stages ?? COLUMNS.map(c=>({id:String(c.key),name:c.label}))).map((stage:any)=><button key={stage.id} aria-pressed={enabledStages===null||enabledStages.includes(stage.id)} onClick={()=>setEnabledStages(current=>{const all=(workflow?.config.stages ?? COLUMNS.map(c=>({id:String(c.key)}))).map((s:any)=>s.id);const selected=current??all;return selected.includes(stage.id)?selected.filter((id:string)=>id!==stage.id):[...selected,stage.id];})}>{stage.name}</button>)}</nav>
      <section className="kb-board-locate" aria-label="Find a card on the board">
        <label htmlFor="board-locate">Locate card</label>
        <input id="board-locate" className="kb-input" type="search" placeholder="Card number or title…" value={locateQuery} onChange={e=>setLocateQuery(e.target.value)} />
        {locateQuery.trim()&&<div className="kb-board-locate-results">{locateMatches.length?locateMatches.map(i=><button className="kb-btn" key={i.number} onClick={()=>{setLocatedNumber(i.number);setLocateRequest(n=>n+1);setLocateQuery('');}}>#{i.number} · {i.title} — {workflow?.config.stages.find((s:any)=>s.id===workflow.cards[i.number]?.stageId)?.name??i.status}</button>):<span role="status">No matching card</span>}</div>}
        {locatedIssue&&<span role="status">Located #{locatedIssue.number} in {workflow?.config.stages.find((s:any)=>s.id===locatedStage)?.name??locatedIssue.status}. <button className="kb-btn ghost" onClick={()=>setLocatedNumber(null)}>Clear highlight</button></span>}
        {trackedNumbers.size > 0 && <div className="kb-board-tracked" aria-label="Tracked cards"><strong>Tracking {trackedNumbers.size}</strong>{workflowIssues.filter(i => trackedNumbers.has(i.number)).map(i => <button className="kb-btn" key={i.number} onClick={() => {setLocatedNumber(i.number);setLocateRequest(n=>n+1); document.querySelector(`[data-board-card="${i.number}"]`)?.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});}}>#{i.number} · {i.title}</button>)}</div>}
      </section>
      <div className="kb-board kb-board-focus" data-located-card={locatedNumber??undefined} onClick={handleBoardBackgroundClick}>
        {(workflow?workflow.config.stages.map((s:any)=>({key:s.id,label:s.name,status:s.category,purpose:s.purpose})):COLUMNS.filter((col) => filterApi.includeBacklog || col.key !== 'backlog')).filter((col:any)=>enabledStages===null||enabledStages.includes(String(col.key))||col.key===locatedStage||trackedStages.has(col.key)).map((col:any) => (
          <Column
            key={String(col.key)}
            columnKey={col.key}
            status={col.status}
            label={col.label}
            issues={(workflow?stageIssues(col.key!):col.key === null ? grouped.untagged : grouped.byKey[col.key as StatusKey]).filter(i=>i.number===locatedNumber||trackedNumbers.has(i.number)||!relatedOnly||(i.subIssueCount??0)>0)}
            {...(workflow?{purpose:col.purpose,workflowCards:workflow.cards,onWorkflowCard:setWorkflowEditor}:{})}
            locatedNumber={locatedNumber}
            trackedNumbers={trackedNumbers}
            onToggleTracked={toggleTracked}
            selectedNumber={selectedNumber}
            multiSelected={cardSelection.selected}
            liveByRun={liveByRun}
            onSelect={handleCardSelect}
            onOpen={(n) => {
              setSelectedNumber(n);
              onOpenDetail?.(n);
            }}
            {...(col.key === 'backlog'
              ? {
                  onSuggest: openPersonaPicker,
                  suggesting,
                  suggestingActivity: suggestActivity,
                  suggestingStartedAt: suggestStartedAt,
                }
              : {})}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeIssue ? <CardPreview issue={activeIssue} /> : null}
      </DragOverlay>
      {personaPickerOpen ? (
        <PersonaPickerModal
          onClose={() => setPersonaPickerOpen(false)}
          onPick={(persona, provider, notes) => void runSuggestionWith(persona, provider, notes)}
        />
      ) : null}
      {autopilotLaunchOpen ? (
        <AutopilotLaunchModal
          onClose={() => setAutopilotLaunchOpen(false)}
          onStarted={() => dispatchIssuesRefetch()}
        />
      ) : null}
      {cardSelection.selected.size > 0 ? (
        <BulkActionBar
          count={cardSelection.selected.size}
          busy={bulkBusy}
          onMoveToStatus={(s) => void bulkMoveToStatus(s)}
          onAddLabels={(labels) => void bulkAddLabels(labels)}
          onDispatch={() => void bulkDispatch()}
          onArchive={() => void bulkArchive()}
          onClear={() => cardSelection.clear()}
        />
      ) : null}
      {manageViewsOpen ? (
        <BoardViewsModal
          views={viewsApi.views}
          onRename={(id, name) => viewsApi.updateView(id, { name })}
          onDelete={viewsApi.deleteView}
          onReorder={viewsApi.reorderViews}
          onClose={() => setManageViewsOpen(false)}
        />
      ) : null}
    </DndContext>
  );
}
