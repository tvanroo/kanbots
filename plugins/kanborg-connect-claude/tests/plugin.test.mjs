// Structural and parity checks for the Claude kanborg-connect plugin.
// Run: node --test plugins/kanborg-connect-claude/tests/plugin.test.mjs
// Optional: KANBORG_MCP_SOURCE=/path/to/packages/mcp/src also checks that every
// tool named in the skills exists in that KanBorg MCP source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(root, 'skills');
const skills = readdirSync(skillsDir);
const read = (p) => readFileSync(p, 'utf8');

// Skills shipped by the Codex/ChatGPT kanborg-connect 0.2.0 plugin.
const CODEX_SKILLS = ['kanborg-coordinate', 'kanborg-handoff', 'kanborg-mobile', 'kanborg-projects'];

test('manifest is valid and matches the Codex plugin identity', () => {
  const m = JSON.parse(read(join(root, '.claude-plugin', 'plugin.json')));
  assert.equal(m.name, 'kanborg-connect');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
});

test('marketplace entry points at this plugin', () => {
  const mp = JSON.parse(read(join(root, '..', '..', '.claude-plugin', 'marketplace.json')));
  const entry = mp.plugins.find((p) => p.name === 'kanborg-connect');
  assert.ok(entry);
  assert.equal(resolve(root, '..', '..', entry.source), root);
});

test('every Codex skill has a Claude counterpart', () => {
  for (const s of CODEX_SKILLS) assert.ok(skills.includes(s), `missing ${s}`);
});

test('skills have valid frontmatter whose name matches the folder', () => {
  for (const s of skills) {
    const text = read(join(skillsDir, s, 'SKILL.md'));
    const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(fm, `${s} frontmatter`);
    assert.equal(fm[1].trim(), s);
    assert.ok(fm[2].length <= 1024);
  }
});

test('relative links resolve', () => {
  const files = [join(root, 'README.md'), join(root, 'references', 'receiver-protocol.md'),
    ...skills.map((s) => join(skillsDir, s, 'SKILL.md'))];
  for (const f of files) {
    for (const [, href] of read(f).matchAll(/\]\(((?:\.\.?\/)[^)#]+)\)/g)) {
      assert.ok(existsSync(resolve(dirname(f), href)), `${f}: ${href}`);
    }
  }
});

test('no credentials, hardcoded chat UUIDs or bundled MCP config', () => {
  assert.ok(!existsSync(join(root, '.mcp.json')));
  for (const s of skills) {
    const text = read(join(skillsDir, s, 'SKILL.md'));
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9]/);
  }
});

const src = process.env.KANBORG_MCP_SOURCE;
// Argument and field names that appear in backticks but are not tools.
const FIELDS = new Set(['hostId', 'chatId', 'adapterId', 'adapterIds', 'handoffId', 'requestId', 'checkIn']);
test('tools named in skills exist in the KanBorg MCP source', { skip: !src && 'set KANBORG_MCP_SOURCE' }, () => {
  const source = readdirSync(src).filter((f) => f.endsWith('.ts')).map((f) => read(join(src, f))).join('\n');
  const published = new Set([...source.matchAll(/(?:tool|add)\('([A-Za-z]+)'|name: *'([A-Za-z]+)'/g)].map((m) => m[1] ?? m[2]));
  const files = [join(root, 'references', 'receiver-protocol.md'), ...skills.map((s) => join(skillsDir, s, 'SKILL.md'))];
  for (const f of files) {
    for (const [, name] of read(f).matchAll(/`([a-z]+[A-Z][A-Za-z]+)`/g)) {
      if (FIELDS.has(name)) continue;
      assert.ok(published.has(name), `${f}: ${name} is not a published KanBorg tool`);
    }
  }
});
