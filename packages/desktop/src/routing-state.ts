import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RoutingState, RoutingConfig } from '@kanbots/api';
export type Charge = { id: string; pool: string; connectionId: string; at: string; usd: number; pending: boolean; input?: number; output?: number };
type State = RoutingState & { charges: Charge[]; redemptions: Record<string, { attempt: string; checkedAt: number; outcome: string }> };
const defaults: RoutingConfig = { enabled: true, maxRunUsd: 5, autoResets: true, claudeResetExpiresAt: null };
const path = () => join(app.getPath('userData'), 'automatic-routing.json');
export function readRouting(): State {
  if (!existsSync(path())) return { config: defaults, charges: [], redemptions: {}, lastDecision: null, lastReset: null };
  const state = JSON.parse(readFileSync(path(),'utf8')) as State;
  return { ...state, config: { ...defaults, ...state.config } };
}
export function writeRouting(state: State) { writeFileSync(path()+'.tmp',JSON.stringify(state),{mode:0o600}); renameSync(path()+'.tmp',path()); }
export function routingState(): RoutingState { const { config,lastDecision,lastReset }=readRouting(); return {config,lastDecision,lastReset}; }
export function saveRouting(config: RoutingConfig) {
  if (typeof config.enabled !== 'boolean' || typeof config.autoResets !== 'boolean' || !Number.isFinite(config.maxRunUsd) || config.maxRunUsd <= 0 || config.maxRunUsd > 1000 || (config.claudeResetExpiresAt !== null && !Number.isFinite(Date.parse(config.claudeResetExpiresAt)))) throw Error('Check routing settings.');
  const state=readRouting(); state.config=config; writeRouting(state); return routingState();
}
export function recordDecision(message: string) { const state=readRouting(); state.lastDecision=message; writeRouting(state); }
export function charged(pool: string, since: number): number { return readRouting().charges.filter(c=>c.pool===pool&&(c.pending||Date.parse(c.at)>=since)).reduce((n,c)=>n+c.usd,0); }
// Synchronous read/check/write in the main process reserves across concurrent tasks.
export function reserveCharge(pool: string, connectionId: string, usd: number, available: number, since: number): string | null {
  const state=readRouting();
  const used=state.charges.filter(c=>c.pool===pool&&(c.pending||Date.parse(c.at)>=since)).reduce((n,c)=>n+c.usd,0);
  if (!Number.isFinite(usd)||usd<=0||used+usd>available) return null;
  const id=randomUUID();state.charges.push({id,pool,connectionId,at:new Date().toISOString(),usd,pending:true});writeRouting(state);return id;
}
export function settleCharge(id: string, usd?: number, input?: number, output?: number) {
  const state=readRouting();const row=state.charges.find(c=>c.id===id);if(!row)return;
  // Unknown outcomes retain the entire reservation across restarts.
  if(usd!==undefined){row.usd=Math.max(0,usd);row.pending=false;row.at=new Date().toISOString();}
  if(input!==undefined)row.input=input;if(output!==undefined)row.output=output;writeRouting(state);
}
