import { Notification,shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { getCodexDetails, type CodexDetails } from './codex-catalogue.js';
import { resetToRedeem } from './reset-policy.js';
import { readRouting,writeRouting } from './routing-state.js';
let pending: Promise<CodexDetails> | undefined;
export async function manageCodexResets(hasWork=false): Promise<CodexDetails> {
  if(pending)return pending;
  pending=(async()=>{
    const details=await getCodexDetails();
    if(!readRouting().config.enabled||!readRouting().config.autoResets)return details;
    const id=resetToRedeem(details,hasWork);if(!id||!details.accountIdentity)return details;
    const state=readRouting();const key=details.accountIdentity+':'+id;
    const old=state.redemptions[key];
    if(old && (['reset','alreadyRedeemed','noCredit'].includes(old.outcome)||Date.now()-old.checkedAt<5*60000))return details;
    const attempt=old?.attempt??randomUUID();
    state.redemptions[key]={attempt,checkedAt:Date.now(),outcome:'pending'};writeRouting(state);
    const next=await getCodexDetails({accountIdentity:details.accountIdentity,creditId:id,idempotencyKey:attempt});
    const updated=readRouting();const outcome=next.resetOutcome??'unknown';
    updated.redemptions[key]={attempt,checkedAt:Date.now(),outcome};
    updated.lastReset=outcome==='reset'||outcome==='alreadyRedeemed'?'ChatGPT reset redeemed; capacity rechecked.':outcome==='nothingToReset'?'ChatGPT reset offered, but no eligible quota to restore.':'ChatGPT reset not confirmed; will recheck without duplicating redemption.';
    writeRouting(updated);return next;
  })().finally(()=>{pending=undefined;});
  return pending;
}

export function notifyClaudeReset() {
  const state=readRouting();const expires=state.config.claudeResetExpiresAt;
  if(!state.config.enabled||!expires)return;
  const remaining=Date.parse(expires)-Date.now();
  if(remaining<=0||remaining>30*60000)return;
  const key='claude-manual:'+expires;
  if(state.redemptions[key])return;
  state.redemptions[key]={attempt:'manual',checkedAt:Date.now(),outcome:'notified'};
  state.lastReset='Claude reset expires soon. Redeem it in Claude Usage; automatic redemption is unavailable.';writeRouting(state);
  if(Notification.isSupported()){
    const notice=new Notification({title:'Claude reset expires soon',body:'Redeem your tracked reset in Claude Usage before it expires.'});
    notice.on('click',()=>void shell.openExternal('https://claude.ai/settings/usage'));notice.show();
  }
}
