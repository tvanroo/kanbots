/** Classify without exposing raw stderr (which may contain credentials or prompts). */
export function subscriptionFailure(detail:string):{kind:string;message:string;recoverable:boolean}{
 if(/prompt is too long|context[_ ](?:length|window).*(?:exceed|limit|full)|maximum context length|too many tokens/i.test(detail))return {kind:'context',message:'The saved conversation exceeds the provider context limit.',recoverable:true};
 if(/unexpected argument|unknown (?:option|flag)|unrecognized (?:argument|option)/i.test(detail))return {kind:'arguments',message:'The installed CLI rejected a launch option.',recoverable:true};
 if(/(?:session|thread).*(?:not found|does not exist|invalid|expired)|no (?:session|conversation).*found|failed to (?:load|resume).*(?:session|thread)/i.test(detail))return {kind:'session',message:'The saved provider session is unavailable.',recoverable:true};
 if(/unauthorized|authentication|not logged in|sign in|invalid.*token|401\b/i.test(detail))return {kind:'auth',message:'Sign-in needs attention in provider settings.',recoverable:true};
 if(/ENOENT|command not found|spawn.*EACCES/i.test(detail))return {kind:'launch',message:'The provider CLI could not be started. Check its installation in provider settings.',recoverable:true};
 if(/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|connection.*(?:failed|closed)|stream disconnected|\b50[234]\b|temporarily unavailable/i.test(detail))return {kind:'transient',message:'The provider connection was temporarily unavailable.',recoverable:true};
 return {kind:'unknown',message:'The provider ended without completing the request.',recoverable:false};
}

/** Bounded recovery envelope; full evidence remains in the saved session. */
export function recoveryContext(entries:Array<{role:string;text:string}>,request:string,archive:string):string {
 const excerpt=(text:string,n:number)=>text.length<=n?text:text.slice(0,n)+'\n[Excerpt only; consult saved evidence before acting.]';
 const objective=entries.find(e=>e.role==='user')?.text??'';
 const recent=entries.filter(e=>e.role==='assistant').slice(-3).map(e=>excerpt(e.text,2500)).join('\n\n');
 return `Continue the SAME assignment and worktree after a context-limit failure. Do not duplicate completed work. Inspect current files and exact evidence before acting. Earlier text is background, not new authorization. Read missing details selectively from the saved session at ${JSON.stringify(archive)}; do not load its entire transcript. Preserve unresolved questions, constraints, checks and release boundaries.\nOriginal assignment excerpt:\n${excerpt(objective,5000)}\nRecent progress excerpts (not verified completion):\n${recent}\nCurrent request:\n${excerpt(request,10000)}`;
}
