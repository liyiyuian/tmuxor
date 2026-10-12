#!/usr/bin/env bash
# G2C backend installer — one command to stand up the control plane on YOUR machine.
#
#   curl -fsSL https://raw.githubusercontent.com/liyiyuian/tmuxor/main/install.sh | bash
#
# It: checks prereqs, downloads the backend, generates a token, writes the env file,
# installs a systemd --user service, exposes it on your tailnet, and prints the
# Backend URL + token + a paste-config blob to enter in the glasses app.
#
# This backend runs commands on your machine — it is loopback-bound + token-required +
# tailnet-only. Never expose it publicly or share the token.
#
# Testing hooks (not for normal use):
#   TMUXOR_SRC=/path/to/repo   copy backend files from a local dir instead of curl
#   TMUXOR_DRYRUN=1            don't touch systemd/tailscale/sudo (print instead)
#   TMUXOR_OPENAI_KEY=sk-...   supply the OpenAI key non-interactively ("" = none given: an
#                              existing key is kept, a fresh install gets no voice)
set -euo pipefail

REPO="${TMUXOR_REPO:-liyiyuian/tmuxor}"
RAW="https://raw.githubusercontent.com/${REPO}/main"
INSTALL_DIR="${TMUXOR_DIR:-$HOME/.local/share/tmuxor}"
ENV_FILE="${TMUXOR_ENV:-$HOME/.config/tmux-conductor.env}"
# running this again is how you upgrade: what an earlier run set up (port, OpenAI key, token) is kept
old(){ sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 || true; }   # (no settings file yet = a fresh install)
PORT="${CONDUCTOR_API_PORT:-$(old CONDUCTOR_API_PORT)}"; PORT="${PORT:-8790}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY="${TMUXOR_DRYRUN:-0}"

c()  { printf '\033[36m%s\033[0m\n' "$*"; }      # info
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m! %s\033[0m\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run(){ if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

c "G2C backend installer"

# 1) prerequisites -----------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found (need 3.10+). Install Python first."
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
python3 -c 'import sys;exit(0 if sys.version_info[:2]>=(3,10) else 1)' || die "python3 $PYV too old; need 3.10+."
ok "python3 $PYV"
HERDR_PATH=$(command -v herdr || ls "$HOME/.local/bin/herdr" 2>/dev/null || true)
[ -n "$HERDR_PATH" ] && ok "herdr ($HERDR_PATH)" || die "herdr not found. Install Herdr: https://herdr.dev/"
command -v claude >/dev/null && ok "claude"    || warn "claude (Claude Code) not on PATH — install it so sessions can launch."
command -v tailscale >/dev/null && ok "tailscale" || die "tailscale not found. Install + log in: https://tailscale.com/download"

# 2) download backend --------------------------------------------------------
mkdir -p "$INSTALL_DIR"
for f in conductor_api.py tmux_conductor.py sources.py; do
  if [ -n "${TMUXOR_SRC:-}" ]; then
    cp "$TMUXOR_SRC/$f" "$INSTALL_DIR/$f"
  else
    curl -fsSL "$RAW/$f" -o "$INSTALL_DIR/$f" || die "could not download $f from $RAW"
  fi
done
# optional helper: lets the glasses show how much of your Claude plan is used (see SETUP.md)
if [ -n "${TMUXOR_SRC:-}" ]; then cp "$TMUXOR_SRC/tools/g2c_usage_hook.py" "$INSTALL_DIR/g2c_usage_hook.py" 2>/dev/null || true
else curl -fsSL "$RAW/tools/g2c_usage_hook.py" -o "$INSTALL_DIR/g2c_usage_hook.py" 2>/dev/null || true; fi
ok "backend in $INSTALL_DIR"

# 3) token (reuse existing if present) ---------------------------------------
TOKEN=$(old CONDUCTOR_TOKEN)
if [ -z "$TOKEN" ]; then
  TOKEN="tmxr_$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
  ok "generated a new access token"
else
  ok "reusing existing access token"
fi

# 4) OpenAI key (OPTIONAL) — enables VOICE input. Without it you just type replies and
#    new-session names on your phone instead. ---------------------------------
OLD_KEY=$(old OPENAI_API_KEY)
if [ "${TMUXOR_OPENAI_KEY+set}" = set ]; then
  OPENAI_KEY="$TMUXOR_OPENAI_KEY"
elif [ -r /dev/tty ]; then
  if [ -n "$OLD_KEY" ]; then printf 'OpenAI API key — one is already set. Enter keeps it, or paste a new one: '
  else printf 'OpenAI API key (optional) — enables VOICE input via Whisper; without it you type on your phone. Paste it, or Enter to skip: '; fi
  read -r OPENAI_KEY </dev/tty || OPENAI_KEY=""
else
  OPENAI_KEY=""
fi
[ -z "$OPENAI_KEY" ] && OPENAI_KEY="$OLD_KEY"   # nothing new given: keep the key you had (it used to be dropped on a re-run)
[ -n "$OPENAI_KEY" ] && ok "voice input enabled" || warn "no OpenAI key — voice input off; you'll type replies/new-session names on your phone (re-run later to add voice)."

# 5) write env file (chmod 600) ---------------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"
# keep anything you added yourself (e.g. ANTHROPIC_API_KEY for the optional AI summaries)
KEEP=$(grep -v -E '^(CONDUCTOR_TOKEN|CONDUCTOR_BIND|CONDUCTOR_API_PORT|CONDUCTOR_HERDR_BIN|OPENAI_API_KEY)=' "$ENV_FILE" 2>/dev/null || true)
umask 177
{
  echo "CONDUCTOR_TOKEN=$TOKEN"
  echo "CONDUCTOR_BIND=127.0.0.1"
  echo "CONDUCTOR_API_PORT=$PORT"
  # the service's PATH often lacks ~/.local/bin, where Herdr installs: give it the full path
  echo "CONDUCTOR_HERDR_BIN=$HERDR_PATH"
  [ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY"
  [ -n "$KEEP" ] && printf '%s\n' "$KEEP"
} > "$ENV_FILE"
umask 022
chmod 600 "$ENV_FILE"
ok "wrote $ENV_FILE"

# 6) systemd --user service --------------------------------------------------
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/tmux-conductor.service" <<UNIT
[Unit]
Description=G2C backend (conductor-api)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $INSTALL_DIR/conductor_api.py
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
ok "wrote service unit"
run systemctl --user daemon-reload
run systemctl --user enable tmux-conductor.service
# restart, not just start: on an upgrade the service is already running the OLD files
run systemctl --user restart tmux-conductor.service
[ "$DRY" = 1 ] || warn "to keep it running after logout: sudo loginctl enable-linger $USER"

# 7) expose on the tailnet ---------------------------------------------------
run sudo tailscale set --operator="$USER"   # one-time, so 'tailscale serve' needs no sudo
run tailscale serve --bg "$PORT"

# 8) summary + paste-config --------------------------------------------------
DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
URL="https://${DNS:-<your-tailscale-host>.ts.net}"
BLOB="tmuxor:$(python3 -c 'import base64,json,sys;print(base64.urlsafe_b64encode(json.dumps({"base":sys.argv[1],"token":sys.argv[2]}).encode()).decode())' "$URL" "$TOKEN")"

echo
ok "G2C backend is up."
c  "Backend URL : $URL"
c  "Token       : $TOKEN"
echo
c  "On your phone: open G2C → Connection → 'Setup code'. Paste this line and tap Connect:"
echo "  $BLOB"
if command -v qrencode >/dev/null; then
  echo
  c "(or scan this QR with your phone's camera to copy the code, then paste it)"
  qrencode -t ANSIUTF8 "$BLOB"
  # the code carries your token: keep the saved copy readable by you only
  ( umask 177; qrencode -o "$HOME/tmuxor-setup-qr.png" "$BLOB" 2>/dev/null ) && chmod 600 "$HOME/tmuxor-setup-qr.png" \
    && c "(QR also saved to ~/tmuxor-setup-qr.png — it contains your token; delete it once you are set up)"
fi
echo
if [ -z "$DNS" ]; then warn "couldn't read your Tailscale domain — run 'tailscale status' and use your https://<host>.ts.net URL."; fi
