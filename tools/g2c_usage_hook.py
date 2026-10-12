#!/usr/bin/env python3
"""G2C usage hook — lets the G2C backend show how much of your Claude plan is used.

Claude Code passes its status line command a JSON document on stdin; it includes the plan's
rate limits (rate_limits.five_hour / seven_day .used_percentage). This script saves just those
numbers to ~/.cache/g2c/usage/<label>.json, where the backend reads them. It never sees a login
token and makes no network request.

Use it one of two ways (Claude Code settings.json, "statusLine": {"type": "command", "command": …}):

  1. As your status line:        python3 /path/to/g2c_usage_hook.py
     (prints a short line such as  "5h 10% · week 13%")
  2. Inside a status line script you already have, before it prints anything:
         input=$(cat); printf '%s' "$input" | python3 /path/to/g2c_usage_hook.py save
     then keep using "$input" as before.

One file is written per account, named after the Claude config folder in use (set G2C_USAGE_LABEL
to choose the name yourself, e.g. "P" and "W" for two accounts).
"""
import json
import os
import sys
import time


def main():
    save_only = len(sys.argv) > 1 and sys.argv[1] == "save"
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    rl = data.get("rate_limits") or {}
    five, week = rl.get("five_hour") or {}, rl.get("seven_day") or {}
    if five or week:
        cfg = os.environ.get("CLAUDE_CONFIG_DIR", "")
        label = os.environ.get("G2C_USAGE_LABEL") or (os.path.basename(cfg.rstrip("/")) if cfg else "") or "Claude"
        label = "".join(c for c in label if c.isalnum() or c in "-_ ").strip()[:12] or "Claude"
        out = {"label": label, "five_hour": five.get("used_percentage"), "seven_day": week.get("used_percentage"),
               "five_hour_resets_at": five.get("resets_at"), "seven_day_resets_at": week.get("resets_at"), "at": time.time()}
        d = os.path.expanduser(os.environ.get("G2C_USAGE_DIR", "~/.cache/g2c/usage"))
        try:
            os.makedirs(d, mode=0o700, exist_ok=True)
            tmp = os.path.join(d, f".{label}.{os.getpid()}.tmp")
            with open(tmp, "w") as f:
                json.dump(out, f)
            os.replace(tmp, os.path.join(d, label + ".json"))   # atomic: the backend never reads a half-written file
        except OSError:
            pass
    if not save_only:
        pct = lambda w: f"{round(w['used_percentage'])}%" if isinstance(w.get("used_percentage"), (int, float)) else "–"
        print(f"5h {pct(five)} · week {pct(week)}")


if __name__ == "__main__":
    main()
