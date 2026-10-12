#!/usr/bin/env python3
# Demo backend for capturing store screenshots in the evenhub simulator — DEMO/FAKE data only,
# never real sessions. Serves the conductor API the glasses app expects, with CORS. Port 8799.
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

T0 = time.time()
def P(n, tag, label, status, agent="claude"):
    return {"n": str(n), "window": n, "window_name": tag, "pane_index": 0, "tag": tag, "label": label, "title": tag, "status": status,
            "cwd": f"~/projects/{tag}", "is_claude": True, "is_conductor": False, "id": f"%{n}", "agent": agent}
# in the order of the computer's layout (workspaces, then tabs)
PANES = [P(1, "webapp", "auth refactor", "working"), P(2, "api", "rate-limit needs OK", "waiting"), P(3, "webapp", "review PR 212", "idle", "codex"),
         P(4, "ml", "training sweep", "working"), P(5, "infra", "terraform plan", "working"), P(6, "docs", "draft changelog", "idle"),
         P(7, "notes", "meeting prep", "idle"), P(8, "billing", "invoice export", "idle")]
FIRST = []
def panes():
    # infra finishes a few seconds after the app has first seen it working (counted from the app's
    # first look, however long the simulator took to start), so the list shows a "finished since
    # you last opened it" session at the top
    FIRST.append(time.time())
    out = [dict(p) for p in PANES]
    if time.time() - FIRST[0] > 7: out[4]["status"] = "idle"
    return out
def C(prompt, reply, working=False, queued=()):
    return {"turns": [{"role": "user", "text": "earlier question"}, {"role": "assistant", "text": "Earlier answer."},
                      {"role": "user", "text": prompt}, {"role": "assistant", "text": reply}], "working": working, "queued": list(queued)}
CONVOS = {
    "1": C("add refresh-token rotation", "Added rotation: every refresh issues a new refresh token and revokes the previous one, so a stolen token is single-use.\nRunning the auth tests now.", True, ["also update the changelog when the tests pass"]),
    "2": C("deploy the rate limiter to staging", "Built the image and ran the migration dry-run: 2 tables change, no data loss.\nThe deploy needs your OK before I run it."),
    "3": C("review PR 212", "Two small issues, both in the config loader: a missing default and an unused import.\nWant me to push the fixes?"),
    "4": C("sweep learning rate and warmup", "Launched 12 runs across lr 1e-4..3e-3.\n4 of 12 finished; best so far is lr 3e-4 with val loss 0.412.", True),
    "5": C("plan the terraform change for the new VPC", "Plan: 7 to add, 2 to change, 0 to destroy.\nThe two changes are security-group rule updates. Nothing is applied yet."),
    "6": C("draft the changelog for 2.3", "Drafted 14 entries grouped by area: 6 features, 5 fixes, 3 internal.\nI left the two breaking changes at the top with migration notes.\n\nWant me to open a PR with it?"),
    "7": C("prep notes for the planning meeting", "Agenda drafted with three topics and owners.\nI left two open questions at the top for you."),
    "8": C("export last month's invoices", "Exported 212 invoices to invoices-2026-09.csv.\nTotals match the ledger."),
}
SUMS = {
    "1": "Rotation added; auth tests are running.",
    "2": "Needs you: OK the staging deploy. Dry-run changes 2 tables, no data loss.",
    "3": "Needs you: push fixes for a missing default and an unused import in the config loader?",
    "5": "Plan ready: 7 to add, 2 to change, 0 to destroy. Nothing applied yet.",
    "6": "Needs you: open a PR for the 2.3 changelog? 14 entries drafted, breaking changes on top.",
    "7": "Agenda drafted with three topics and owners; two open questions left for you.",
    "8": "Exported 212 invoices to invoices-2026-09.csv; totals match the ledger.",
}
MODELS = {"summary": [{"id": "claude-haiku-5-5", "label": "Haiku 5.5", "in": 0.1, "out": 0.5}], "summary_default": "claude-haiku-5-5",
          "voice": [{"id": "whisper-1", "label": "Whisper", "per_min": 0.006}], "voice_default": "whisper-1"}
# a pane sitting at a Bash permission prompt (for the read-before-approve screenshot)
MENU_SCREEN = ("● Bash(npm run deploy -- --env=staging)\n  ⎿ building...\n"
               "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for npm commands\n"
               "  3. No, and tell Claude what to do differently (esc)\n")
WINDOWS = [{"index": i + 1, "name": w, "panes": 1} for i, w in enumerate(["webapp", "api", "ml", "infra", "docs", "notes", "billing"])]
SEEN = set()

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("access-control-allow-origin","*")
        self.send_header("access-control-allow-headers","*")
        self.send_header("access-control-allow-methods","GET,POST,OPTIONS")
    def _json(self,o):
        b=json.dumps(o).encode(); self.send_response(200)
        self.send_header("content-type","application/json"); self._cors()
        self.send_header("content-length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
    def do_OPTIONS(self): self.send_response(204); self._cors(); self.send_header("content-length","0"); self.end_headers()
    def do_GET(self):
        u=urlparse(self.path); p=u.path; q=parse_qs(u.query); n=p.split("/")[3] if p.startswith("/api/panes/") else ""
        if p=="/api/health": return self._json({"ok":True,"service":"mock","voice":True,"summary":True,"condense":True,"models":MODELS})
        if p=="/api/panes": return self._json({"panes":panes()})
        if p=="/api/windows": return self._json({"windows":WINDOWS})
        if p=="/api/limits":   # two Claude accounts and Codex: percent of the 5-hour and weekly limits used
            return self._json({"limits":[{"label":"A","agent":"claude","session":12,"week":30},{"label":"B","agent":"claude","session":55,"week":62},{"label":"Codex","agent":"codex","session":None,"week":40}]})
        if p=="/api/usage": return self._json({"today":[],"week":[],"all":[],"since":None,"start":T0})
        if p.endswith("/conversation"):
            c=dict(CONVOS.get(n, CONVOS["6"])); etag="demo-"+n
            if q.get("etag",[""])[0]==etag: return self._json({"notModified":True,"etag":etag})
            if not c["working"]: c["queued"]=[]
            return self._json({**c,"etag":etag,"start":0,"prompts":2})
        if p.endswith("/summary") or p.endswith("/condensed"):
            c=CONVOS.get(n, CONVOS["6"]); etag="demo-"+n
            if c["working"]: return self._json({"summary":None,"reason":"working","etag":etag})
            if p not in SEEN: SEEN.add(p); return self._json({"pending":True,"etag":etag})   # as the real one: written in the background
            return self._json({"summary":SUMS.get(n) if p.endswith("/summary") else None,"etag":etag})
        if p.endswith("/screen"): return self._json({"text":MENU_SCREEN})
        if "/events/" in p:  # SSE: the api session shows the permission prompt; others just idle
            self.send_response(200); self.send_header("content-type","text/event-stream"); self._cors(); self.end_headers()
            scr = MENU_SCREEN if p.rstrip("/").endswith("/events/2") else "❯ \n"
            try:
                for _ in range(600):
                    self.wfile.write(f"data: {json.dumps({'id':'%2','text':scr})}\n\n".encode()); self.wfile.flush(); time.sleep(1)
            except Exception: return
            return
        self._json({"error":"nf"})
    def do_POST(self):
        p=urlparse(self.path).path
        if p=="/api/resolve-folder": return self._json({"found":True,"path":"~/projects/demo","create_path":"~/projects/demo"})
        if p=="/api/new-session": return self._json({"ok":True,"n":"9","cwd":"~/projects/demo","how":"created"})
        if p=="/api/transcribe": return self._json({"text":"add a dark-mode toggle to the settings page","cost":0.0003,"seconds":3.1})
        self._json({"ok":True})

if __name__=="__main__":
    print("mock on http://127.0.0.1:8799"); ThreadingHTTPServer(("127.0.0.1",8799),H).serve_forever()
