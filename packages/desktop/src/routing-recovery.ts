/** Classify without exposing raw stderr (which may contain credentials or prompts). */
export function subscriptionFailure(detail:string):{kind:string;message:string;recoverable:boolean}{
 if(/unexpected argument|unknown (?:option|flag)|unrecognized (?:argument|option)/i.test(detail))return {kind:'arguments',message:'The installed CLI rejected a launch option.',recoverable:true};
 if(/(?:session|thread).*(?:not found|does not exist|invalid|expired)|no (?:session|conversation).*found|failed to (?:load|resume).*(?:session|thread)/i.test(detail))return {kind:'session',message:'The saved provider session is unavailable.',recoverable:true};
 if(/unauthorized|authentication|not logged in|sign in|invalid.*token|401\b/i.test(detail))return {kind:'auth',message:'Sign-in needs attention in provider settings.',recoverable:true};
 if(/ENOENT|command not found|spawn.*EACCES/i.test(detail))return {kind:'launch',message:'The provider CLI could not be started. Check its installation in provider settings.',recoverable:true};
 if(/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|connection.*(?:failed|closed)|stream disconnected|\b50[234]\b|temporarily unavailable/i.test(detail))return {kind:'transient',message:'The provider connection was temporarily unavailable.',recoverable:true};
 return {kind:'unknown',message:'The provider ended without completing the request.',recoverable:false};
}
