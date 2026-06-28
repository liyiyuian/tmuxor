// Client for conductor_api.py (the JSON control-plane over the tmux fleet).
// Connection comes from per-user config (localStorage), NOT build-time secrets.
import { getConfig, getProjectsDir, getOpenaiKeyPath } from './config'

const base = () => getConfig().base
const authHeaders = (): Record<string, string> => {
  const t = getConfig().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface Pane {
  id: string
  n: string
  window: number
  window_name: string
  pane_index: number
  title: string
  label: string
  tag: string
  status: 'waiting' | 'working' | 'idle' | 'other'
  cwd: string
  is_claude: boolean
  is_conductor: boolean
}

export async function listPanes(claudeOnly = true): Promise<Pane[]> {
  const r = await fetch(`${base()}/api/panes?claude_only=${claudeOnly ? 1 : 0}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`listPanes ${r.status}`)
  return (await r.json()).panes
}

// Capability probe — `voice` is true only if the backend has an OpenAI key, so the app can
// gate the talk gesture instead of failing on transcribe. Sends the token: the backend honors
// the caller's key-file path and reports where it looked ONLY for authed callers (those are
// gated behind auth so an unauthenticated tailnet peer can't probe arbitrary files).
const keyPathQ = () => { const p = getOpenaiKeyPath(); return p ? `?keypath=${encodeURIComponent(p)}` : '' }
export async function health(): Promise<{ ok: boolean; voice: boolean; checked?: string[] }> {
  const r = await fetch(`${base()}/api/health${keyPathQ()}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`health ${r.status}`)
  return r.json()
}

export async function paneScreen(n: string, lines = 40): Promise<string> {
  const r = await fetch(`${base()}/api/panes/${n}/screen?lines=${lines}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`paneScreen ${r.status}`)
  return (await r.json()).text
}

// For a Claude pane: the real back-and-forth (prompts + prose replies), markdown
// flattened, in-between stripped, oldest→newest.
export interface Turn { role: 'user' | 'assistant'; text: string }
export interface ConvoResult { turns: Turn[]; working: boolean; etag: string | null; notModified: boolean }
// Passes the last etag via ?etag=; an unchanged transcript returns a tiny
// {notModified:true} 200 (server skips read/parse/serialize). Plain 200s only — no
// HTTP 304, which the WebView's fetch rejects when combined with cache:'no-store'.
export async function paneConversation(n: string, etag?: string | null): Promise<ConvoResult> {
  const u = `${base()}/api/panes/${n}/conversation` + (etag ? `?etag=${encodeURIComponent(etag)}` : '')
  const r = await fetch(u, { headers: authHeaders(), cache: 'no-store' })
  if (!r.ok) throw new Error(`paneConversation ${r.status}`)
  const data = await r.json()
  if (data.notModified) return { turns: [], working: false, etag: data.etag ?? etag ?? null, notModified: true }
  return { turns: data.turns, working: data.working, etag: data.etag ?? null, notModified: false }
}

export async function sendToPane(n: string, text: string, submit = true): Promise<void> {
  const r = await fetch(`${base()}/api/panes/${n}/send`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ text, submit }),
  })
  if (!r.ok) throw new Error(`sendToPane ${r.status}`)
}

// Send raw tmux key names (e.g. ['Down','Down','Enter']) to drive a TUI menu.
export async function sendKeys(n: string, keys: string[]): Promise<void> {
  const r = await fetch(`${base()}/api/panes/${n}/keys`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
  if (!r.ok) throw new Error(`sendKeys ${r.status}`)
}

// For a non-Claude (shell) pane: turn a spoken description into a shell command.
export async function translate(description: string, cwd: string): Promise<string> {
  const r = await fetch(`${base()}/api/translate`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ description, cwd }),
  })
  if (!r.ok) throw new Error(`translate ${r.status}`)
  return (await r.json()).command
}

// Send captured WAV audio to the server -> OpenAI Whisper -> transcript + cost (USD).
export async function transcribe(wav: Blob): Promise<{ text: string; cost: number; seconds: number }> {
  const r = await fetch(`${base()}/api/transcribe${keyPathQ()}`, { method: 'POST', headers: authHeaders(), body: wav })
  if (!r.ok) throw new Error(`transcribe ${r.status}`)
  return r.json()
}

// New session: resolve a spoken folder to a directory, then spawn a Claude pane there.
export async function resolveFolder(text: string): Promise<{ found: boolean; path: string; create_path: string }> {
  const r = await fetch(`${base()}/api/resolve-folder`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ text, base: getProjectsDir() || undefined }),
  })
  if (!r.ok) throw new Error(`resolveFolder ${r.status}`)
  return r.json()
}
// Existing windows (project tags) to pick from when creating a session.
export async function listWindows(): Promise<{ index: number; name: string; panes: number }[]> {
  const r = await fetch(`${base()}/api/windows`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`listWindows ${r.status}`)
  return (await r.json()).windows
}
export async function newSession(path: string, tag?: string): Promise<{ ok?: boolean; n?: string; cwd?: string; how?: string; error?: string }> {
  const r = await fetch(`${base()}/api/new-session`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ path, tag, base: getProjectsDir() || undefined }),
  })
  return r.json()
}

// Live screen tail via SSE. Token (if any) goes in the query string because
// EventSource cannot set headers.
export function streamPane(n: string, onText: (text: string) => void): EventSource {
  const token = getConfig().token
  const url = token
    ? `${base()}/api/events/${n}?token=${encodeURIComponent(token)}`
    : `${base()}/api/events/${n}`
  const es = new EventSource(url)
  es.onmessage = (e) => {
    try {
      onText(JSON.parse(e.data).text)
    } catch {
      /* ignore malformed frame */
    }
  }
  return es
}
