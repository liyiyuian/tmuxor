#!/usr/bin/env bash
# install.sh tests — run before every release:  bash tests/test_install.sh
# Sandboxed: a temp HOME, TMUXOR_DRYRUN=1 (no systemd / sudo / tailscale changes), stand-in herdr /
# tmux / claude / tailscale commands and test port 18790. It never touches a real install.
#   T1  the PUBLISHED version (OLD_REF, default origin/main) — fresh install, its backend answers
#   T2  upgrade: this tree's installer over it (token, OpenAI key, port and hand-added lines kept;
#       new files installed; service restarted), then the upgraded backend answers
#   T3  running it again changes nothing
#   T4  this tree, fresh install, no OpenAI key — and what each backend says to the other version's app
set -uo pipefail
NEW=$(cd "$(dirname "$0")/.." && pwd); OLD_REF=${OLD_REF:-origin/main}; PORT=18790
S=$(mktemp -d); PIDS=(); trap 'for p in "${PIDS[@]}"; do kill $p 2>/dev/null; done; rm -rf "$S"' EXIT
BIN=$S/bin; mkdir -p $BIN $S/old
cat > $BIN/herdr <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "pane list") echo '{"result":{"panes":[]}}';; "workspace list") echo '{"result":{"workspaces":[]}}';;
  "tab list") echo '{"result":{"tabs":[]}}';; *) echo '{}';;
esac
SH
cat > $BIN/tailscale <<'SH'
#!/usr/bin/env bash
[ "$1" = status ] && echo '{"Self":{"DNSName":"demo-host.demo-net.ts.net."}}'
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > $BIN/tmux; cp $BIN/tmux $BIN/claude; chmod +x $BIN/*
for f in install.sh conductor_api.py tmux_conductor.py sources.py; do git -C $NEW show $OLD_REF:$f > $S/old/$f; done
PASS=0; FAIL=0
check(){ if eval "$2"; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi; }
install(){ # install <home> <source dir> [VAR=value ...]  — non-interactive (setsid: no terminal to prompt on)
  local h=$1 src=$2; shift 2
  ( cd $S && setsid env HOME=$h XDG_CONFIG_HOME=$h/.config PATH="$BIN:$PATH" TMUXOR_DRYRUN=1 TMUXOR_SRC=$src "$@" bash $src/install.sh ) 2>&1; }
backend(){ # start the INSTALLED backend with the INSTALLED settings file, the way systemd would — a clean
  # environment (API keys exported in the tester's own shell must not leak in); echo its pid
  ( exec env -i HOME="$1" PATH="$BIN:$PATH" python3 -c 'import os,sys
for l in open(sys.argv[1]):
    l=l.rstrip("\n")
    if l and not l.startswith("#") and "=" in l: k,v=l.split("=",1); os.environ[k]=v
os.execvp("python3",["python3",sys.argv[2]])' "$1/.config/tmux-conductor.env" "$1/.local/share/tmuxor/conductor_api.py" ) >"$S/backend.log" 2>&1 &
  echo $!; }
code(){ curl -s -o /dev/null -w '%{http_code}' -m 5 ${2:+-H "Authorization: Bearer $2"} "http://127.0.0.1:$PORT$1"; }
body(){ curl -s -m 5 -H "Authorization: Bearer $2" "http://127.0.0.1:$PORT$1"; }
waitup(){ for i in $(seq 40); do [ "$(code /api/health)" = 200 ] && return 0; python3 -c 'import time;time.sleep(0.25)'; done; return 1; }
stop(){ kill $1 2>/dev/null; wait $1 2>/dev/null; }

echo "== T1: the published version ($OLD_REF), fresh install"
H=$S/h-old; mkdir -p $H
install $H $S/old CONDUCTOR_API_PORT=$PORT TMUXOR_OPENAI_KEY=sk-test-oldkey-AAAAAAAAAAAAAAAAAAAAAAAA > $S/t1.log
E=$H/.config/tmux-conductor.env; TOK=$(sed -n 's/^CONDUCTOR_TOKEN=//p' $E)
check "old installer finishes" "grep -q 'backend is up' $S/t1.log"
check "it installed the OLD backend (no plan-usage route)" "! grep -q '/api/limits' $H/.local/share/tmuxor/conductor_api.py"
P=$(backend $H); PIDS+=($P); waitup
check "old backend: health 200, no token -> 401" "[ \$(code /api/health) = 200 ] && [ \$(code /api/panes) = 401 ]"
check "old backend answers 404 for what only the new app asks (the app treats that as 'not offered')" "[ \$(code /api/limits $TOK) = 404 ] && [ \$(code /api/usage $TOK) = 404 ]"
stop $P
printf 'ANTHROPIC_API_KEY=sk-ant-test-AAAAAAAAAAAAAAAAAAAAAAAA\n# my note\nCONDUCTOR_LAUNCH_CMD=my-claude\n' >> $E   # what a user may have added by hand since

echo "== T2: upgrade — this tree's installer over it (no key given, no port given)"
install $H $NEW TMUXOR_OPENAI_KEY= > $S/t2.log
check "new installer finishes" "grep -q 'backend is up' $S/t2.log"
check "token kept" "[ \"\$(sed -n 's/^CONDUCTOR_TOKEN=//p' $E)\" = '$TOK' ]"
check "OpenAI key kept" "grep -qx 'OPENAI_API_KEY=sk-test-oldkey-AAAAAAAAAAAAAAAAAAAAAAAA' $E"
check "port kept ($PORT)" "grep -qx 'CONDUCTOR_API_PORT=$PORT' $E"
check "hand-added lines and comment kept" "grep -qx 'ANTHROPIC_API_KEY=sk-ant-test-AAAAAAAAAAAAAAAAAAAAAAAA' $E && grep -qx 'CONDUCTOR_LAUNCH_CMD=my-claude' $E && grep -qx '# my note' $E"
check "no setting appears twice" "[ -z \"\$(grep -v '^#' $E | cut -d= -f1 | sort | uniq -d)\" ]"
check "the herdr path is written for the service" "grep -qx 'CONDUCTOR_HERDR_BIN=$BIN/herdr' $E"
check "settings file is private (600)" "[ \$(stat -c %a $E) = 600 ]"
check "the upgrade restarts the service (it is already running the old files)" "grep -q 'systemctl --user restart tmux-conductor.service' $S/t2.log"
check "new backend files installed, with the status-line helper" "grep -q '/api/limits' $H/.local/share/tmuxor/conductor_api.py && [ -s $H/.local/share/tmuxor/g2c_usage_hook.py ] && [ -s $H/.local/share/tmuxor/sources.py ]"
check "the service unit points at the installed backend and settings" "grep -q \"ExecStart=.*$H/.local/share/tmuxor/conductor_api.py\" $H/.config/systemd/user/tmux-conductor.service && grep -q \"EnvironmentFile=$E\" $H/.config/systemd/user/tmux-conductor.service"
P=$(backend $H); PIDS+=($P); waitup
check "upgraded backend: health 200; no token -> 401 on the list, usage, limits and a summary" "[ \$(code /api/health) = 200 ] && [ \$(code /api/panes) = 401 ] && [ \$(code /api/usage) = 401 ] && [ \$(code /api/limits) = 401 ] && [ \$(code /api/panes/1/summary) = 401 ]"
check "upgraded backend, with the token: list, usage and limits 200" "[ \$(code /api/panes $TOK) = 200 ] && [ \$(code /api/usage $TOK) = 200 ] && [ \$(code /api/limits $TOK) = 200 ]"
check "it offers the models to choose from (hand-added Anthropic key kept -> summaries on)" "body /api/health $TOK | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"summary\"] and d[\"models\"][\"summary_default\"]==\"claude-haiku-5-5\" and d[\"voice\"] else 1)'"
check "what the OLD app asks still works (list without the new parameters; unknown pane -> 404, not an error)" "[ \$(code '/api/panes?claude_only=1' $TOK) = 200 ] && [ \$(code /api/panes/nope/conversation $TOK) = 404 ] && [ \$(code /api/windows $TOK) = 200 ]"
check "it binds loopback only" "ss -ltn 2>/dev/null | grep -q '127.0.0.1:$PORT ' && ! ss -ltn 2>/dev/null | grep -q '0.0.0.0:$PORT '"
check "its cost records and start marker went to the test home, not the real one" "[ -f $H/.tmux-conductor-usage.jsonl.start ]"
stop $P; cp $E $S/env-after-upgrade

echo "== T3: run the new installer again (must change nothing)"
install $H $NEW TMUXOR_OPENAI_KEY= > $S/t3.log
check "settings identical after a second run" "diff -q $S/env-after-upgrade $E >/dev/null"

echo "== T4: this tree, fresh install, no OpenAI key"
H2=$S/h-new; mkdir -p $H2
install $H2 $NEW CONDUCTOR_API_PORT=$PORT TMUXOR_OPENAI_KEY= > $S/t4.log
E2=$H2/.config/tmux-conductor.env; TOK2=$(sed -n 's/^CONDUCTOR_TOKEN=//p' $E2)
check "fresh install finishes and prints the setup code" "grep -q 'backend is up' $S/t4.log && grep -q 'tmuxor:ey' $S/t4.log"
check "fresh settings: a generated token, loopback, the port, the herdr path, no OpenAI key" "grep -q '^CONDUCTOR_TOKEN=tmxr_' $E2 && grep -qx 'CONDUCTOR_BIND=127.0.0.1' $E2 && grep -qx 'CONDUCTOR_API_PORT=$PORT' $E2 && grep -q '^CONDUCTOR_HERDR_BIN=' $E2 && ! grep -q OPENAI_API_KEY $E2"
check "the setup code carries the tailnet address and this token" "python3 -c 'import base64,json,re,sys; b=re.search(r\"tmuxor:(\\S+)\", open(sys.argv[1]).read()).group(1); d=json.loads(base64.urlsafe_b64decode(b)); sys.exit(0 if d==dict(base=\"https://demo-host.demo-net.ts.net\", token=sys.argv[2]) else 1)' $S/t4.log $TOK2"
P=$(backend $H2); PIDS+=($P); waitup
check "fresh backend: health 200, wrong token 401, right token 200" "[ \$(code /api/health) = 200 ] && [ \$(code /api/panes wrong) = 401 ] && [ \$(code /api/panes $TOK2) = 200 ]"
check "no API keys -> it offers neither voice nor summaries" "body /api/health $TOK2 | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if not d[\"voice\"] and not d[\"summary\"] else 1)'"
stop $P
echo; echo "RESULT: $PASS checks passed, $FAIL failed"; [ $FAIL = 0 ]
