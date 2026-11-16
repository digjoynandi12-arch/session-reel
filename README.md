# session-reel

Turn a Claude Code session transcript into a short vertical video (1080×1920 MP4).

`session-reel` reads a session's `.jsonl` transcript, pulls out the events (your prompts, file edits with their diffs, shell commands with exit codes), picks the 5–7 beats that tell the story, renders an animated HTML scene for each, and encodes them to an MP4.

## Requirements

- Node.js 20+
- Google Chrome (or Chromium/Edge). Set `CHROME_PATH` if it isn't in a standard location.
- `ffmpeg` on your `PATH`
- Optional: the [`claude` CLI](https://code.claude.com), for captions written by Claude

## Install

```bash
npm install
```

## Usage

Transcripts live in `~/.claude/projects/<project>/<session-id>.jsonl`.

```bash
# print the parsed event list
node bin/session-reel.js --events ~/.claude/projects/<project>/<session>.jsonl

# make the video
node bin/session-reel.js ~/.claude/projects/<project>/<session>.jsonl -o reel.mp4
```

| Option | |
|---|---|
| `--events` | print the parsed event list and exit (`--all` adds Claude's prose) |
| `--beats N` | number of beats to keep, 5–7 (default 6) |
| `-o, --out FILE` | output MP4 |
| `--scenes-dir DIR` | where to write the scene HTML (default `<out>-scenes/`) |
| `--no-render` | write the scenes only |
| `--no-llm` | skip Claude-written captions and use the built-in rule-based ones |
| `--model ID` | model for captions (default `claude-opus-5-5`) |
| `--fps N` | frame rate (default 30) |

## How it works

1. **Parse** (`src/parse.js`): keeps what you actually typed (not meta messages, subagent reports or tool output), every file change with its unified-diff hunks (including edits made through `sed` or heredocs in Bash), and every shell command with its exit code and output.
2. **Pick beats** (`src/beats.js`): scores each event. Your first prompt always opens the reel. Test runs, a failure followed by a fix, commits and PRs score high; large edits and new files come next; read-only commands (`cat`, `grep`, `ls`…) score near zero. Repeats are penalized so the reel doesn't show the same kind of moment twice.
3. **Caption** (`src/captions.js`): by default Claude writes a title and a headline plus one sentence per beat, through `claude -p` on your Claude Code login — no API key. Without the CLI, or with `--no-llm`, rule-based captions are used.
4. **Scenes** (`src/scenes.js`): one standalone HTML page per beat — a chat bubble that types out the prompt, an editor where diff lines slide in and removed lines get struck through, a terminal that types the command and stamps the exit code — plus an intro card with session stats. Each page plays on its own in a browser; `index.html` plays them all.
5. **Render** (`src/render.js`): headless Chrome steps each scene frame by frame and pipes the frames into ffmpeg (H.264, yuv420p).

## Privacy

Obvious secrets (API keys, tokens, JWTs, emails) and your home folder path are masked before anything is drawn or sent to Claude. That masking is pattern-based, so look over a reel before posting it publicly.
