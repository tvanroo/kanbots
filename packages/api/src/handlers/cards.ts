import { z } from 'zod';
import type { DismissCardResult, ResolveCardResult } from '../bridge.js';
import { badRequest, namedError, notFound, parseArgs } from './errors.js';
import { buildTaskSystemPrompt } from './issues.js';
import type { HandlerDeps } from './types.js';

const resolveSchema = z
  .object({
    cardId: z.number().int().positive(),
    value: z.string().min(1).max(2000),
    freeText: z.boolean().optional(),
  })
  .strict();

const dismissSchema = z
  .object({
    cardId: z.number().int().positive(),
  })
  .strict();

export interface ResolveCardArgs {
  cardId: number;
  value: string;
  freeText?: boolean;
}

export interface DismissCardArgs {
  cardId: number;
}

export async function resolve(
  deps: HandlerDeps,
  args: ResolveCardArgs,
): Promise<ResolveCardResult> {
  const parsed = parseArgs(resolveSchema, args);

  const card = deps.store.cards.findById(parsed.cardId);
  if (!card) throw notFound(`card ${parsed.cardId} not found`);
  if (card.type !== 'decision') {
    throw badRequest('card type not resolvable here');
  }
  const payload = card.payload as
    | { question?: string; options?: Array<{ value: string; label: string }> }
    | undefined;
  const options = payload?.options ?? [];
  if (parsed.freeText) { parsed.value = parsed.value.trim(); if (!parsed.value) throw badRequest('Answer cannot be empty'); }
  const chosen = options.find((o) => o.value === parsed.value);
  if (!chosen && !parsed.freeText) throw badRequest('value not in options');
  const label = parsed.freeText ? parsed.value : chosen!.label;

  const message = deps.store.messages.findById(card.messageId);
  if (!message || message.agentRunId === null) {
    throw namedError('InternalError', 'card not linked to an agent run');
  }
  const runId = message.agentRunId;

  const run = deps.store.agentRuns.findById(runId);
  if (!run) throw namedError('InternalError', `agent run ${runId} not found`);
  const thread = deps.store.threads.findById(run.threadId);
  if (!thread) throw namedError('InternalError', `thread ${run.threadId} not found`);
  const issue = await deps.source.getIssue(thread.issueNumber);

  const resolved = deps.store.cards.resolve(card.id, {
    value: parsed.value,
    label,
  });

  const resumePrompt = parsed.freeText ? `User replied to your question:\n${parsed.value}\nContinue.` : `User chose: ${label} (value: ${parsed.value}). Continue.`;
  const updatedRun = await deps.supervisor.resume({
    runId,
    prompt: resumePrompt,
    appendSystemPrompt: buildTaskSystemPrompt(issue),
  });

  return { card: resolved, run: updatedRun };
}

export async function dismiss(
  deps: HandlerDeps,
  args: DismissCardArgs,
): Promise<DismissCardResult> {
  const parsed = parseArgs(dismissSchema, args);

  const card = deps.store.cards.findById(parsed.cardId);
  if (!card) throw notFound(`card ${parsed.cardId} not found`);
  if (card.type !== 'decision') {
    throw badRequest('card type not dismissable here');
  }
  if (card.status !== 'pending') {
    throw badRequest(`card not pending (status: ${card.status})`);
  }

  const message = deps.store.messages.findById(card.messageId);
  if (!message || message.agentRunId === null) {
    throw namedError('InternalError', 'card not linked to an agent run');
  }
  const runId = message.agentRunId;

  // Stopping the run dismisses pending decisions on it as a side effect when
  // the run is still active. If it's already inactive, stop is a no-op for
  // cards, so dismiss explicitly afterward.
  const run = await deps.supervisor.stop(runId);
  const after = deps.store.cards.findById(card.id);
  const dismissed =
    after && after.status === 'pending' ? deps.store.cards.dismiss(card.id) : (after ?? card);

  return { card: dismissed, run };
}
