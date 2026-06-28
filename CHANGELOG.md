# Changelog — TMUXor

User-facing changes per version. Newest first. Deeper technical notes live in the
project memory; this file is the short "what changed" for each build.

> Builds: TMUXor ships as a single **public** `.ehpk` — it bakes no secrets, so every user
> enters their own backend URL + token on the app's Setup screen.

## 1.0.5 — 2026-06-28
- **Fix: multi-option prompts (AskUserQuestion) read clearly.** The read view had kept each
  option's description but dropped the "1. … / 2. …" lines above them, so the descriptions looked
  orphaned ("structure messed up"). The read view now shows the whole prompt — the question, each
  numbered option, and its description, in order — then tap to choose.

## 1.0.4 — 2026-06-28
- **Final-review polish:** double-tap leaves right away when the whole conversation already fits on
  screen (no needless scroll), and skips the prompt step on plain shell panes; the glasses no longer
  sleep while you're recording or typing; and a send error can't get clipped off the review screen.

## 1.0.3 — 2026-06-28
- **Fix (for real this time): double-tap brings you to the latest prompt from anywhere.** 1.0.2
  only worked if you'd scrolled *above* the prompt; while reading the *answer* (below the prompt)
  it still went to the bottom. Now double-tap puts the latest prompt at the top whenever you're not
  already on it — then the bottom, then back to the list.

## 1.0.2 — 2026-06-28
- **Fix: double-tap lands on the latest prompt.** When you'd scrolled up, double-tap jumped to the
  bottom instead of the recent prompt whenever that prompt was near the end of the conversation.
  Now it brings the prompt to the top first, then the bottom, then back to the list.

## 1.0.1 — 2026-06-28
- **Idle screen-sleep** — the glasses HUD blanks after a configurable idle time so there's no
  constant display in your view. Set the on-time in Setup (seconds; 0 = always on). It wakes on
  any gesture, and — if you leave the toggle on — when a session finishes or starts needing your
  input.
- **Tidier session view** — gesture hints and scroll position now sit on their own footer line, so
  the header just shows the session. When voice is off the header shows `tap=type`, and the list
  no longer spells out `◀◀=exit`.

## 1.0.0 — 2026-06-28
First public release.

- **See your whole fleet** — every Claude Code (and shell) session in your tmux panes,
  on your glasses, sorted by what needs you. Each tmux window is a **project tag** so you
  tell sessions apart at a glance. Swipe to scroll the list; ▶ marks the selected row.
- **Continue your work** — open a session to read its real prompts and replies (not raw
  terminal noise), reopened right where you left off, or jumped to a new question if one
  arrived while you were away. Double-tap walks you back to the live edge — latest prompt,
  then the bottom — and only then back to the list.
- **Approve safely** — when a session asks to run a command, you read the full command on the
  glasses first (swipe to scroll), then tap to choose Yes/No — so you never approve something
  you can't see.
- **Reply by voice — or type** — tap to talk, review the transcription (with its cost),
  send. No OpenAI key? Type the message on your phone instead. Approve interactive menu
  choices with a tap.
- **Start new sessions** — pick a project tag, speak or type a folder, and a Claude
  session opens there.
- **Private by design** — talks only to your own backend on your own machine, over
  Tailscale, behind a token you set. Nothing is sent to the app developer. The phone app
  opens straight to Setup; paste the config code `install.sh` prints and you're connected.
