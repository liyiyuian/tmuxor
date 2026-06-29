#!/usr/bin/env bash
# Capture TMUXor store screenshots from the REAL Even Hub simulator (headless), with DEMO data.
# Proven method (mirrors the g2sidian project): the simulator is a WebKitGTK app that renders BLANK
# headless unless software rendering is forced — the two WEBKIT_DISABLE_* env vars below are the
# critical trick. We drive it via its automation HTTP API (--automation-port) and pull the native
# 576×288 glasses framebuffer. NEVER point this at a real backend — demo/fake data only.
#
#   Usage:  bash tools/capture-screenshots.sh
#   Output: store-assets/screenshots/0{1..4}-*.png  (all exactly 576×288)
set -u
cd "$(dirname "$0")/../glasses"
ROOT=..; SS=$ROOT/store-assets/screenshots; SIM=node_modules/.bin/evenhub-simulator; A=http://127.0.0.1:9898
settle(){ python3 -c "import time;time.sleep($1)"; }   # `sleep` may be sandbox-blocked
cleanup(){ pkill -f "[e]venhub-simulator"; pkill -f "[X]vfb :91"; pkill -f "[h]ttp.server 5173"; pkill -f "[s]creenshot-mock"; }
trap cleanup EXIT
cleanup; settle 0.5

# 1) demo build whose backend is baked to the local mock (auto-connects, skips Setup)
cp .env "$ROOT/.env.realbak" 2>/dev/null || true
printf 'VITE_PERSONAL=1\nVITE_CONDUCTOR_API=http://127.0.0.1:8799\nVITE_CONDUCTOR_TOKEN=demo\n' > .env
npm run build >/dev/null 2>&1 && echo "demo build ok"
[ -f "$ROOT/.env.realbak" ] && mv "$ROOT/.env.realbak" .env || rm -f .env

# 2) services + the simulator (headless, software render + automation server)
python3 "$ROOT/tools/screenshot-mock.py" >/dev/null 2>&1 &
python3 -m http.server 5173 --directory dist >/dev/null 2>&1 &
Xvfb :91 -screen 0 1280x800x24 >/dev/null 2>&1 &
settle 1
DISPLAY=:91 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 \
  "$SIM" http://localhost:5173 --automation-port 9898 >/tmp/tmuxor-sim.log 2>&1 &

# 3) wait for the automation server, then let the app load + connect + render
curl -s --retry 40 --retry-connrefused --retry-delay 1 "$A/api/ping" >/dev/null
settle 16

shot(){ curl -s "$A/api/screenshot/glasses" -o "$SS/$1.png"; echo "  $1 -> $(stat -c%s "$SS/$1.png")b"; }
inp(){ curl -s -X POST "$A/api/input" -H 'content-type: application/json' -d "{\"action\":\"$1\"}" >/dev/null; settle "${2:-4}"; }

# 4) drive the UI (list -> new-session -> approve -> conversation) and capture each
shot 01-fleet-list
inp click 6;       shot 04-new-session;     inp double_click 5      # row0 = + new session
inp down 2; inp click 8; shot 03-approve-command; inp double_click 5 # row1 = api (parked at a prompt)
inp down 2; inp click 8; shot 02-conversation                       # row2 = webapp (a reply)

echo "console (errors/fetch/uncaught):"
curl -s "$A/api/console" | python3 -c "import sys,json;[print('  ',e['level'],e['message'][:90]) for e in json.load(sys.stdin).get('entries',[]) if e['level'] in('error','warn') or 'fetch' in e['message'] or 'uncaught' in e['message'].lower()]" || true

# 5) verify every shot is exactly 576×288
echo "dimensions:"
for f in "$SS"/0*.png; do python3 -c "import struct;d=open('$f','rb').read();print('  $(basename $f)', struct.unpack('>II',d[16:24]))"; done
rm -rf dist  # demo build — don't leave it for an accidental pack
