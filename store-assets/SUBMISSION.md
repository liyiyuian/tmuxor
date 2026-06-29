# TMUXor — hub submission packet (copy-paste into the portal)

Everything the browser-side submission needs, mapped to each field. All assets are in
this folder. Agent supplies the text/images; you do the portal steps.

## 0. Create the project (do this first)
- **Create a BRAND-NEW project** on hub.evenrealities.com.
- **Package ID:** `com.liyiyuian.tmuxor` (must match the build's `app.json`).
- **Upload build:** the latest `glasses/TMUXor-*.ehpk` (highest version number) — the only build;
  it bakes no secrets, so every user enters their own backend URL + token in the app's Setup screen.
- Uninstall any old "tmux Conductor / TMUXor" build first (it was a different package id).

## 1. Listing fields
| Portal field | What to paste |
|---|---|
| **App name** | `TMUXor` |
| **Subtitle / tagline** | `Your tmux Claude Code fleet, hands-free on your glasses` |
| **Category** | `Productivity / Developer Tools` |
| **Description** (≤1000 chars) | the full contents of **`tester-quickstart.txt`** (~960 chars) |
| **Privacy policy** | the **PRIVACY POLICY** section of **`listing.txt`** |
| **Terms & conditions** | the **TERMS & CONDITIONS** section of **`listing.txt`** |
| **App icon** | **`../glasses/icon-512.png`** |

## 2. Screenshots (upload in this order, from `screenshots/`)
1. `01-fleet-list.png` — your sessions, sorted by what needs you (▶ marks the selected row)
2. `02-conversation.png` — read a session's real prompts + replies (footer = hints + position)
3. `03-approve-command.png` — read the full command on the glasses before you approve it
4. `04-new-session.png` — start a new session: pick a project tag

*(All 576×288, captured from the Even Hub simulator's automation API with DEMO/fake data — never
real sessions. Regenerate with `tools/capture-screenshots.sh`.)*

## 3. Permissions (auto-populated from the .ehpk — justifications if asked)
- **network** — Connects only to the user's own TMUXor backend over Tailscale (whitelisted to
  Tailscale hosts); nothing is sent to the developer.
- **g2-microphone** — Captures glasses-mic audio for voice replies, transcribed by the user's
  own backend. Only `network` + `g2-microphone` are requested.

## 4. Before you hit submit — on-device checklist (beta track)
Install the latest `TMUXor-*.ehpk` via a Beta group and confirm on the real glasses:
- [ ] Fleet list **scrolls** with swipe on a long fleet; ▶ marks the selected row
- [ ] App opens straight to the Settings screen on the phone; paste-config connects
- [ ] Tap a session → reads its real conversation; reply by voice (or type on phone) sends
- [ ] 5-min lock test: open → lock phone 5 min → unlock → state intact, no spinner/black screen
- [ ] Root double-tap opens the system exit dialog
- [ ] No errors in the console at boot

## 5. Submit
Move the build **Test → Submitted** in the portal to start Even's review.

## Open unknowns (resolved at/after upload)
- Does Even accept the **`*.ts.net` wildcard** whitelist on the public build? (Fallback: per-user builds.)
- Curation fit for a self-host developer tool — Even's call.
