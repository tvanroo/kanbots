/** Both board summaries use the same scope and definitions. Card waits are not worker lanes. */
export function boardStatus(items:Array<{number:number;agent?:string|null;activeRun?:{id:number;status:string}|null}>,cards:Record<number,{waiting?:unknown}>={}){
 const running=new Set<number>(),awaiting=new Set<number>();let waitingCards=0;
 for(const item of items){
  const run=item.activeRun;
  if(run&&['starting','running'].includes(run.status))running.add(run.id);
  if(run?.status==='awaiting_input')awaiting.add(run.id);
  if(cards[item.number]?.waiting||item.agent==='blocked')waitingCards++;
 }
 return {runs:running.size,awaiting:awaiting.size,waitingCards};
}
