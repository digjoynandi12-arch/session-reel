// LLM-written captions. Claude reads a digest of the whole session plus the
// detail of each picked beat, and returns a title and a headline/sub per beat.
//
// Runs through the Claude Code CLI (`claude -p`) on your existing Claude Code
// login — no API key. If the CLI is missing or fails, the rule-based captions
// from beats.js stay in place.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { coreCommand } from './beats.js';
import { redact } from './scenes.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const CaptionSchema = z.object({
  title: z.string().describe('3-6 word title for the whole session, shown on the intro card'),
  beats: z.array(z.object({
    index: z.number().int().describe('beat index, as given'),
    headline: z.string().describe('max ~36 characters'),
    sub: z.string().describe('max ~110 characters'),
  })),
});

const SYSTEM = `You write on-screen captions for a short vertical video that replays a Claude Code coding session, one scene per "beat".

Each beat scene already shows the raw material (the prompt bubble, the animated diff, or the terminal with its exit code). Your captions sit under it and tell the viewer what is happening and why it matters in the story of the session.

For every beat write:
- headline: at most ~36 characters, in large type. Say what happened in plain words, as an event in the story ("Pulls fog rules into one seam", "919 tests, all green"). Use a file name only when it is the point; write it exactly as given so it can be highlighted.
- sub: at most ~110 characters, one sentence. Give the reason or consequence the scene itself doesn't show: what changed, what this unblocked, what broke. Use specifics from the session (numbers, names), not generic praise.

Also write a 3-6 word title for the whole session (what the session achieved, not the project name).

Style: concrete, calm, present tense, no emojis, no exclamation marks, no hype words ("supercharge", "magic", "seamless"). Don't refer to "Claude", "the AI" or "the user" unless needed; describe the work. For the opening prompt beat, the headline frames the goal of the session. Never invent facts that are not in the material.`;

export async function llmCaptions(beats, meta, events, { model = DEFAULT_MODEL, log = () => {} } = {}) {
  if (!hasClaudeCli()) throw new Error('claude CLI not found on PATH');
  log(`captions: asking ${model} via claude CLI…`);
  const raw = await viaCli(buildPrompt(beats, meta, events), model);
  return CaptionSchema.parse(raw);
}

// Merge LLM captions into the beats; keep rule-based text wherever the model left a gap.
export function applyCaptions(beats, meta, res) {
  const clean = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  };
  for (const c of res.beats) {
    const b = beats[c.index];
    if (!b) continue;
    if (c.headline?.trim()) b.caption = clean(c.headline, 48);
    if (c.sub?.trim()) b.sub = clean(c.sub, 130);
  }
  if (res.title?.trim()) meta.title = clean(res.title, 60);
}

// ---------- prompt ----------

function buildPrompt(beats, meta, events) {
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const one = (s, n) => clip(String(s || '').replace(/\s+/g, ' ').trim(), n);
  const t0 = meta.start || 0;
  const at = (e) => (e.ts && t0 ? `${Math.round((e.ts - t0) / 60000)}m` : '');

  // Whole-session timeline, condensed: enough for the story, not every byte.
  const timeline = [];
  for (const e of events) {
    if (e.kind === 'prompt') timeline.push(`[${at(e)}] USER: ${one(e.text, 400)}`);
    else if (e.kind === 'say') timeline.push(`[${at(e)}] CLAUDE: ${one(e.text, 220)}`);
    else if (e.kind === 'edit') timeline.push(`[${at(e)}] ${e.created ? 'CREATE' : 'EDIT'} ${e.file} +${e.added} -${e.removed}`);
    else if (e.kind === 'bash') timeline.push(`[${at(e)}] $ ${one(coreCommand(e.command), 140)}  → ${e.interrupted ? 'interrupted' : 'exit ' + (e.exitCode ?? '?')}`);
  }
  let tl = timeline.join('\n');
  if (tl.length > 60000) tl = tl.slice(0, 20000) + '\n…(middle of session omitted)…\n' + tl.slice(-38000);

  const detail = beats.map((b) => {
    const e = b.event;
    let body;
    if (e.kind === 'prompt') body = `The user's prompt:\n${clip(e.text, 1500)}`;
    else if (e.kind === 'edit') {
      const lines = e.hunks.flatMap(h => h.lines || []).filter(l => /^[+-]/.test(l)).slice(0, 60);
      body = `${e.created ? 'New file' : 'Edit to'} ${e.file} (+${e.added} -${e.removed}). Changed lines (excerpt):\n${lines.join('\n')}`;
    } else {
      body = `Command:\n${clip(coreCommand(e.command), 600)}\nExit: ${e.interrupted ? 'interrupted' : e.exitCode}\nOutput tail:\n${(e.output || '').split('\n').slice(-20).join('\n')}`;
    }
    return `### Beat ${b.index} — ${b.role} at ${at(e)} (current draft caption: "${b.caption}")\n${body}`;
  }).join('\n\n');

  return redact(`Session: ${path.basename(meta.cwd || '') || 'unknown project'}${meta.gitBranch ? ` on branch ${meta.gitBranch}` : ''}, ${meta.start && meta.end ? Math.round((meta.end - meta.start) / 60000) : '?'} minutes.

<timeline>
${tl}
</timeline>

The video shows these ${beats.length} beats, in order:

${detail}

Write the title and one caption per beat (indices 0-${beats.length - 1}).`);
}

// ---------- backends ----------

function hasClaudeCli() {
  return spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
}

// Claude Code in print mode: no tools, no MCP, no settings, no saved session.
function viaCli(prompt, model) {
  const { $schema, ...schemaBody } = z.toJSONSchema(CaptionSchema);
  const schema = JSON.stringify(schemaBody);
  const args = ['-p', '--output-format', 'json', '--model', model, '--json-schema', schema,
    '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('claude CLI timed out after 5 min')); }, 300000);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 300)}`));
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(`claude: ${String(res.result).slice(0, 300)}`));
        if (res.structured_output) return resolve(res.structured_output);
        const m = String(res.result || '').match(/\{[\s\S]*\}/);
        if (!m) return reject(new Error('claude returned no JSON'));
        resolve(JSON.parse(m[0]));
      } catch (e) { reject(e); }
    });
    p.stdin.end(prompt);
  });
}
