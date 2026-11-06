import {describe,it,expect} from 'vitest';
import {codexCliAdapter} from '../src/adapters/codex-cli.js';
describe('Codex resume compatibility',()=>{
 it('omits fresh-exec-only sandbox flags while retaining existing policy and MCP config',()=>{
  const args=codexCliAdapter.buildArgs({resumeFromSessionId:'saved-thread',extraArgs:['-c','mcp_servers.kanborg.command="/local/bridge"']});
  expect(args.slice(0,3)).toEqual(['exec','resume','saved-thread']);expect(args).not.toContain('--sandbox');expect(args).toContain('--json');expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');expect(args).toContain('mcp_servers.kanborg.command="/local/bridge"');
 });
 it('preserves new session launch arguments',()=>{const args=codexCliAdapter.buildArgs({});expect(args[0]).toBe('exec');expect(args).not.toContain('resume');expect(args).toContain('--sandbox');});
});
