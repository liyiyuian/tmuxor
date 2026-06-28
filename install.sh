#!/usr/bin/env bash
# TMUXor backend installer — one command to stand up the control plane on YOUR machine.
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
#   TMUXOR_OPENAI_KEY=sk-...   supply the OpenAI key non-interactively ("" = skip voice)
set -euo pipefail

REPO="${TMUXOR_REPO:-liyiyuian/tmuxor}"
RAW="https://raw.githubusercontent.com/${REPO}/main"
PORT="${CONDUCTOR_API_PORT:-8790}"
INSTALL_DIR="${TMUXOR_DIR:-$HOME/.local/share/tmuxor}"
ENV_FILE="${TMUXOR_ENV:-$HOME/.config/tmux-conductor.env}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY="${TMUXOR_DRYRUN:-0}"

c()  { printf '\033[36m%s\033[0m\n' "$*"; }      # info
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m! %s\033[0m\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run(){ if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

c "TMUXor backend installer"

# 1) prerequisites -----------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found (need 3.10+). Install Python first."
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
python3 -c 'import sys;exit(0 if sys.version_info[:2]>=(3,10) else 1)' || die "python3 $PYV too old; need 3.10+."
ok "python3 $PYV"
command -v tmux >/dev/null   && ok "tmux"      || die "tmux not found. Install tmux."
command -v claude >/dev/null && ok "claude"    || warn "claude (Claude Code) not on PATH — install it so sessions can launch."
command -v tailscale >/dev/null && ok "tailscale" || die "tailscale not found. Install + log in: https://tailscale.com/download"

# 2) download backend --------------------------------------------------------
mkdir -p "$INSTALL_DIR"
for f in conductor_api.py tmux_conductor.py; do
  if [ -n "${TMUXOR_SRC:-}" ]; then
    cp "$TMUXOR_SRC/$f" "$INSTALL_DIR/$f"
  else
    curl -fsSL "$RAW/$f" -o "$INSTALL_DIR/$f" || die "could not download $f from $RAW"
  fi
done
ok "backend in $INSTALL_DIR"

# 3) token (reuse existing if present) ---------------------------------------
TOKEN=""
[ -f "$ENV_FILE" ] && TOKEN=$(sed -n 's/^CONDUCTOR_TOKEN=//p' "$ENV_FILE" | head -1)
if [ -z "$TOKEN" ]; then
  TOKEN="tmxr_$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
  ok "generated a new access token"
else
  ok "reusing existing access token"
fi

# 4) OpenAI key (OPTIONAL) — enables VOICE input. Without it you just type replies and
#    new-session names on your phone instead. ---------------------------------
if [ "${TMUXOR_OPENAI_KEY+set}" = set ]; then
  OPENAI_KEY="$TMUXOR_OPENAI_KEY"
elif [ -r /dev/tty ]; then
  printf 'OpenAI API key (optional) — enables VOICE input via Whisper; without it you type on your phone. Paste it, or Enter to skip: '
  read -r OPENAI_KEY </dev/tty || OPENAI_KEY=""
else
  OPENAI_KEY=""
fi
[ -n "$OPENAI_KEY" ] && ok "voice input enabled" || warn "no OpenAI key — voice input off; you'll type replies/new-session names on your phone (re-run later to add voice)."

# 5) write env file (chmod 600) ---------------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"
umask 177
{
  echo "CONDUCTOR_TOKEN=$TOKEN"
  echo "CONDUCTOR_BIND=127.0.0.1"
  echo "CONDUCTOR_API_PORT=$PORT"
  [ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY"
} > "$ENV_FILE"
umask 022
chmod 600 "$ENV_FILE"
ok "wrote $ENV_FILE"

# 6) systemd --user service --------------------------------------------------
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/tmux-conductor.service" <<UNIT
[Unit]
Description=TMUXor backend (conductor-api)
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
run systemctl --user enable --now tmux-conductor.service
[ "$DRY" = 1 ] || warn "to keep it running after logout: sudo loginctl enable-linger $USER"

# 7) expose on the tailnet ---------------------------------------------------
run sudo tailscale set --operator="$USER"   # one-time, so 'tailscale serve' needs no sudo
run tailscale serve --bg "$PORT"

# 8) summary + paste-config --------------------------------------------------
DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
URL="https://${DNS:-<your-tailscale-host>.ts.net}"
BLOB="tmuxor:$(python3 -c 'import base64,json,sys;print(base64.urlsafe_b64encode(json.dumps({"base":sys.argv[1],"token":sys.argv[2]}).encode()).decode())' "$URL" "$TOKEN")"

echo
ok "TMUXor backend is up."
c  "Backend URL : $URL"
c  "Token       : $TOKEN"
echo
c  "On your phone: open TMUXor → Setup → 'Paste config'. Paste this line:"
echo "  $BLOB"
if command -v qrencode >/dev/null; then
  echo
  c "(or scan this QR with your phone's camera to copy the code, then paste it)"
  qrencode -t ANSIUTF8 "$BLOB"
  qrencode -o "$HOME/tmuxor-setup-qr.png" "$BLOB" 2>/dev/null && c "(QR also saved to ~/tmuxor-setup-qr.png)"
fi
echo
[ -z "$DNS" ] && warn "couldn't read your Tailscale domain — run 'tailscale status' and use your https://<host>.ts.net URL."
