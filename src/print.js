const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const one = (s, n) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function printEvents(meta, events, { all = false } = {}) {
  const t0 = meta.start || 0;
  const dur = meta.end && meta.start ? Math.round((meta.end - meta.start) / 60000) : 0;
  console.log(c('1', meta.title || meta.sessionId || 'session'));
  console.log(c('2', `${meta.cwd}  ${meta.gitBranch ? '(' + meta.gitBranch + ')  ' : ''}${dur} min`));
  const counts = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;
  console.log(c('2', Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')));
  console.log();

  for (const e of events) {
    if (e.kind === 'say' && !all) continue;
    const at = e.ts ? fmtT(e.ts - t0) : '  --:--';
    const idx = c('2', `#${String(e.i).padStart(4)} ${at}`);
    let line;
    if (e.kind === 'prompt') line = `${c('36;1', 'PROMPT')}  ${one(e.text, 110)}`;
    else if (e.kind === 'say') line = `${c('2', 'SAY   ')}  ${c('2', one(e.text, 110))}`;
    else if (e.kind === 'edit') {
      const tag = e.created ? c('35;1', 'CREATE') : c('33;1', 'EDIT  ');
      line = `${tag}  ${e.file}  ${c('32', '+' + e.added)} ${c('31', '-' + e.removed)}${e.via === 'bash' ? c('2', ' (via bash)') : ''}`;
    } else if (e.kind === 'bash') {
      const code = e.denied ? c('31', 'denied') : e.interrupted ? c('33', 'intr') : e.exitCode === 0 ? c('32', 'exit 0') : c('31;1', `exit ${e.exitCode}`);
      line = `${c('34;1', 'BASH  ')}  ${code.padEnd(tty ? 15 : 6)}  ${one(e.command, 100)}`;
    }
    console.log(`${idx}  ${line}`);
  }
}

function fmtT(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `  ${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
