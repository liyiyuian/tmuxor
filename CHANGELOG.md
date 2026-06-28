# Changelog — TMUXor

User-facing changes per version. Newest first. Deeper technical notes live in the
project memory; this file is the short "what changed" for each build.

> Builds: TMUXor ships as a single **public** `.ehpk` — it bakes no secrets, so every user
> enters their own backend URL + token on the app's Setup screen.

## 1.0.0 — 2026-06-28
First public release.

- **See your whole fleet** — every Claude Code (and shell) session in your tmux panes,
  on your glasses, sorted by what needs you. Each tmux window is a **project tag** so you
  tell sessions apart at a glance. Swipe to scroll the list; ▶ marks the selected row.
- **Continue your work** — open a session to read its real prompts and replies (not raw
  terminal noise), reopened right where you left off, or jumped to a new question if one
  arrived while you were away.
- **Reply by voice — or type** — tap to talk, review the transcription (with its cost),
  send. No OpenAI key? Type the message on your phone instead. Approve interactive menu
  choices with a tap.
- **Start new sessions** — pick a project tag, speak or type a folder, and a Claude
  session opens there.
- **Private by design** — talks only to your own backend on your own machine, over
  Tailscale, behind a token you set. Nothing is sent to the app developer. The phone app
  opens straight to Setup; paste the config code `install.sh` prints and you're connected.
