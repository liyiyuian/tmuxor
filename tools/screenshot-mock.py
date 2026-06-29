#!/usr/bin/env python3
# Demo backend for capturing store screenshots in the evenhub simulator — DEMO/FAKE data only,
# never real sessions. Serves the conductor API the glasses app expects, with CORS. Port 8799.
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PANES = [
    {"n":"1","window":1,"window_name":"api","pane_index":0,"tag":"api","label":"rate-limit needs OK","title":"api","status":"waiting","cwd":"~/projects/api","is_claude":True,"is_conductor":False,"id":"%1"},
    {"n":"2","window":2,"window_name":"webapp","pane_index":0,"tag":"webapp","label":"auth refactor","title":"webapp","status":"working","cwd":"~/projects/webapp","is_claude":True,"is_conductor":False,"id":"%2"},
    {"n":"3","window":3,"window_name":"ml","pane_index":0,"tag":"ml","label":"training sweep","title":"ml","status":"working","cwd":"~/projects/ml","is_claude":True,"is_conductor":False,"id":"%3"},
    {"n":"4","window":4,"window_name":"infra","pane_index":0,"tag":"infra","label":"terraform plan","title":"infra","status":"working","cwd":"~/projects/infra","is_claude":True,"is_conductor":False,"id":"%4"},
    {"n":"5","window":5,"window_name":"docs","pane_index":0,"tag":"docs","label":"draft changelog","title":"docs","status":"idle","cwd":"~/projects/docs","is_claude":True,"is_conductor":False,"id":"%5"},
    {"n":"6","window":6,"window_name":"notes","pane_index":0,"tag":"notes","label":"meeting prep","title":"notes","status":"idle","cwd":"~/notes","is_claude":True,"is_conductor":False,"id":"%6"},
]
CONVO = {"turns":[
    {"role":"user","text":"add refresh-token rotation"},
    {"role":"assistant","text":"Added rotation: every refresh issues a new refresh token and revokes the previous one, so a stolen token is single-use. Reuse of a revoked token now invalidates the whole chain and forces a re-login. Existing sessions migrate on their next refresh."},
], "working":False, "etag":"demo1", "notModified":False}
# a pane sitting at a Bash permission prompt (for the read-before-approve screenshot)
MENU_SCREEN = ("● Bash(npm run deploy -- --env=staging)\n  ⎿ building...\n"
               "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for npm commands\n"
               "  3. No, and tell Claude what to do differently (esc)\n")
WINDOWS = [{"index":i+1,"name":w,"panes":1} for i,w in enumerate(["api","webapp","infra","ml","docs","notes"])]

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
        p=urlparse(self.path).path
        if p=="/api/health": return self._json({"ok":True,"service":"mock","voice":True})
        if p=="/api/panes": return self._json({"panes":PANES})
        if p=="/api/windows": return self._json({"windows":WINDOWS})
        if p.endswith("/conversation"): return self._json(CONVO)
        if p.endswith("/screen"): return self._json({"text":MENU_SCREEN})
        if "/events/" in p:  # SSE: pane 1 shows the permission prompt; others just idle
            self.send_response(200); self.send_header("content-type","text/event-stream"); self._cors(); self.end_headers()
            scr = MENU_SCREEN if "/events/1" in p else "❯ \n"
            try:
                for _ in range(600):
                    self.wfile.write(f"data: {json.dumps({'id':'%1','text':scr})}\n\n".encode()); self.wfile.flush(); time.sleep(1)
            except Exception: return
            return
        self._json({"error":"nf"})
    def do_POST(self):
        p=urlparse(self.path).path
        if p=="/api/resolve-folder": return self._json({"found":True,"path":"~/projects/demo","create_path":"~/projects/demo"})
        if p=="/api/new-session": return self._json({"ok":True,"n":"7","cwd":"~/projects/demo","how":"created"})
        if p=="/api/transcribe": return self._json({"text":"add a dark-mode toggle to the settings page","cost":0.0003,"seconds":3.1})
        self._json({"ok":True})

if __name__=="__main__":
    print("mock on http://127.0.0.1:8799"); ThreadingHTTPServer(("127.0.0.1",8799),H).serve_forever()
