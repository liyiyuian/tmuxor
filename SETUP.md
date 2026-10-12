# G2C — Setup Guide

G2C turns your **Even G2 glasses** into a hands-free conductor for the **Claude Code and
Codex sessions running in [Herdr](https://herdr.dev/)**: see which session
needs you, read the conversation, and reply by voice — all from the glasses, over your
Tailscale network.

It has two halves:

- **Backend** (`conductor_api.py` + `tmux_conductor.py`) — runs on **your computer**, reads
  your Herdr sessions, and exposes a small token-authenticated HTTP API.
- **Glasses app** (`glasses/`) — an Even Hub plugin (web app) you install on your glasses;
  it talks to your backend over Tailscale.

> ⚠️ The backend runs commands on your machine. Keep it **tailnet-only + token-protected**
> (the defaults). Never bind it to `0.0.0.0` or expose it to the public internet.

---

## 1. Prerequisites

On the **computer** that runs your sessions:
- [Herdr](https://herdr.dev/) (an agent-aware terminal multiplexer) running, with your Claude
  Code / Codex sessions inside it. See §2d if the backend can't find the `herdr` binary.
- [Claude Code](https://claude.com/claude-code) installed (the app reads its session files).
- **Python 3.10+** (no pip packages needed — the backend uses only the standard library + the `herdr` CLI).
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

# OPTIONAL — your own Anthropic key. Used for plain shell panes (speech -> shell command) and,
# only if you turn it on in the app, for AI summaries in the list preview (Claude Haiku).
ANTHROPIC_API_KEY=sk-ant-...

# OPTIONAL overrides (defaults shown)
CONDUCTOR_BIND=127.0.0.1          # keep loopback; expose via Tailscale (below)
# CONDUCTOR_LAUNCH_CMD=claude     # command run in a new pane when you create a session
# CONDUCTOR_API_PORT=8790
# CONDUCTOR_HERDR_BIN=            # full path to the herdr binary, if not on the service PATH
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
Description=G2C control plane (Even G2 glasses backend)
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

### 2c-bis. (Optional) Plan usage on the glasses

The top row of the session list can show how much of your Claude and Codex plans is used, as
small level bars: for each account the 5-hour window, then the week (taller = more used). The backend only reads
local files for this — it never touches a login token.

- **Codex** needs nothing: the numbers are read from your newest Codex session file.
- **Claude Code** hands the numbers to its status line command. Let `g2c_usage_hook.py` (installed
  next to the backend, in `~/.local/share/tmuxor/`) save them — either use it as your status line
  in Claude Code's `settings.json`:
  `"statusLine": {"type": "command", "command": "python3 ~/.local/share/tmuxor/g2c_usage_hook.py"}`
  or, if you already have a status line script, add this near its top and keep using `$input`:
  `input=$(cat); printf '%s' "$input" | python3 ~/.local/share/tmuxor/g2c_usage_hook.py save`
  With several accounts, set `G2C_USAGE_LABEL` (e.g. `P`, `W`) in each one's environment.
- Already keep these numbers in a file of your own? Point `CONDUCTOR_LIMITS_FILE` at a JSON file
  shaped `{"data": {"P": {"util": 0.26, "week_util": 0.44, "reset_epoch": …, "week_reset_epoch": …}}}`.

Switch the line off on the phone under **On the glasses → Plan usage**.

### 2d. Herdr

G2C reads your sessions from **[Herdr](https://herdr.dev/)**, which reports each session's
state (working / needs-input / idle / done) natively and knows which agent (Claude Code or
Codex) runs in each pane.

- **Nothing to configure** when the `herdr` server is running and its binary is on the
  service's `PATH`.
- **If `herdr` isn't found:** the `systemd --user` service `PATH` often omits `~/.local/bin`
  (where Herdr installs), so set its full path in the env file:
  `CONDUCTOR_HERDR_BIN=/home/you/.local/bin/herdr`, then `systemctl --user restart tmux-conductor`.
- Your sessions must run **inside** Herdr for G2C to see them.

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
npx @evenrealities/evenhub-cli@latest pack app.json dist -o G2C.ehpk
```

This produces `G2C.ehpk`. (Leave the build with **no baked-in secrets** — you'll enter
the URL/token on-device in step 3d.)

### 3c. Install on the glasses

1. Go to **[hub.evenrealities.com](https://hub.evenrealities.com)** → log in → your developer area.
2. Create/select your app (its `package_id` must match `app.json`) and **upload `G2C.ehpk`**.
3. In the **Even phone app**, open the **Developer Center**, and install your build (scan the
   install QR, or install from your dev builds list). If you're updating, **uninstall the old
   version first** — Even keys updates by version number.

### 3d. Connect it

Open G2C on the phone. On first launch the **Connection & settings** section is open — enter:
- **Backend URL**: your `https://<host>.<tailnet>.ts.net`
- **Access token**: your `CONDUCTOR_TOKEN`

Tap **Save & connect**. (These stay on your phone only; the app always opens to this Setup
screen, so you can change them any time.) The phone Even app must stay running in the
background — it's the Bluetooth bridge to the glasses.

---

## 4. Using it

Three gestures, reassigned per screen (tap = primary, double-tap = back, swipe = move/scroll):

- **Session list** — your Claude and Codex sessions in Herdr's own order (workspaces, then
  tabs), pinned (**★**) first. **○** idle, **»** working, **●** finished since you last opened
  it, **!** needs you; a Codex session uses **◇** and **◆**. A session is named after its Claude
  session name, or its Herdr tab for Codex. Swipe to move, tap to open,
  double-tap to exit. The last row is **＋ new session** (one swipe up from the top). The right
  two thirds of the screen previews the highlighted session's last prompt and the end of its reply
  (switch it off in **Connection & settings** if you prefer the plain list). The same settings
  let you untick a workspace to leave its sessions off the glasses, and (with an Anthropic key on
  the backend) switch on **condensed replies**: the latest reply of an opened session shown as
  about one screen, marked `＊`.
- **AI summaries (optional, off by default)** — with `ANTHROPIC_API_KEY` set on the backend, the
  phone's **Connection & settings** shows “Summarize list previews with Claude Haiku”. Turn it on
  and the preview shows a one-line summary (marked `＊`) instead of the raw reply. Your backend sends
  the highlighted session's latest request and the end of its reply (up to 6,000 characters) to
  Anthropic under your key — once per change, never while the session is still working. Each
  summary is one small Claude Haiku request (a few hundred to ~2,000 input tokens).
- **Pin a session** — tap ★ next to it on the phone. Or on the glasses: highlight it in the
  session list, tap then press-and-hold to open the system menu, and choose **Pin / unpin
  session** (Even app 2.2.10+).
- **Conversation** — opens at the latest question; swipe to scroll, **tap = talk** (speak a
  reply → review screen → tap to send), double-tap = back.
- **New session** — pick a **tag** (an existing workspace or ＋ speak a new one) → speak a
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
  re-enter it on the app's Setup screen.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| App shows "offline" / load failed | Backend down, wrong URL/token, or phone not on Tailscale. Check `systemctl --user status tmux-conductor` and `tailscale serve status`. |
| Service won't start | Missing `CONDUCTOR_TOKEN` (required), or wrong python/repo path in the unit. `journalctl --user -u tmux-conductor -e`. |
| 401 on every request | Token on the app's Setup screen doesn't match `CONDUCTOR_TOKEN`. |
| New session opens the wrong profile | Set `CONDUCTOR_LAUNCH_CMD` to your launcher (e.g. a profile shell function). |
| App won't update to the new build | Uninstall the old version first, then install (Even keys by version). |
| Voice does nothing | Check `OPENAI_API_KEY`; confirm glasses mic permission is granted to the app. |
