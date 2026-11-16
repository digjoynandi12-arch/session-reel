#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parseTranscript } from '../src/parse.js';
import { printEvents } from '../src/print.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    events: { type: 'boolean', default: false },   // print events and exit
    all: { type: 'boolean', default: false },      // include assistant prose when printing
    beats: { type: 'string', default: '6' },
    out: { type: 'string', short: 'o' },
    'scenes-dir': { type: 'string' },
    'no-render': { type: 'boolean', default: false },
    fps: { type: 'string', default: '30' },
    'no-llm': { type: 'boolean', default: false },  // skip LLM captions
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (opt.help || positionals.length !== 1) {
  console.log(`usage: session-reel <transcript.jsonl> [options]

  --events          print the parsed event list and exit
  --all             with --events, also show assistant prose
  --beats N         number of beats to keep (5-7, default 6)
  -o, --out FILE    output MP4 (default: <session>.mp4)
  --scenes-dir DIR  where to write scene HTML (default: <out>-scenes/)
  --no-render       write scenes only, skip the MP4
  --fps N           frame rate (default 30)
  --no-llm          skip LLM captions; use the built-in rule-based ones
  --model ID        model for LLM captions (default claude-opus-5-5)

Captions are written by Claude through the claude CLI, on your Claude Code
login (no API key). Without the CLI, rule-based captions are used.`);
  process.exit(positionals.length === 1 ? 0 : 1);
}

const file = path.resolve(positionals[0]);
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }
const { meta, events } = await parseTranscript(file);

if (opt.events) {
  printEvents(meta, events, { all: opt.all });
  process.exit(0);
}

const { pickBeats } = await import('../src/beats.js');
const { writeScenes } = await import('../src/scenes.js');
const n = Math.min(7, Math.max(5, Number(opt.beats) || 6));
const beats = pickBeats(events, meta, n);

if (!opt['no-llm']) {
  const { llmCaptions, applyCaptions, DEFAULT_MODEL } = await import('../src/captions.js');
  try {
    const res = await llmCaptions(beats, meta, events, { model: opt.model || DEFAULT_MODEL, log: m => console.error(m) });
    applyCaptions(beats, meta, res);
  } catch (e) {
    console.error(`captions: using rule-based captions (${String(e.message).split('\n')[0]})`);
  }
}

const out = path.resolve(opt.out || `${meta.sessionId || path.basename(file, '.jsonl')}.mp4`);
const scenesDir = path.resolve(opt['scenes-dir'] || out.replace(/\.mp4$/i, '') + '-scenes');
const scenes = writeScenes(beats, meta, events, scenesDir);
console.log(`beats (${beats.length}):`);
for (const b of beats) console.log(`  ${b.role.padEnd(9)} #${String(b.event.i).padStart(4)}  score ${b.score.toFixed(1).padStart(5)}  ${b.caption}`);
console.log(`scenes → ${scenesDir}`);

if (!opt['no-render']) {
  const { renderVideo } = await import('../src/render.js');
  await renderVideo(scenes, out, { fps: Number(opt.fps) || 30 });
  console.log(`video  → ${out}`);
}
