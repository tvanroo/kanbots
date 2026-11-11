export type QuestionCommand = { title: string; code: string; language: string; where: string; expected: string };
export function questionCommands(value: unknown): QuestionCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw Error('Provide at most eight commands.');
  return value.map(command => {
    if (!command || typeof command !== 'object') throw Error('Provide a command with its destination and expected result.');
    const result = {} as QuestionCommand;
    for (const field of ['title','code','language','where','expected'] as const) {
      const text = command[field];
      if (typeof text !== 'string' || !text.trim() || text.length > (field === 'code' ? 40000 : 1000)) throw Error(`Invalid command ${field}.`);
      result[field] = text;
    }
    return result;
  });
}
// Legacy text is displayed only after removing machine briefings. Never infer a
// command from a file path, tool invocation, or prose.
export function questionExplanation(text: string): string {
  return text.replace(/\[kanbots:sibling-briefing\][\s\S]*?(?=This is an explanation|## |$)/g, '')
    .split('\n').filter(line => !/^(?:Routing:|Switching payment source|\[kanbots:)/.test(line.trim())).join('\n').trim();
}
export function fencedQuestionCommands(text: string): QuestionCommand[] {
  return [...text.matchAll(/```([\w+-]*)\n([\s\S]*?)```/g)].slice(0,8).filter(m=>m[2]!.trim()).map((m,i)=>({
    title:`Snippet ${i+1}`,language:m[1]||'text',code:m[2]!.replace(/\n$/,''),
    where:'See the instructions in the question or originating conversation.',expected:'Return the requested result; copying does not run this snippet.',
  }));
}
