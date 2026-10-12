#!/usr/bin/env bash
# Capture G2C store screenshots from the REAL Even Hub simulator (headless), with DEMO data.
# Proven method (mirrors the g2sidian project): the simulator is a WebKitGTK app that renders BLANK
# headless unless software rendering is forced — the two WEBKIT_DISABLE_* env vars below are the
# critical trick. We drive it via its automation HTTP API (--automation-port) and pull the native
# 576×288 glasses framebuffer. NEVER point this at a real backend — demo/fake data only.
#
#   Usage:  bash tools/capture-screenshots.sh
#   Run it as its OWN command (not chained after other commands): the cleanup below uses `pkill -f`
#   patterns, and `pkill -f` also matches a calling shell whose command line contains one of those
#   strings — the shell dies (exit 144) while this script keeps running, and a second run started on
#   top of it produces wrong screenshots. Always look at the PNGs before committing them.
#   Output: store-assets/screenshots/0{1..5}-*.png  (all exactly 576×288)
set -u
cd "$(dirname "$0")/../glasses"
ROOT=..; SS=$ROOT/store-assets/screenshots; SIM=node_modules/.bin/evenhub-simulator; A=http://127.0.0.1:9898
settle(){ python3 -c "import time;time.sleep($1)"; }   # `sleep` may be sandbox-blocked
DATA=$(mktemp -d)   # fresh webview profile per run, so pins saved by an earlier run can't leak into the shots
cleanup(){ pkill -f "[e]venhub-simulator"; pkill -f "[X]vfb :91"; pkill -f "[h]ttp.server 5173"; pkill -f "[s]creenshot-mock"; rm -rf "$DATA"; }
trap cleanup EXIT
cleanup; settle 0.5

# 1) demo build whose backend is baked to the local mock (auto-connects, skips Setup)
cp .env "$ROOT/.env.realbak" 2>/dev/null || true
printf 'VITE_PERSONAL=1\nVITE_CONDUCTOR_API=http://127.0.0.1:8799\nVITE_CONDUCTOR_TOKEN=demo\n' > .env
npm run build >/dev/null 2>&1 && echo "demo build ok"
[ -f "$ROOT/.env.realbak" ] && mv "$ROOT/.env.realbak" .env || rm -f .env

# 2) a pinned session, saved the way the phone saves it (the fresh profile has none)
python3 - "$DATA" <<'PY'
import json, os, sqlite3, sys
d = sys.argv[1] + "/com.evenrealities.evenhub-simulator/localstorage"; os.makedirs(d, exist_ok=True)
c = sqlite3.connect(d + "/http_localhost_5173.localstorage")
c.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)")
c.execute("insert into ItemTable values (?,?)", ("conductor.pins", json.dumps([{"n": "1", "cwd": "~/projects/webapp"}]).encode("utf-16-le")))
c.commit()
PY

# 3) services + the simulator (headless, software render + automation server)
python3 "$ROOT/tools/screenshot-mock.py" >/dev/null 2>&1 &
python3 -m http.server 5173 --directory dist >/dev/null 2>&1 &
Xvfb :91 -screen 0 1280x800x24 >/dev/null 2>&1 &
settle 1
XDG_DATA_HOME="$DATA" DISPLAY=:91 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 \
  "$SIM" http://localhost:5173 --automation-port 9898 >/tmp/tmuxor-sim.log 2>&1 &

# 4) wait for the automation server, then let the app load + connect + render (and the demo
#    'infra' session finish, so the list has a finished ● session at the top)
curl -s --retry 40 --retry-connrefused --retry-delay 1 "$A/api/ping" >/dev/null
settle 20

shot(){ curl -s "$A/api/screenshot/glasses" -o "$SS/$1.png"; echo "  $1 -> $(stat -c%s "$SS/$1.png")b"; }
inp(){ curl -s -X POST "$A/api/input" -H 'content-type: application/json' -d "{\"action\":\"$1\"}" >/dev/null; settle "${2:-4}"; }

# 5) drive the UI and capture each screen. The list, top to bottom: webapp (pinned, working), infra
#    (finished ●), api (needs you), webapp's Codex session, ml, docs, notes, billing, then
#    "＋ new session" on the next page. The highlight starts on the first row.
inp down 1; inp down 4;  shot 01-fleet-list                          # api: needs you, with its request and reply beside the list
inp click 8;             shot 03-approve-command; inp double_click 5  # its prompt, read before you choose; back to the list
inp down 1; inp down 1; inp down 3; inp click 8; shot 02-conversation; inp double_click 5   # docs: a finished reply; back
inp context_menu 2; inp down 1; inp down 1; inp down 1; inp down 1; inp click 9             # glasses menu -> "AI summary on / off"
shot 05-ai-summary                                                   # the same preview, now a short summary
inp up 1; inp up 1; inp up 1; inp up 1; inp up 1; inp up 2; inp click 6; shot 04-new-session   # wrap up to "＋ new session"

echo "console (errors/fetch/uncaught):"
curl -s "$A/api/console" | python3 -c "import sys,json;[print('  ',e['level'],e['message'][:90]) for e in json.load(sys.stdin).get('entries',[]) if e['level'] in('error','warn') or 'fetch' in e['message'] or 'uncaught' in e['message'].lower()]" || true

# 6) verify every shot is exactly 576×288
echo "dimensions:"
for f in "$SS"/0*.png; do python3 -c "import struct;d=open('$f','rb').read();print('  $(basename $f)', struct.unpack('>II',d[16:24]))"; done
rm -rf dist  # demo build — don't leave it for an accidental pack
