// Parse a Claude Code session transcript (.jsonl) into a flat list of events:
//   prompt — something the human typed (or a slash command with args)
//   edit   — a file change, with unified-diff hunks
//   bash   — a shell command, with exit code and output tail
//   say    — assistant prose (kept for context/captions, not printed by default)
import fs from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';

const HOME = os.homedir();

export async function parseTranscript(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const pending = new Map(); // tool_use id -> { name, input, ts }
  const seenUuid = new Set();
  const seenResult = new Set();
  const events = [];
  const meta = { file, sessionId: null, cwd: null, gitBranch: null, title: null, start: null, end: null };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.type === 'ai-title' && o.aiTitle) meta.title = o.aiTitle;
    if (o.type === 'summary' && o.summary && !meta.title) meta.title = o.summary;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain) continue;
    if (o.uuid) { if (seenUuid.has(o.uuid)) continue; seenUuid.add(o.uuid); }

    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (ts) { meta.start ??= ts; meta.end = ts; }
    meta.sessionId ??= o.sessionId;
    meta.cwd ??= o.cwd;
    meta.gitBranch ??= o.gitBranch;

    const content = o.message?.content;

    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') pending.set(block.id, { name: block.name, input: block.input || {}, ts });
        else if (block.type === 'text' && block.text?.trim()) events.push({ kind: 'say', ts, text: block.text.trim() });
      }
      continue;
    }

    // user record: either tool results or a prompt
    if (Array.isArray(content) && content.some(b => b.type === 'tool_result')) {
      for (const block of content) {
        if (block.type !== 'tool_result' || seenResult.has(block.tool_use_id)) continue;
        seenResult.add(block.tool_use_id);
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        const ev = toolEvent(call, block, o.toolUseResult, ts);
        if (ev) events.push(...[].concat(ev));
      }
      continue;
    }

    const prompt = promptFrom(o);
    if (prompt) events.push({ kind: 'prompt', ts, text: prompt });
  }

  events.forEach((e, i) => { e.i = i; });
  meta.cwd = meta.cwd || '';
  return { meta, events };
}

// ---------- prompts ----------

const NOT_HUMAN = /^(<local-command-|<bash-(input|stdout|stderr)>|Caveat:|Another Claude session sent a message|<task-notification|<agent-message|\[Request interrupted|Base directory for this skill)/;

function promptFrom(o) {
  if (o.isMeta) return null;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return null;
  const c = o.message?.content;
  let text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
  text = (text || '').trim();
  if (!text || NOT_HUMAN.test(text)) return null;

  const cmd = text.match(/<command-name>\s*\/?([^<]+?)\s*<\/command-name>/);
  if (cmd) {
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '').trim();
    if (['clear', 'compact', 'model', 'login', 'logout', 'resume', 'config', 'cost', 'exit'].includes(cmd[1])) return null;
    return `/${cmd[1]}${args ? ' ' + args : ''}`;
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted]')
    .trim();
  return text || null;
}

// ---------- tool calls ----------

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function toolEvent(call, block, tur, ts) {
  const { name, input } = call;
  const out = resultText(block);
  const isErr = !!block.is_error;

  if (name === 'Bash') {
    const r = tur && typeof tur === 'object' ? tur : {};
    let exitCode = 0;
    const m = out.match(/^Exit code (\d+)/);
    if (m) exitCode = Number(m[1]);
    else if (isErr) exitCode = null; // denied / errored before running
    let stdout = r.stdout ?? out.replace(/^Exit code \d+\n?/, '');
    const stderr = r.stderr ?? '';
    const ev = {
      kind: 'bash', ts,
      command: input.command || '',
      description: input.description || '',
      exitCode,
      interrupted: !!r.interrupted,
      denied: isErr && exitCode === null,
      background: !!input.run_in_background,
      output: tail(clean(`${stdout}${stderr ? '\n' + stderr : ''}`), 40),
    };
    const evs = [ev];
    // Bash commands that edited files (sed -i, heredocs…) carry a diff too.
    if (r.bashEditDiff) {
      try {
        const d = typeof r.bashEditDiff === 'string' ? JSON.parse(r.bashEditDiff) : r.bashEditDiff;
        for (const f of d.files || []) evs.push(editEvent({ ts, file: f.filePath, hunks: f.hunks, via: 'bash' }));
      } catch {}
    }
    return evs;
  }

  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') {
    if (isErr) return null;
    const r = tur && typeof tur === 'object' ? tur : {};
    const file = r.filePath || input.file_path || input.notebook_path;
    let hunks = parseMaybe(r.structuredPatch);
    let created = r.type === 'create';
    if ((!hunks || !hunks.length) && name === 'Write') {
      const body = r.content ?? input.content ?? '';
      const lines = body.split('\n');
      hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => '+' + l) }];
      created = true;
    }
    if ((!hunks || !hunks.length) && (input.old_string != null || input.edits)) {
      const pairs = input.edits || [{ old_string: input.old_string, new_string: input.new_string }];
      hunks = pairs.map(p => ({
        oldStart: 1, newStart: 1,
        lines: [...(p.old_string || '').split('\n').map(l => '-' + l), ...(p.new_string || '').split('\n').map(l => '+' + l)],
      }));
    }
    if (!hunks || !hunks.length) return null;
    return editEvent({ ts, file, hunks, created, via: name });
  }
  return null;
}

function editEvent({ ts, file, hunks, created = false, via }) {
  let added = 0, removed = 0;
  for (const h of hunks) for (const l of h.lines || []) {
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { kind: 'edit', ts, file: tildify(file || '?'), created, via, added, removed, hunks };
}

// ---------- helpers ----------

function parseMaybe(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}
function tail(s, n) { const l = s.split('\n'); return l.slice(Math.max(0, l.length - n)).join('\n'); }
function clean(s) { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trimEnd(); }
export function tildify(p) { return p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p; }
