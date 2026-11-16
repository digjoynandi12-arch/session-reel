// Score every event and keep the N most telling ones, in story order.
import path from 'node:path';

const READ_ONLY = /^(cat|sed -n|grep|rg|ls|find|head|tail|wc|tree|pwd|echo|printf|which|file|stat|open|mkdir|du|diff|jq|sort|uniq|awk|less|bat|sleep|true|for|do|done)\b|^git (log|status|diff|show|branch|blame|rev-parse|remote|ls-files|switch|checkout)\b|^\S*(python3?|node) -c\b/;
const TEST = /^(\S*\/)?(pytest|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox)\b|^(npm|pnpm|yarn|bun|deno) (run )?test\b|^(go|cargo|swift|dotnet|mvn|gradle|\.\/gradlew|make|mix|xcodebuild) test\b|^\S*python3? -m (pytest|unittest)\b|^node --test\b|^\S*(run_tests|test)\.sh\b|gut_cmdln|^\S*\/check\.sh\b/;
const BUILD = /^(\S*\/)?(tsc|eslint|ruff|mypy|xcodebuild|webpack|vite build)\b|^(npm|pnpm|yarn|bun) (run )?(build|lint|typecheck)\b|^(cargo (build|check)|go build|make)\b|--import\b/;
const COMMIT = /^git commit\b/;
const SHIP = /^git push\b|^gh pr (create|merge)\b|^(npm|pnpm) publish\b/;
const NOISE_FILE = /(\.uid|\.lock|-lock\.json|\.snap)$|\/(scratchpad|tmp)\//;
const LOW_PROMPT = /^(y|yes|yep|ok|okay|sure|go|continue|do it|okay do it|proceed|thanks|ty|lgtm)[.!]*$/i;

// Strip `cd somewhere &&` and env prefixes so we judge the command that matters.
export function coreCommand(cmd) {
  let s = cmd.trim();
  for (;;) {
    const m = s.match(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.replace(/^(\w+=\S+\s+)+/, '');
}

// Each simple command in a pipeline/list, heredoc bodies removed.
function segments(cmd) {
  const s = cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, '<<HEREDOC');
  return s.split(/\s*(?:&&|\|\||;|\||\n|\(|\)|\bdo\b|\bthen\b)\s*/)
    .map(x => x.trim().replace(/^(\w+=\S+\s+)+/, '').replace(/^(timeout \d+|time|uv run|npx|bunx)\s+/, ''))
    .filter(Boolean);
}

export function commandKind(e) {
  const segs = segments(e.command);
  if (segs.some(x => COMMIT.test(x))) return 'commit';
  if (segs.some(x => SHIP.test(x))) return 'ship';
  if (segs.some(x => TEST.test(x))) return 'test';
  if (segs.some(x => BUILD.test(x))) return 'build';
  if (segs.every(x => READ_ONLY.test(x) || x.startsWith('cd ') || x.startsWith('<<'))) return 'read';
  return 'run';
}

// Pipes to tail/grep hide the runner's exit code; read the output too.
function outputFailed(out = '') {
  return /\b[1-9]\d* (failed|failing|errors?)\b|^FAILED\b|^Failing Tests\b|Traceback \(most recent|^npm ERR!/m.test(out)
    && !/\b0 (failed|failing)\b/.test(out);
}

function signature(e) {
  const c = coreCommand(e.command).split('\n')[0];
  return c.split(/\s+/).slice(0, 2).join(' ');
}

export function pickBeats(events, meta, n = 6) {
  const scored = [];
  const prompts = events.filter(e => e.kind === 'prompt');
  const firstPrompt = prompts[0];
  const lastFail = new Map(); // signature -> failing event

  for (const e of events) {
    let score = 0, role = '';
    if (e.kind === 'prompt') {
      role = e === firstPrompt ? 'ask' : 'redirect';
      score = e === firstPrompt ? 1000 : LOW_PROMPT.test(e.text.trim()) ? 2 : 10 + Math.min(25, e.text.length / 15);
    } else if (e.kind === 'edit') {
      if (NOISE_FILE.test(e.file)) continue;
      role = e.created ? 'create' : 'edit';
      const size = e.added + e.removed;
      score = 6 + 5 * Math.log2(1 + Math.min(size, 300));
      if (e.created) score += 6;
      if (/(^|\/)(test|tests|spec|__tests__)\/|[._-](test|spec)\./.test(e.file)) score += 3;
      if (e.removed > 0 && e.added > 0) score += 3; // a real change, not just an append
    } else if (e.kind === 'bash') {
      if (e.background || e.denied) continue;
      const k = commandKind(e);
      e.cmdKind = k;
      const ok = e.exitCode === 0 && !e.interrupted && !((k === 'test' || k === 'build') && outputFailed(e.output));
      e.ok = ok;
      const sig = signature(e);
      if (k === 'read') { score = ok ? 1 : 3; role = 'look'; }
      else if (k === 'test') { score = ok ? 40 : 44; role = ok ? 'pass' : 'fail'; }
      else if (k === 'build') { score = ok ? 14 : 30; role = ok ? 'build' : 'fail'; }
      else if (k === 'commit') { score = 40; role = 'commit'; }
      else if (k === 'ship') { score = 44; role = 'ship'; }
      else { score = ok ? 6 : 14; role = ok ? 'run' : 'fail'; }
      if (!ok && k !== 'read') lastFail.set(sig, e);
      else if (ok && lastFail.has(sig)) { score += 25; role = 'fixed'; e.fixedFrom = lastFail.get(sig).i; lastFail.delete(sig); }
    } else continue;
    scored.push({ event: e, score, role });
  }

  // Greedy pick with diversity: repeated files and kinds lose value.
  const picked = [];
  const fileCount = new Map(), kindCount = new Map(), roleCount = new Map();
  const pool = [...scored];
  while (picked.length < n && pool.length) {
    let best = -1, bestVal = -Infinity;
    pool.forEach((s, idx) => {
      let v = s.score;
      const f = s.event.file;
      if (f && fileCount.get(f)) v *= 0.35 ** fileCount.get(f);
      const kc = kindCount.get(s.event.kind) || 0;
      if (kc >= 2) v *= 0.55 ** (kc - 1);
      // a second 'Tests pass' reads as a rerun; a second edit is at least a different file
      v *= (s.event.kind === 'bash' ? 0.2 : 0.5) ** (roleCount.get(s.role) || 0);
      // spread beats over the session: penalize near-neighbours of picked beats
      for (const p of picked) if (Math.abs(p.event.i - s.event.i) <= 1) v *= 0.6;
      if (v > bestVal) { bestVal = v; best = idx; }
    });
    const [s] = pool.splice(best, 1);
    if (s.score < 2 && picked.length >= 5) break;
    picked.push(s);
    if (s.event.file) fileCount.set(s.event.file, (fileCount.get(s.event.file) || 0) + 1);
    kindCount.set(s.event.kind, (kindCount.get(s.event.kind) || 0) + 1);
    roleCount.set(s.role, (roleCount.get(s.role) || 0) + 1);
  }

  picked.sort((a, b) => a.event.i - b.event.i);
  return picked.map((b, idx) => ({ ...b, index: idx, ...caption(b, events, meta) }));
}

// ---------- captions ----------

function caption({ event: e, role }, events) {
  const name = e.file ? path.basename(e.file) : '';
  if (e.kind === 'prompt') {
    return { caption: role === 'ask' ? 'The ask' : 'Change of plan', sub: '' };
  }
  if (e.kind === 'edit') {
    const verb = e.created ? 'Created' : e.removed > e.added * 1.5 ? 'Trimmed' : e.added > 0 && e.removed === 0 ? 'Extended' : 'Rewrote';
    return { caption: `${verb} ${name}`, sub: context(e, events) };
  }
  const summary = testSummary(e.output);
  switch (role) {
    case 'pass': return { caption: 'Tests pass', sub: summary || context(e, events) };
    case 'fail': return { caption: e.cmdKind === 'test' ? 'Tests fail' : `Exit ${e.exitCode ?? '?'}`, sub: summary || firstErrorLine(e.output) };
    case 'fixed': return { caption: 'Fixed — green again', sub: summary || context(e, events) };
    case 'commit': return { caption: 'Committed', sub: commitMessage(e.command) };
    case 'ship': { const t = e.command.match(/--title\s+(["'])(.*?)\1/); return { caption: /gh pr create/.test(e.command) ? 'Opened a PR' : 'Shipped', sub: t ? t[2] : segments(e.command).find(x => SHIP.test(x)) || '' }; }
    case 'build': return { caption: 'Build passes', sub: context(e, events) };
    default: return { caption: e.description || 'Ran a command', sub: context(e, events) };
  }
}

// The assistant's own words just before this event, trimmed to one sentence.
function context(e, events) {
  for (let i = e.i - 1; i >= 0 && i >= e.i - 6; i--) {
    const p = events[i];
    if (p.kind === 'prompt') break;
    if (p.kind === 'say') {
      const s = p.text.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
      const first = (s.match(/^.{12,140}?[.!?](\s|$)/) || [s])[0].trim();
      return first.length > 120 ? first.slice(0, 117) + '…' : first;
    }
  }
  return e.description || '';
}

function testSummary(out = '') {
  const t = out.replace(/[ \t]+/g, ' ');
  let m;
  if ((m = t.match(/Passing Tests (\d+)/))) {
    const f = t.match(/Failing Tests (\d+)/);
    return `${m[1]} passing${f && f[1] !== '0' ? `, ${f[1]} failing` : ''}`;
  }
  if ((m = t.match(/Tests: ([^\n]+)/))) return m[1].trim();
  const lines = t.split('\n').reverse();
  for (const l of lines) {
    if (/\b\d+ (passed|failed|passing|failing)\b/i.test(l) && l.length < 120) return l.replace(/^[=\s]+|[=\s]+$/g, '');
  }
  if (/all tests passed/i.test(t)) return 'All tests passed';
  return '';
}
function firstErrorLine(out = '') {
  const l = out.split('\n').find(x => /error|fail|exception|traceback|not found/i.test(x));
  return (l || '').trim().slice(0, 110);
}
function commitMessage(cmd) {
  const m = cmd.match(/-m\s+(["'])([\s\S]*?)\1/) || cmd.match(/<<-?\s*'?(\w+)'?\n([\s\S]*?)\n\1/);
  return m ? m[2].split('\n')[0].trim().slice(0, 110) : '';
}
