import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function rememberWorkspace(root:string,repoPath:string|null){
  const file=join(root,'last-workspace.json');
  writeFileSync(file+'.tmp',JSON.stringify({repoPath}),{mode:0o600});renameSync(file+'.tmp',file);
}

export function startupWorkspace(root:string):string|null{
  try{
    const saved=join(root,'last-workspace.json');
    // Older releases already recorded recents; use those once to preserve continuity.
    const repoPath=existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')).repoPath:
      JSON.parse(readFileSync(join(root,'workspaces.json'),'utf8')).recents?.[0]?.repoPath;
    return typeof repoPath==='string'&&existsSync(repoPath)?repoPath:null;
  }catch{return null;}
}
