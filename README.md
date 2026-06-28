# TMUXor

**Your tmux Claude Code fleet, hands-free on your Even G2 glasses.**

TMUXor puts the Claude Code (and shell) sessions running in your tmux panes onto your
glasses, so your running work stays trackable and hands-free. Each tmux window is a
project **tag**, so you tell sessions apart at a glance — see which one needs you, read
its real prompts and replies, and **continue** it by voice — over your own private
Tailscale network. Nothing is sent to anyone but your own machine.

This repo is the **backend** (a small stdlib-Python control plane that runs on your
computer) plus the **glasses app source**. The glasses app itself installs from the
Even Hub.

---

## Screenshots

| | |
|---|---|
| ![Fleet list](store-assets/screenshots/01-fleet-list.png)<br>**Fleet** — your sessions, sorted by what needs you (! waiting · ● working · ○ idle). | ![Conversation](store-assets/screenshots/02-conversation.png)<br>**Conversation** — real prompts + replies, opening at the latest question. |
| ![New session](store-assets/screenshots/03-new-session-tag.png)<br>**New session** — pick a project tag, then speak the folder. | ![Voice review](store-assets/screenshots/04-voice-review.png)<br>**Voice** — review the transcription (and its cost) before sending. |

*576×288 monochrome-green glasses display. Images use demo data.*

---

## Quick start

On the computer where your tmux + Claude Code sessions run:

```bash
curl -fsSL https://raw.githubusercontent.com/liyiyuian/tmuxor/main/install.sh | bash
```

The installer checks prerequisites, downloads the backend, generates an access token,
writes the config file, installs a `systemd --user` service, exposes it on your tailnet
with `tailscale serve`, and prints a **scannable QR code** (plus a one-line config code).

Then on your phone:

1. Install **TMUXor** from the Even Hub.
2. Open it — it opens straight to the **Setup** screen — and **paste the config code** the
   installer printed (copy it from your terminal, or scan the QR with your phone's camera to
   copy the text), then connect.

That's it — no typing the URL or token by hand. (Manual entry also available — see [SETUP.md](SETUP.md).)

### Requirements (prepare these first)
- **Even G2 glasses** + the Even phone app, paired.
- **tmux** and **Claude Code** installed. You do *not* need a session running already —
  TMUXor can start your first one from the glasses ("＋ new session").
- **Tailscale**, signed in on the computer **and** the phone (same tailnet), **with HTTPS
  Certificates enabled** for your tailnet (Tailscale admin console → Settings → enable
  HTTPS) — `tailscale serve` needs it for the secure URL the glasses connect to.
- **Python 3.10+** on the computer.
- *(Optional)* an **OpenAI API key** — enables **voice input** (Whisper). Without it you simply
  **type** your replies and new-session names on your phone instead — everything still works.
  The installer prompts for it (Enter to skip; re-run later to add it).

The installer checks Python / tmux / Claude / Tailscale and tells you what's missing. The
Tailscale **HTTPS** toggle and signing in on the phone are the two it can't do for you.

---

## Using it

The phone app just holds your connection — everything happens on the glasses with **three
gestures**, reassigned per screen (each screen shows a hint of what they do):

> **tap** = the primary action · **double-tap** = back · **swipe up/down** = move / scroll

- **The fleet** — your sessions, sorted by what needs you: **!** waiting on you · **●** working
  · **○** idle. Each row is `tag  title` (the tag is the tmux window / project). Swipe to scroll
  (**▶** marks the selected row), tap to open. The top row, **＋ new session**, starts a new one.
- **Reading a session** — opens at the latest question. Swipe to scroll the real prompts and
  replies. **Double-tap** walks you back toward the live edge — latest prompt → bottom → out to
  the list. Tap to reply.
- **Replying** — tap to talk: speak, review the transcription (with its cost), tap to send. No
  OpenAI key? **Type it on your phone** instead — same result.
- **Approving a command** — when a session asks to run something, you **read the full command on
  the glasses first** (swipe through it), then tap to choose, swipe to Yes/No, tap to confirm.
  You never approve something you can't see.
- **Starting a session** — tap **＋ new session**, pick a project tag, speak or type a folder, and
  a Claude session opens there.
- **Idle sleep** *(optional)* — set a screen on-time in Setup; the HUD blanks when idle and wakes
  on any gesture (or when a session finishes / starts needing you).

Double-tap on the fleet list exits the app (system dialog). The phone Even app must stay running
in the background — it's the Bluetooth bridge to the glasses.

---

## Security model

This backend **runs commands on your machine** — treat it as a remote-control surface:

- Binds **loopback only** (`127.0.0.1`); reached over the tailnet via `tailscale serve`.
- **Token required** on every request (constant-time check); it refuses to start without one.
- The token lives only in `~/.config/tmux-conductor.env` (mode `600`). **Never share it or
  commit it** — anyone with it can run commands as you.

Do not expose this backend to the public internet.

---

## Manual setup, usage, and troubleshooting

See **[SETUP.md](SETUP.md)** for the step-by-step manual install, how session-matching
works, the gesture reference, and troubleshooting.

## Building the glasses app yourself

The app installs from the Even Hub, but you can build it from `glasses/` (Vite + React +
even-toolkit). A public build ships no secrets — each user enters their own URL + token.
See `glasses/` and the project notes.

## License

**MIT** — see [LICENSE](LICENSE).
