// Turn beats into standalone 1080x1920 HTML scenes. Every scene exposes
// window.__scene = { duration, seek(t) } and draws purely from t, so the
// renderer can step it frame by frame. Opened in a browser, it autoplays.
import fs from 'node:fs';
import path from 'node:path';
import { coreCommand } from './beats.js';
import { tildify } from './parse.js';

export const W = 1080, H = 1920;

const ACCENT = {
  intro: '#7aa2ff', ask: '#7aa2ff', redirect: '#7aa2ff',
  edit: '#f5b84a', create: '#c58cff',
  pass: '#3fd68a', fixed: '#3fd68a', build: '#3fd68a',
  fail: '#ff5d6c', commit: '#3fd6c6', ship: '#3fd6c6',
  run: '#9aa4b2', look: '#9aa4b2',
};
const CHIP = {
  ask: 'PROMPT', redirect: 'PROMPT', edit: 'EDIT', create: 'NEW FILE', pass: 'TESTS', fixed: 'FIXED',
  build: 'BUILD', fail: 'FAILURE', commit: 'COMMIT', ship: 'SHIP', run: 'SHELL', look: 'SHELL',
};

export function writeScenes(beats, meta, events, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^\d\d-.*\.html$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const project = path.basename(meta.cwd || '') || 'session';
  const total = beats.length + 1;
  const scenes = [];
  const add = (slug, s) => {
    const file = path.join(dir, `${String(scenes.length).padStart(2, '0')}-${slug}.html`);
    fs.writeFileSync(file, page({ ...s, index: scenes.length, total, project }));
    scenes.push({ file, duration: s.duration });
  };

  add('intro', intro(meta, events, project));
  for (const b of beats) {
    const e = b.event;
    const at = meta.start && e.ts ? clock(e.ts - meta.start) : '';
    const common = { role: b.role, at, caption: b.caption, sub: b.sub, highlight: e.file ? path.basename(e.file) : '' };
    if (e.kind === 'prompt') add(`prompt`, { ...common, ...promptScene(e) });
    else if (e.kind === 'edit') add(`edit-${slug(path.basename(e.file))}`, { ...common, ...diffScene(e) });
    else add(`bash-${b.role}`, { ...common, ...bashScene(e, b) });
  }
  fs.writeFileSync(path.join(dir, 'index.html'), indexPage(scenes, project));
  return scenes;
}

// ---------- scene bodies ----------

function intro(meta, events, project) {
  const edits = events.filter(e => e.kind === 'edit' && !/\.uid$|\/(scratchpad|tmp)\//.test(e.file));
  const files = new Set(edits.map(e => e.file)).size;
  const added = edits.reduce((s, e) => s + e.added, 0);
  const removed = edits.reduce((s, e) => s + e.removed, 0);
  const cmds = events.filter(e => e.kind === 'bash').length;
  const prompts = events.filter(e => e.kind === 'prompt').length;
  const mins = meta.start && meta.end ? Math.max(1, Math.round((meta.end - meta.start) / 60000)) : 0;
  const date = meta.start ? new Date(meta.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const stats = [
    [mins, 'minutes'], [prompts, prompts === 1 ? 'prompt' : 'prompts'], [cmds, 'commands'],
    [files, files === 1 ? 'file changed' : 'files changed'], [added, 'lines added', '+', 'add'], [removed, 'lines removed', '−', 'del'],
  ];
  const body = `
  <div class="intro">
    <div class="kicker" data-in="0.15" data-anim="up">A Claude Code session · ${esc(date)}</div>
    <h1 data-in="0.3" data-anim="up">${esc(redact(project))}</h1>
    ${meta.title ? `<div class="subtitle" data-in="0.5" data-anim="up">“${esc(redact(meta.title))}”</div>` : ''}
    ${meta.gitBranch ? `<div class="branch" data-in="0.6" data-anim="up"><span>⎇</span> ${esc(meta.gitBranch)}</div>` : ''}
    <div class="stats">
      ${stats.map(([n, label, pre = '', cls = ''], i) => `
      <div class="stat ${cls}" data-in="${(0.8 + i * 0.12).toFixed(2)}" data-anim="pop">
        <b>${pre}<span data-count="${n}" data-in="${(0.8 + i * 0.12).toFixed(2)}" data-dur="0.9">0</span></b><small>${label}</small>
      </div>`).join('')}
    </div>
  </div>`;
  return { kind: 'intro', role: 'intro', duration: 3.4, body, at: '', caption: '', sub: '' };
}

function promptScene(e) {
  let text = redact(e.text).replace(/\s+\n/g, '\n').trim();
  if (text.length > 330) text = text.slice(0, 320).replace(/\s+\S*$/, '') + ' …';
  const size = text.length < 70 ? 66 : text.length < 160 ? 54 : text.length < 260 ? 46 : 40;
  const typeDur = Math.min(2.4, 0.35 + text.length / 90);
  const body = `
  <div class="chat">
    <div class="who" data-in="0.2" data-anim="up"><span class="avatar">you</span></div>
    <div class="bubble" data-in="0.3" data-anim="up" style="font-size:${size}px"><span data-type="${attr(text)}" data-in="0.45" data-dur="${typeDur.toFixed(2)}"></span><span class="caret" data-caret="${(0.45 + typeDur).toFixed(2)}"></span></div>
    <div class="reply" data-in="${(0.75 + typeDur).toFixed(2)}" data-anim="up">
      <span class="avatar claude">✳︎</span><span class="dots"><i data-bounce="0"></i><i data-bounce="0.15"></i><i data-bounce="0.3"></i></span>
    </div>
  </div>`;
  return { kind: 'prompt', duration: Math.max(4.2, 0.45 + typeDur + 2.0), body };
}

function diffScene(e) {
  const ext = path.extname(e.file).slice(1).toLowerCase();
  let rows = diffRows(e.hunks);
  const longest = Math.min(64, Math.max(20, ...rows.map(r => (r.text || '').length)));
  const font = Math.round(Math.max(24, Math.min(30, 840 / (longest * 0.602))));
  const lh = Math.round(font * 1.5);
  const maxRows = Math.floor(1000 / lh);
  rows = pickWindow(rows, maxRows);
  const maxChars = Math.floor(840 / (font * 0.602));

  const start = 0.7;
  const step = Math.min(0.11, 2.4 / Math.max(rows.length, 1));
  let addN = 0, delN = 0;
  const lines = rows.map((r, i) => {
    const t = (start + i * step).toFixed(2);
    if (r.type === 'gap') return `<div class="ln gap" data-in="${t}" data-anim="fade"><span class="no"></span><span class="sg"></span><span class="code">⋯</span></div>`;
    const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : '';
    if (r.type === 'add') addN++; if (r.type === 'del') delN++;
    const code = highlight(clip(redact(r.text.replace(/\t/g, '  ')), maxChars), ext);
    const extra = r.type === 'del' ? ` data-strike="${(+t + 0.35).toFixed(2)}"` : r.type === 'add' ? ` data-flash="${t}"` : '';
    return `<div class="ln ${r.type}" data-in="${t}" data-anim="${r.type === 'ctx' ? 'fade' : 'slide'}"${extra}><span class="no">${r.no ?? ''}</span><span class="sg">${sign}</span><span class="code">${code || '&nbsp;'}</span>${r.type === 'del' ? '<span class="strike"></span>' : ''}</div>`;
  }).join('');
  const revealEnd = start + rows.length * step;
  const dir = path.dirname(tildify(e.file));
  const body = `
  <div class="window editor" data-in="0.1" data-anim="up">
    <div class="titlebar">
      <span class="lights"><i></i><i></i><i></i></span>
      <span class="path"><span class="dir">${esc(clipLeft(dir, 34))}/</span><b>${esc(path.basename(e.file))}</b></span>
      <span class="delta"><span class="add">+<span data-count="${e.added}" data-in="${start}" data-dur="${(revealEnd - start).toFixed(2)}">0</span></span> <span class="del">−<span data-count="${e.removed}" data-in="${start}" data-dur="${(revealEnd - start).toFixed(2)}">0</span></span></span>
    </div>
    <div class="diff" style="font-size:${font}px;line-height:${lh}px">${lines}</div>
  </div>`;
  return { kind: 'edit', duration: Math.max(5, revealEnd + 2.4), body };
}

function bashScene(e, b) {
  let cmd = redact(tildify(coreCommand(e.command)));
  // collapse heredoc bodies to one line
  cmd = cmd.replace(/(<<-?\s*(['"]?)(\w+)\2)[^\n]*\n([\s\S]*?)\n\s*\3\b/g, (_, open, __, tag, bodyText) => `${open} … ${bodyText.split('\n').length} lines … ${tag}`);
  const cmdLines = cmd.split('\n').filter(Boolean);
  const shown = cmdLines.slice(0, 4).map(l => clip(l, 44));
  if (cmdLines.length > 4) shown[3] = clip(shown[3], 40) + ' …';
  const cmdText = shown.join('\n');
  const typeDur = Math.min(1.4, 0.3 + cmdText.length / 120);

  let out = redact(tildify(e.output || '')).split('\n').map(l => l.replace(/\t/g, '  ')).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  if (!out.length) out = ['(no output)'];
  out = out.slice(-15).map(l => clip(l, 54));
  const o0 = 0.4 + typeDur + 0.25;
  const ostep = Math.min(0.09, 1.3 / out.length);
  const outHtml = out.map((l, i) => `<div class="out" data-in="${(o0 + i * ostep).toFixed(2)}" data-anim="fade">${esc(l) || '&nbsp;'}</div>`).join('');
  const badgeAt = o0 + out.length * ostep + 0.25;
  const ok = b.role === 'fail' ? false : e.exitCode === 0 && !e.interrupted;
  const code = e.interrupted ? 'interrupted' : `exit ${e.exitCode ?? '?'}`;
  const body = `
  <div class="window term" data-in="0.1" data-anim="up">
    <div class="titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="path"><span class="dir">zsh</span></span></div>
    <div class="termbody">
      <div class="cmdline"><span class="ps1">$</span> <span class="cmd" data-type="${attr(cmdText)}" data-in="0.4" data-dur="${typeDur.toFixed(2)}"></span><span class="caret" data-caret="${(0.4 + typeDur).toFixed(2)}" data-caret-off="${o0.toFixed(2)}"></span></div>
      ${outHtml}
    </div>
    <div class="badge ${ok ? 'ok' : 'bad'}" data-in="${badgeAt.toFixed(2)}" data-anim="stamp">${ok ? '✓' : '✗'} ${esc(code)}</div>
  </div>`;
  return { kind: 'bash', duration: Math.max(5, badgeAt + 2.3), body };
}

// ---------- diff helpers ----------

function diffRows(hunks) {
  const rows = [];
  hunks.forEach((h, hi) => {
    if (hi > 0) rows.push({ type: 'gap' });
    let oldNo = h.oldStart || 1, newNo = h.newStart || 1;
    const run = [];
    const flush = () => {
      if (run.length > 5) rows.push(run[0], run[1], { type: 'gap' }, run[run.length - 2], run[run.length - 1]);
      else rows.push(...run);
      run.length = 0;
    };
    for (const l of h.lines || []) {
      const c = l[0], text = l.slice(1);
      if (c === '\\') continue;
      if (c === '+') { flush(); rows.push({ type: 'add', text, no: newNo++ }); }
      else if (c === '-') { flush(); rows.push({ type: 'del', text, no: oldNo++ }); }
      else { run.push({ type: 'ctx', text, no: newNo }); oldNo++; newNo++; }
    }
    flush();
  });
  while (rows.length && rows[0].type === 'gap') rows.shift();
  return rows;
}

// The window of `n` rows with the most changed lines, nudged to start on context.
function pickWindow(rows, n) {
  if (rows.length <= n) return rows;
  const changed = rows.map(r => (r.type === 'add' || r.type === 'del' ? 1 : 0));
  let best = 0, bestScore = -1, sum = changed.slice(0, n).reduce((a, b) => a + b, 0);
  for (let s = 0; s + n <= rows.length; s++) {
    if (s > 0) sum += changed[s + n - 1] - changed[s - 1];
    // prefer windows that begin with content, not a blank line
    const score = sum + (rows[s].text?.trim() ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  const firstChange = rows.findIndex((r, i) => i >= best && changed[i]);
  const start = Math.max(0, Math.min(best, firstChange - 2));
  return rows.slice(start, start + n);
}

const KW = 'func|var|const|let|return|if|elif|else|for|while|in|def|class|class_name|extends|import|from|export|default|function|async|await|new|true|false|null|None|True|False|self|this|static|signal|match|pass|break|continue|try|catch|except|finally|raise|throw|and|or|not|is|type|interface|struct|enum|pub|fn|impl|use|mod|package|public|private|protected|void|int|float|bool|str|string|lambda|with|as|yield|switch|case';
function highlight(raw, ext) {
  const hashC = ['py', 'gd', 'sh', 'zsh', 'bash', 'rb', 'yml', 'yaml', 'toml', 'r', 'pl', 'cfg', 'conf'].includes(ext);
  const slashC = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cc', 'swift', 'kt', 'cs', 'php', 'scss', 'dart'].includes(ext);
  const plain = ['md', 'txt', 'html', 'csv', 'json', 'svg', 'xml'].includes(ext);
  if (plain) return esc(raw);
  const comment = hashC ? '(?:^|(?<=\\s))#.*$' : slashC ? '\\/\\/.*$' : '(?:(?:^|(?<=\\s))#|\\/\\/).*$';
  const re = new RegExp(`(${comment})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|\\b(${KW})\\b|\\b([A-Z][A-Za-z0-9_]+)\\b|(\\b[a-z_][A-Za-z0-9_]*)(?=\\()`, 'g');
  let html = '', last = 0, m;
  while ((m = re.exec(raw))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    html += esc(raw.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'k' : m[5] ? 't' : 'f';
    html += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return html + esc(raw.slice(last));
}

// ---------- page shell ----------

function page({ kind, role, duration, body, index, total, project, at, caption, sub, highlight: hl }) {
  const accent = ACCENT[role] || '#7aa2ff';
  let cap = esc(redact(caption || ''));
  if (hl) cap = cap.replace(esc(hl), `<em>${esc(hl)}</em>`);
  const segs = Array.from({ length: total }, (_, i) => `<i data-seg="${i < index ? 1 : i === index ? 'cur' : 0}"><b></b></i>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=${W}">
<title>${esc(project)} · scene ${index}</title>
<style>${CSS}
:root{--accent:${accent}}
</style></head>
<body><div id="stage">
  <div class="bg"></div>
  <div class="progress">${segs}</div>
  <header><span class="brand"><span class="mark">▶</span> session-reel · ${esc(redact(project))}</span><span class="at">${at ? `${at} in` : ''}</span></header>
  ${CHIP[role] ? `<div class="chip" data-in="0.05" data-anim="up"><span class="dot"></span>${CHIP[role]}</div>` : ''}
  <main class="${kind}">${body}</main>
  ${caption ? `<footer>
    <div class="cap" data-in="0.35" data-anim="up">${cap}</div>
    ${sub ? `<div class="sub" data-in="0.6" data-anim="up">${esc(redact(sub))}</div>` : ''}
  </footer>` : ''}
</div>
<script>window.__SCENE = { duration: ${duration.toFixed(2)} };
${RUNTIME}</script>
</body></html>`;
}

const RUNTIME = String.raw`
(function(){
  const D = window.__SCENE.duration;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const back = (x) => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const q = (s) => Array.from(document.querySelectorAll(s));
  const stage = document.getElementById('stage');
  const reveal = q('[data-in][data-anim]'), typers = q('[data-type]'), counters = q('[data-count]');
  const carets = q('[data-caret]'), strikes = q('[data-strike]'), flashes = q('[data-flash]');
  const bouncers = q('[data-bounce]'), segs = q('[data-seg]');
  function render(t) {
    stage.style.opacity = Math.min(clamp(t / 0.25), clamp((D - t) / 0.3));
    for (const el of reveal) {
      const p = clamp((t - +el.dataset.in) / (+el.dataset.dur || 0.45)), e = ease(p);
      const a = el.dataset.anim;
      el.style.opacity = a === 'stamp' ? clamp(p * 3) : e;
      el.style.transform =
        a === 'up' ? 'translateY(' + (1 - e) * 40 + 'px)' :
        a === 'slide' ? 'translateX(' + (1 - e) * 36 + 'px)' :
        a === 'pop' ? 'scale(' + (0.85 + 0.15 * back(p)) + ')' :
        a === 'stamp' ? 'scale(' + (p < 1 ? 1.6 - 0.6 * back(p) : 1) + ') rotate(' + (-6 + 6 * e) + 'deg)' : '';
    }
    for (const el of typers) {
      const s = el.dataset.type, p = clamp((t - +el.dataset.in) / +el.dataset.dur);
      el.textContent = s.slice(0, Math.round(s.length * p));
    }
    for (const el of counters) {
      const p = ease(clamp((t - +el.dataset.in) / +el.dataset.dur));
      el.textContent = Math.round(+el.dataset.count * p).toLocaleString('en-US');
    }
    for (const el of carets) {
      const on = t >= 0.2 && (!el.dataset.caretOff || t < +el.dataset.caretOff);
      const typing = t < +el.dataset.caret;
      el.style.opacity = on && (typing || Math.floor(t * 2.2) % 2 === 0) ? 1 : 0;
    }
    for (const el of strikes) {
      const p = ease(clamp((t - +el.dataset.strike) / 0.35));
      el.querySelector('.strike').style.transform = 'scaleX(' + p + ')';
      el.querySelector('.code').style.opacity = 1 - 0.45 * p;
    }
    for (const el of flashes) {
      const d = t - +el.dataset.flash;
      const g = d < 0 ? 0 : Math.exp(-d * 3.2);
      el.style.boxShadow = 'inset 6px 0 0 #3fd68a, 0 0 ' + (28 * g) + 'px rgba(63,214,138,' + (0.55 * g) + ')';
      el.style.background = 'rgba(63,214,138,' + (0.16 + 0.22 * g) + ')';
    }
    for (const el of bouncers) {
      const ph = (t - +el.dataset.bounce) * 5;
      el.style.transform = 'translateY(' + (-Math.max(0, Math.sin(ph)) * 12) + 'px)';
    }
    for (const el of segs) {
      const b = el.firstChild, v = el.dataset.seg;
      b.style.transform = 'scaleX(' + (v === 'cur' ? clamp(t / D) : +v) + ')';
    }
  }
  window.__scene = { duration: D, seek: render };
  render(0);
  if (!window.__driven) {
    const t0 = performance.now();
    (function loop() { render(Math.min(D, ((performance.now() - t0) / 1000) % (D + 0.8))); requestAnimationFrame(loop); })();
  }
})();`;

const CSS = String.raw`
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0a0d14}
body{font-family:-apple-system,"SF Pro Display","Inter","Helvetica Neue",system-ui,"Hiragino Sans",sans-serif;color:#e8ecf3;-webkit-font-smoothing:antialiased}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden}
.bg{position:absolute;inset:0;background:
  radial-gradient(900px 700px at 85% 8%, color-mix(in srgb,var(--accent) 22%,transparent), transparent 70%),
  radial-gradient(800px 900px at 0% 100%, rgba(90,110,255,.12), transparent 70%),
  linear-gradient(180deg,#0d1220,#090b11)}
.progress{position:absolute;top:56px;left:60px;right:60px;display:flex;gap:10px}
.progress i{flex:1;height:7px;border-radius:4px;background:rgba(255,255,255,.16);overflow:hidden}
.progress b{display:block;height:100%;background:#fff;transform-origin:left;transform:scaleX(0)}
header{position:absolute;top:96px;left:60px;right:60px;display:flex;justify-content:space-between;align-items:center;font-size:28px;color:rgba(232,236,243,.62);font-weight:500}
.brand .mark{color:var(--accent);margin-right:4px}
.at{font-variant-numeric:tabular-nums}
.chip{position:absolute;top:178px;left:60px;display:inline-flex;align-items:center;gap:14px;padding:12px 24px;border-radius:999px;font-size:26px;font-weight:700;letter-spacing:.14em;color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);border:2px solid color-mix(in srgb,var(--accent) 45%,transparent)}
.chip .dot{width:14px;height:14px;border-radius:50%;background:var(--accent);box-shadow:0 0 16px var(--accent)}
main{position:absolute;left:60px;right:60px;top:270px;height:1130px;display:flex;flex-direction:column;justify-content:center}
footer{position:absolute;left:60px;right:60px;top:1450px}
.cap{font-size:78px;line-height:1.05;font-weight:800;letter-spacing:-.02em;word-break:break-word}
.cap em{font-style:normal;color:var(--accent)}
.sub{margin-top:24px;font-size:38px;line-height:1.3;color:rgba(232,236,243,.7);font-weight:450;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* windows */
.window{border-radius:28px;background:#11161f;border:2px solid rgba(255,255,255,.08);box-shadow:0 40px 120px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.4);overflow:hidden;position:relative}
.titlebar{display:flex;align-items:center;gap:22px;height:78px;padding:0 28px;background:#171d28;border-bottom:2px solid rgba(255,255,255,.06);font-size:26px}
.lights{display:flex;gap:11px}.lights i{width:18px;height:18px;border-radius:50%;background:#ff5f57}.lights i:nth-child(2){background:#febc2e}.lights i:nth-child(3){background:#28c840}
.path{flex:1;font-family:"SF Mono",Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.path .dir{color:rgba(232,236,243,.45)}.path b{color:#fff;font-weight:600}
.delta{font-family:"SF Mono",Menlo,monospace;font-weight:700;font-variant-numeric:tabular-nums}
.delta .add{color:#3fd68a}.delta .del{color:#ff5d6c;margin-left:8px}
.diff{padding:18px 0 22px;font-family:"SF Mono",Menlo,monospace}
.ln{display:flex;position:relative;white-space:pre;padding-right:20px}
.ln .no{width:78px;flex:none;text-align:right;padding-right:16px;color:rgba(232,236,243,.28);font-size:.8em}
.ln .sg{width:34px;flex:none;text-align:center;font-weight:700}
.ln .code{flex:1;overflow:hidden;color:#cdd6e4}
.ln.add .sg{color:#3fd68a}
.ln.del{background:rgba(255,93,108,.13);box-shadow:inset 6px 0 0 #ff5d6c}.ln.del .sg{color:#ff5d6c}
.ln.del .strike{position:absolute;left:112px;right:20px;top:50%;height:3px;background:#ff5d6c;transform-origin:left;transform:scaleX(0);border-radius:2px}
.ln.gap .code{color:rgba(232,236,243,.3)}
.ln.ctx .code{color:rgba(205,214,228,.62)}
.k{color:#c792ea}.s{color:#c3e88d}.n{color:#f78c6c}.c{color:#6b7a90;font-style:italic}.t{color:#ffcb6b}.f{color:#82aaff}
/* terminal */
.term .termbody{padding:34px 36px 130px;font-family:"SF Mono",Menlo,monospace;font-size:31px;line-height:1.5;min-height:520px}
.cmdline{white-space:pre-wrap;word-break:break-all;color:#fff;margin-bottom:18px;font-weight:600}
.ps1{color:var(--accent)}
.out{white-space:pre;color:rgba(205,214,228,.72);overflow:hidden;font-size:28px}
.caret{display:inline-block;width:.55em;height:1.05em;background:currentColor;vertical-align:-.15em;margin-left:2px}
.badge{position:absolute;right:30px;bottom:28px;padding:16px 32px;border-radius:18px;font-size:40px;font-weight:800;font-family:"SF Mono",Menlo,monospace;letter-spacing:.02em}
.badge.ok{background:#3fd68a;color:#062414;box-shadow:0 0 50px rgba(63,214,138,.45)}
.badge.bad{background:#ff5d6c;color:#2b060b;box-shadow:0 0 50px rgba(255,93,108,.45)}
/* prompt */
.chat{display:flex;flex-direction:column;gap:30px}
.avatar{display:inline-flex;align-items:center;justify-content:center;height:64px;padding:0 26px;border-radius:32px;background:var(--accent);color:#0a0d14;font-weight:800;font-size:28px;letter-spacing:.06em;text-transform:uppercase}
.avatar.claude{background:#d97757;color:#fff;width:64px;padding:0;font-size:34px}
.bubble{background:#f3f5fa;color:#0d1220;border-radius:44px 44px 44px 12px;padding:48px 52px;line-height:1.28;font-weight:600;letter-spacing:-.01em;white-space:pre-wrap;word-break:break-word;box-shadow:0 30px 90px rgba(0,0,0,.45)}
.bubble .caret{color:var(--accent)}
.reply{display:flex;align-items:center;gap:18px}
.dots{display:flex;gap:12px;padding:22px 30px;background:#1a2130;border-radius:40px}
.dots i{width:16px;height:16px;border-radius:50%;background:rgba(232,236,243,.6)}
/* intro */
main.intro{justify-content:center}
.intro .kicker{font-size:32px;color:var(--accent);font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.intro h1{font-size:132px;line-height:.98;font-weight:900;letter-spacing:-.04em;margin:26px 0 22px;word-break:break-word}
.intro .subtitle{font-size:46px;color:rgba(232,236,243,.75);font-weight:500;line-height:1.25}
.intro .branch{margin-top:26px;font-family:"SF Mono",Menlo,monospace;font-size:30px;color:rgba(232,236,243,.55)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:80px}
.stat{background:rgba(255,255,255,.05);border:2px solid rgba(255,255,255,.08);border-radius:28px;padding:30px 34px}
.stat b{display:block;font-size:76px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.stat small{font-size:28px;color:rgba(232,236,243,.6);font-weight:500}
.stat.add b{color:#3fd68a}.stat.del b{color:#ff5d6c}
`;

function indexPage(scenes, project) {
  const list = scenes.map(s => path.basename(s.file));
  return `<!doctype html><meta charset="utf-8"><title>${esc(project)} reel</title>
<style>html,body{margin:0;background:#000;height:100%;display:flex;align-items:center;justify-content:center}
iframe{width:${W}px;height:${H}px;border:0;transform-origin:center;transform:scale(calc(100vh / ${H}px))}</style>
<iframe id="f"></iframe>
<script>const L=${JSON.stringify(list)},D=${JSON.stringify(scenes.map(s => s.duration))};let i=0;
const f=document.getElementById('f');function go(){f.src=L[i];setTimeout(()=>{i=(i+1)%L.length;go()},D[i]*1000)}go();
f.style.transform='scale('+Math.min(innerHeight/${H},innerWidth/${W})+')';</script>`;
}

// ---------- text helpers ----------

export function redact(s = '') {
  return String(s)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '$1-•••')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_•••')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox-•••')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA•••')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'jwt•••')
    .replace(/((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi, '$1•••')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '•••@•••');
}
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clipLeft = (s, n) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
function clock(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, '0')}`;
}
