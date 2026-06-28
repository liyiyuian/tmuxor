# TMUXor — Setup Guide

TMUXor turns your **Even G2 glasses** into a hands-free conductor for the **Claude Code
(and shell) sessions running in your tmux panes**: see which session needs you, read the
conversation, and reply by voice — all from the glasses, over your Tailscale network.

It has two halves:

- **Backend** (`conductor_api.py` + `tmux_conductor.py`) — runs on **your computer**, reads
  your tmux + Claude Code sessions, and exposes a small token-authenticated HTTP API.
- **Glasses app** (`glasses/`) — an Even Hub plugin (web app) you install on your glasses;
  it talks to your backend over Tailscale.

> ⚠️ The backend runs commands on your machine. Keep it **tailnet-only + token-protected**
> (the defaults). Never bind it to `0.0.0.0` or expose it to the public internet.

---

## 1. Prerequisites

On the **computer** that runs your sessions:
- `tmux` with your Claude Code / shell sessions in one tmux **session** (default name `0`).
- [Claude Code](https://claude.com/claude-code) installed (the app reads its session files).
- **Python 3.10+** (no pip packages needed — the backend uses only the standard library + the `tmux` CLI).
- **Tailscale** installed and logged in.
- *(Optional)* an **OpenAI API key** — enables voice→text via Whisper. Without it, voice is
  off and you type your replies on the phone instead; everything else still works.
- *(Optional)* an **Anthropic API key** — only used to translate speech→shell command for
  non-Claude (plain shell) panes. Claude panes don't need it.
- **Node 18+ / npm** (only to build the glasses app once).

On the **phone**:
- The **Even** app, your **G2 glasses + R1 ring** paired, **Developer mode** enabled, and
  **Tailscale** running (same tailnet as the computer).

---

## 2. Backend setup (on your computer)

### 2a. Create the secrets/config file

The backend reads its config from environment variables. Put them in a private env file:

```bash
mkdir -p ~/.config
cat > ~/.config/tmux-conductor.env <<'EOF'
# REQUIRED — a long random token the glasses app must present. Generate one:
#   python3 -c "import secrets; print('tmxr_'+secrets.token_urlsafe(24))"
CONDUCTOR_TOKEN=PASTE_A_LONG_RANDOM_TOKEN_HERE

# REQUIRED for voice — OpenAI Whisper transcription
OPENAI_API_KEY=sk-...

# OPTIONAL — only for plain shell panes (speech -> shell command)
ANTHROPIC_API_KEY=sk-ant-...

# OPTIONAL overrides (defaults shown)
CONDUCTOR_BIND=127.0.0.1          # keep loopback; expose via Tailscale (below)
# CONDUCTOR_TMUX_SESSION=0        # which tmux session holds your panes
# CONDUCTOR_LAUNCH_CMD=claude     # command run in a new pane when you create a session
# CONDUCTOR_API_PORT=8790
EOF
chmod 600 ~/.config/tmux-conductor.env
```

Notes:
- `CONDUCTOR_TOKEN` is **mandatory** — the backend refuses to start without it.
- `CONDUCTOR_LAUNCH_CMD` is what gets typed into a freshly-created pane. Default `claude`.
  If you launch Claude via a shell function (e.g. to pick a profile), set it to that
  function name — the new pane is an interactive shell, so functions/aliases resolve.

### 2b. Run it as a service (auto-start, auto-restart)

```bash
# adjust the two paths: your python, and where you put this repo
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tmux-conductor.service <<EOF
[Unit]
Description=TMUXor control plane (Even G2 glasses backend)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME/projects/evenrealities
Environment=CONDUCTOR_BIND=127.0.0.1
EnvironmentFile=%h/.config/tmux-conductor.env
ExecStart=/usr/bin/python3 $HOME/projects/evenrealities/conductor_api.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tmux-conductor
systemctl --user status tmux-conductor      # should be "active (running)"
```

Quick local check (replace the token):

```bash
curl -s -H "Authorization: Bearer $CONDUCTOR_TOKEN" http://127.0.0.1:8790/api/panes?claude_only=1 | head -c 300
# no token -> 401 ;  with token -> a JSON list of panes
```

### 2c. Expose it to your tailnet over HTTPS

The backend stays bound to `127.0.0.1`; Tailscale publishes it as HTTPS **inside your
tailnet only** (not the public internet):

```bash
sudo tailscale serve --bg 8790
tailscale serve status      # shows your https URL, e.g. https://<host>.<tailnet>.ts.net
```

Copy that **HTTPS URL** — you'll enter it in the glasses app. (If `serve` needs sudo every
time, run `sudo tailscale set --operator=$USER` once.)

---

## 3. Glasses app setup

### 3a. Point it at your backend domain

Edit `glasses/app.json`:
- Set a **unique** `package_id` (e.g. `com.yourname.tmuxor`).
- In `permissions` → the `network` entry, put **your** Tailscale HTTPS URL in `whitelist`
  (installed Even apps may only reach whitelisted domains):

```json
"whitelist": ["https://<host>.<tailnet>.ts.net"]
```

### 3b. Build and package

```bash
cd glasses
npm install
npm run build
npx @evenrealities/evenhub-cli@latest pack app.json dist -o TMUXor.ehpk
```

This produces `TMUXor.ehpk`. (Leave the build with **no baked-in secrets** — you'll enter
the URL/token on-device in step 3d.)

### 3c. Install on the glasses

1. Go to **[hub.evenrealities.com](https://hub.evenrealities.com)** → log in → your developer area.
2. Create/select your app (its `package_id` must match `app.json`) and **upload `TMUXor.ehpk`**.
3. In the **Even phone app**, open the **Developer Center**, and install your build (scan the
   install QR, or install from your dev builds list). If you're updating, **uninstall the old
   version first** — Even keys updates by version number.

### 3d. Connect it

Open TMUXor on the phone. On first launch it shows a **Setup** screen — enter:
- **Backend URL**: your `https://<host>.<tailnet>.ts.net`
- **Access token**: your `CONDUCTOR_TOKEN`

Tap **Save & connect**. (These stay on your phone only; the app always opens to this Setup
screen, so you can change them any time.) The phone Even app must stay running in the
background — it's the Bluetooth bridge to the glasses.

---

## 4. Using it

Three gestures, reassigned per screen (tap = primary, double-tap = back, swipe = move/scroll):

- **Panels list** — your sessions, grouped by tmux window (the **tag**). Swipe to move,
  double-tap to jump a page, tap to open. Row 0 is **＋ new session**.
- **Conversation** — opens at the latest question; swipe to scroll, **tap = talk** (speak a
  reply → review screen → tap to send), double-tap = back.
- **New session** — pick a **tag** (existing tmux window or ＋ speak a new one) → speak a
  **folder** → confirm → it opens a Claude session there.
- **When a session asks a question** (a menu), the options become a selectable list.

---

## 5. How session-matching works (good to know)

The backend maps each pane to its **exact** Claude session via Claude Code's runtime file
`sessions/<pid>.json`, then reads that session's transcript. It scans:
`~/.claude/…` and `~/.config/claude-code/profiles/*/…`. If your Claude Code stores data
elsewhere, adjust `PROJECT_ROOTS` / `SESSION_DIRS` in `tmux_conductor.py`.

---

## 6. Security model

- **Token required** in every mode; the backend won't start without `CONDUCTOR_TOKEN`.
- **Loopback bind + Tailscale serve** — reachable only from your own tailnet, over HTTPS.
- Do **not** set `CONDUCTOR_BIND=0.0.0.0` and do **not** port-forward it.
- The `.ehpk` you submit publicly must **not** contain your URL/token — enter them on-device.
- Treat `CONDUCTOR_TOKEN` like a password (it's the key to running commands on your machine).
  To rotate: change it in the env file, `systemctl --user restart tmux-conductor`, and
  re-enter it in the app's Settings.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| App shows "offline" / load failed | Backend down, wrong URL/token, or phone not on Tailscale. Check `systemctl --user status tmux-conductor` and `tailscale serve status`. |
| Service won't start | Missing `CONDUCTOR_TOKEN` (required), or wrong python/repo path in the unit. `journalctl --user -u tmux-conductor -e`. |
| 401 on every request | Token in the app's Settings doesn't match `CONDUCTOR_TOKEN`. |
| New session opens the wrong profile | Set `CONDUCTOR_LAUNCH_CMD` to your launcher (e.g. a profile shell function). |
| App won't update to the new build | Uninstall the old version first, then install (Even keys by version). |
| Voice does nothing | Check `OPENAI_API_KEY`; confirm glasses mic permission is granted to the app. |
