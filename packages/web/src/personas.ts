import { getBridge } from './desktop-bridge.js';
export interface Persona {
  id: string;
  name: string;
  tagline: string;
  prompt: string;
  emoji: string;
  builtIn: boolean;
}

export const BUILTIN_PERSONAS: readonly Persona[] = [
  {
    id: 'builtin:product-manager',
    name: 'Product Manager',
    tagline: 'User value, prioritization, market fit',
    emoji: '🎯',
    builtIn: true,
    prompt:
      'You are a senior product manager. You prioritize features that deliver clear user value, address real user pain points, and align with the product\'s strategic direction. You think in terms of user stories, success metrics, jobs-to-be-done, and tradeoffs between scope and impact. You favor changes that move a meaningful metric over polish, and you frame proposals around the user need they solve.',
  },
  {
    id: 'builtin:senior-engineer',
    name: 'Senior Engineer',
    tagline: 'Architecture, dev experience, tech debt',
    emoji: '🏗️',
    builtIn: true,
    prompt:
      'You are a senior software engineer focused on code quality, architecture, and developer experience. You prioritize features that reduce tech debt, sharpen abstractions, improve testability, refine internal APIs, or make day-to-day development faster and safer. You\'re deeply pragmatic — small changes that compound matter to you. You ground proposals in actual files and patterns you\'ve read in the repo.',
  },
  {
    id: 'builtin:ux-designer',
    name: 'UX Designer',
    tagline: 'Flows, polish, accessibility',
    emoji: '🎨',
    builtIn: true,
    prompt:
      'You are a UX designer focused on the user-facing experience. You prioritize features that reduce friction in core flows, polish interactions, improve information density and visual hierarchy, fix accessibility gaps, and elevate the emotional quality of the product. You think in terms of moments — the precise instant where a user gets stuck, delighted, or confused — and you propose changes that target those moments.',
  },
  {
    id: 'builtin:growth-lead',
    name: 'Growth Lead',
    tagline: 'Activation, retention, virality',
    emoji: '📈',
    builtIn: true,
    prompt:
      'You are a growth lead focused on user acquisition, activation, retention, and viral mechanics. You prioritize features that improve onboarding, expose product value sooner, increase return engagement, create shareable moments, or open referral loops. You think in funnels and you frame proposals around which step they unlock and what the expected lift looks like.',
  },
  {
    id: 'builtin:reliability-engineer',
    name: 'Reliability Engineer',
    tagline: 'Robustness, observability, security',
    emoji: '🛡️',
    builtIn: true,
    prompt:
      'You are a reliability and security engineer. You prioritize features that improve robustness under failure, observability into production behavior, error recovery, performance under load, security posture, and operational ergonomics. You think about edge cases, partial failures, and what happens when assumptions break. You frame proposals around the specific failure mode or risk they mitigate.',
  },
];

const STORAGE_KEY = 'kanbots:personas:custom-v1';

type SavedPersona = Pick<Persona, 'id' | 'name' | 'prompt'>;

// Coordinator clients historically used unprefixed IDs for built-in roles.
// Match only known aliases: custom personas may legitimately share a name.
function personaIdentity(id: string): string {
  if (id === 'reliability') return 'builtin:reliability-engineer';
  return BUILTIN_PERSONAS.some(p => p.id === `builtin:${id}`) ? `builtin:${id}` : id;
}

export function mergeAutopilotPersonas(available: Persona[], saved: SavedPersona[]): Persona[] {
  const merged = new Map(available.map(p => [personaIdentity(p.id), p]));
  for (const persona of saved) {
    const key = personaIdentity(persona.id);
    const existing = merged.get(key);
    merged.set(key, {
      tagline: '', emoji: '✨', builtIn: false,
      ...existing,
      ...persona,
    });
  }
  return [...merged.values()];
}

interface StoredPersona {
  id: string;
  name: string;
  tagline: string;
  prompt: string;
  emoji?: string;
}

function readStored(): StoredPersona[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredPersona);
  } catch {
    return [];
  }
}

function isStoredPersona(value: unknown): value is StoredPersona {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.tagline === 'string' &&
    typeof v.prompt === 'string'
  );
}

function writeStored(personas: StoredPersona[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(personas));
}

export function listPersonas(): Persona[] {
  const custom: Persona[] = readStored().map((s) => ({
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    prompt: s.prompt,
    emoji: s.emoji ?? '✨',
    builtIn: false,
  }));
  return [...BUILTIN_PERSONAS, ...custom];
}

export interface CreatePersonaInput {
  name: string;
  tagline: string;
  prompt: string;
  emoji?: string;
}

export function createPersona(input: CreatePersonaInput): Persona {
  const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const stored: StoredPersona = {
    id,
    name: input.name.trim(),
    tagline: input.tagline.trim(),
    prompt: input.prompt.trim(),
    ...(input.emoji ? { emoji: input.emoji } : {}),
  };
  writeStored([...readStored(), stored]);
  return {
    id: stored.id,
    name: stored.name,
    tagline: stored.tagline,
    prompt: stored.prompt,
    emoji: stored.emoji ?? '✨',
    builtIn: false,
  };
}

export function deletePersona(id: string): void {
  if (id.startsWith('builtin:')) return;
  writeStored(readStored().filter((p) => p.id !== id));
}

/** Desktop library is authoritative; browser-only builds retain local storage. */
export async function loadPersonas(): Promise<Persona[]> {
 const bridge=getBridge();
 if(!bridge?.coordinatorState)return listPersonas();
 const state=await bridge.coordinatorState();
 const items=state.workspace?.personas?.items;
 if(!items)return listPersonas();
 return mergeAutopilotPersonas(listPersonas().filter(p=>!p.builtIn),items);
}
export async function savePersona(input:CreatePersonaInput & {id?:string}):Promise<Persona> {
 const bridge=getBridge();
 if(!bridge?.coordinatorAction)return createPersona(input);
 const persona={id:input.id??`custom:${crypto.randomUUID()}`,name:input.name.trim(),tagline:input.tagline.trim(),prompt:input.prompt.trim(),emoji:input.emoji||'✨'};
 const state=await bridge.coordinatorAction('upsert-persona',{persona,reason:'Owner created a custom persona in the app'});
 return state.workspace.personas.items.find((p:Persona)=>p.id===persona.id);
}
export async function removePersona(id:string):Promise<void> {
 const bridge=getBridge();
 const state=await bridge?.coordinatorState?.();
 if(state?.workspace?.personas?.items?.some((p:Persona)=>p.id===id)) {
  await bridge!.coordinatorAction!('remove-persona',{id,reason:'Owner removed a custom persona in the app'});
 } else deletePersona(id);
}
