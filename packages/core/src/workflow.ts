export type WorkflowActor = 'coordinator' | 'worker' | 'reviewer' | 'user';
export type WorkflowTaskType = 'research' | 'implementation' | 'qa' | 'release' | 'incident' | 'objective';
export type WorkflowCheck = { id: string; label: string; mode: 'required' | 'advisory' | 'not-applicable' };
export type WorkflowStage = {
  id: string; name: string; purpose: string; entry: string; exit: string;
  coordinatorGuidance: string; workerGuidance: string; actor: WorkflowActor; personaId?: string | undefined;
  category: 'backlog' | 'todo' | 'inProgress' | 'review' | 'done'; checks: WorkflowCheck[];
};
export type WorkflowTransition = { from: string; to: string; actor: WorkflowActor; automatic: boolean; event: 'manual' | 'worker-completed' | 'qa-passed' | 'merged' | 'deployed' };
export type WorkflowConfig = {
  name: string; stages: WorkflowStage[]; transitions: WorkflowTransition[];
  completion: Array<{ taskType: WorkflowTaskType; guidance: string; checks: WorkflowCheck[] }>;
  waitingReasons: string[]; notifications: 'meaningful' | 'all-transitions' | 'decisions-only';
  cadence: { working: number; idle: number }; releaseOwner: 'coordinator' | 'user';
  template?: { id: string; version: number };
};
export type WorkflowCard = {
  number: number; stageId: string; taskType: WorkflowTaskType; version: number; enteredAt: string;
  checks: Record<string, { outcome: 'pass' | 'fail' | 'not-applicable'; evidence: string; at: string; actor: string; version: number }>;
  evidence: string; nextAction: string; owner: string;
  waiting?: { reason: string; owner: string; trigger: string };
  history: Array<{ at: string; actor: string; version: number; from: string; to: string; reason: string; evidence: string }>;
};
export type WorkflowState = {
  version: number; config: WorkflowConfig; cards: Record<string, WorkflowCard>; stageOrder?: Record<string, number[]>;
  history: Array<{ version: number; at: string; actor: string; reason: string; config: WorkflowConfig; moves: Array<{ number: number; from: string; to: string }> }>;
};
