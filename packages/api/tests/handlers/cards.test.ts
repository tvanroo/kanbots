import { describe, expect, it, vi } from 'vitest';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

describe('cards:resolve', () => {
  it('resolves the card and returns the run', async () => {
    const { handlers, store, source } = makeHandlerTestKit();
    vi.spyOn(source, 'getIssue').mockResolvedValue({number:1,title:'Test',body:'',labels:[]} as never);
    const t = store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 1 });
    const run = store.agentRuns.create({ threadId: t.id });
    store.agentRuns.update(run.id, { status: 'awaiting_input' });
    const msg = store.messages.create({
      threadId: t.id,
      role: 'agent',
      body: 'pick one',
      agentRunId: run.id,
    });
    const card = store.cards.create({
      messageId: msg.id,
      type: 'decision',
      payload: { question: 'q', options: [{ value: 'a', label: 'A' }] },
    });

    const result = await handlers['cards:resolve']({ cardId: card.id, value: 'a' });
    expect(result.card.status).toBe('resolved');
    expect(result.run.id).toBe(run.id);
  });

  it('delivers a free-form answer to the originating run and resolves the question', async () => {
    const { handlers, store, supervisor, source } = makeHandlerTestKit();
    vi.spyOn(source, 'getIssue').mockResolvedValue({number:1,title:'Test',body:'',labels:[]} as never);
    const t = store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 1 });
    const run = store.agentRuns.create({ threadId: t.id });
    store.agentRuns.update(run.id, { status: 'awaiting_input' });
    const msg = store.messages.create({threadId:t.id, role:'agent', body:'question', agentRunId:run.id});
    const card = store.cards.create({messageId:msg.id, type:'decision', payload:{question:'What next?', options:[{value:'a',label:'A'}]}});
    const spy = vi.spyOn(supervisor, 'resume');
    await expect(handlers['cards:resolve']({cardId:card.id,value:'custom response'})).rejects.toThrow('value not in options');
    const result = await handlers['cards:resolve']({cardId:card.id,value:'  custom response  ',freeText:true});
    expect(result.card.status).toBe('resolved');
    expect(result.card.resolvedValue).toEqual({value:'custom response',label:'custom response'});
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({runId:run.id,prompt:expect.stringContaining('custom response')}));
    await expect(handlers['cards:resolve']({cardId:card.id,value:'second',freeText:true})).rejects.toThrow();
  });

  it('throws NotFound for a missing card', async () => {
    const { handlers } = makeHandlerTestKit();
    await expect(
      handlers['cards:resolve']({ cardId: 9999, value: 'x' }),
    ).rejects.toThrow();
  });
});
