// Client for conductor_api.py (the JSON control-plane over the tmux fleet).
// Connection comes from per-user config (localStorage), NOT build-time secrets.
import { getConfig, getProjectsDir, getOpenaiKeyPath, getSource } from './config'

const base = () => getConfig().base
const authHeaders = (): Record<string, string> => {
  const t = getConfig().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}

// The selected backend, sent on every call as ?source= (also the ONLY channel for SSE,
// whose EventSource can't set headers). Empty when the user hasn't picked -> omitted, so
// the backend uses its own default and the request is byte-identical to before.
const srcParam = (): string => { const s = getSource(); return s ? `source=${encodeURIComponent(s)}` : '' }
// Join non-empty query parts onto a URL as ?a&b (handles the empty case cleanly).
const qs = (...parts: (string | false | undefined)[]): string => {
  const q = parts.filter(Boolean).join('&')
  return q ? `?${q}` : ''
}
// Pane ids are opaque tokens: tmux '29' (URL-safe) or herdr 'w3:p6' (has ':') — encode both.
const pid = (n: string): string => encodeURIComponent(n)

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
  is_claude: boolean   // an agent session with a readable conversation (Claude Code or Codex)
  agent?: string       // 'claude' | 'codex' | '' — absent from a backend that predates Codex support
  is_conductor: boolean
  done?: boolean  // client-only: set once a session goes working->idle, until it's opened — shown as ● (◆ for Codex)
  pinned?: boolean  // client-only: the user pinned this session to the top (config.ts getPins)
}

export async function listPanes(claudeOnly = true): Promise<Pane[]> {
  const r = await fetch(`${base()}/api/panes${qs(`claude_only=${claudeOnly ? 1 : 0}`, srcParam())}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`listPanes ${r.status}`)
  return (await r.json()).panes
}

// Capability probe — `voice` is true only if the backend has an OpenAI key, so the app can
// gate the talk gesture instead of failing on transcribe. Sends the token: the backend honors
// the caller's key-file path and reports where it looked ONLY for authed callers (those are
// gated behind auth so an unauthenticated tailnet peer can't probe arbitrary files).
const modelQ = (m?: string) => !!m && `model=${encodeURIComponent(m)}`
const keyPathQ = () => { const p = getOpenaiKeyPath(); return p ? `keypath=${encodeURIComponent(p)}` : '' }
// `sources` = which backends this machine can serve (authed-only); `source` = its default (the
// phone no longer offers a choice between them).
// `summary` = the backend has an Anthropic key and can write AI summaries (it only does when asked).
// The models the backend offers, with list prices: Anthropic for summaries / condensed replies
// (USD per million tokens in / out), OpenAI speech-to-text for voice (USD per minute of audio).
export interface ModelChoice { id: string; label: string; in?: number | null; out?: number | null; per_min?: number | null }
export interface Models { summary: ModelChoice[]; summary_default: string; voice: ModelChoice[]; voice_default: string }
export async function health(): Promise<{ ok: boolean; voice: boolean; checked?: string[]; sources?: string[]; source?: string; summary?: boolean; condense?: boolean; models?: Models }> {
  const r = await fetch(`${base()}/api/health${qs(keyPathQ())}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`health ${r.status}`)
  return r.json()
}

export async function paneScreen(n: string, lines = 40): Promise<string> {
  const r = await fetch(`${base()}/api/panes/${pid(n)}/screen${qs(`lines=${lines}`, srcParam())}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`paneScreen ${r.status}`)
  return (await r.json()).text
}

// For a Claude pane: the real back-and-forth (prompts + prose replies), markdown
// flattened, in-between stripped, oldest→newest.
export interface Turn { role: 'user' | 'assistant'; text: string }
// `queued` = prompts typed while the agent was busy that it has not taken up yet (first line of each)
export interface ConvoResult { turns: Turn[]; working: boolean; etag: string | null; notModified: boolean; queued: string[]; start?: number; prompts?: number }
// Passes the last etag via ?etag=; an unchanged transcript returns a tiny
// {notModified:true} 200 (server skips read/parse/serialize). Plain 200s only — no
// HTTP 304, which the WebView's fetch rejects when combined with cache:'no-store'.
// `tail` asks for only the latest prompt + the end of its reply (the list preview) — a couple of KB
// instead of the whole conversation. An older backend ignores it and returns everything, which works.
// `turns` = only the last N turns; `from` = everything from turn K (see store.ts: the reading view
// loads the recent part and fetches earlier messages when you scroll up to them). The answer says
// where it starts (`start`) and how many prompts the whole conversation has (`prompts`); an older
// backend ignores both parameters and sends everything.
export async function paneConversation(n: string, etag?: string | null, opts: { tail?: boolean; signal?: AbortSignal; turns?: number; from?: number } = {}): Promise<ConvoResult> {
  const u = `${base()}/api/panes/${pid(n)}/conversation` + qs(etag ? `etag=${encodeURIComponent(etag)}` : '', opts.tail && 'tail=1',
    opts.from != null && `from=${opts.from}`, !!opts.turns && `turns=${opts.turns}`, srcParam())
  const r = await fetch(u, { headers: authHeaders(), cache: 'no-store', signal: opts.signal })
  if (!r.ok) throw new Error(`paneConversation ${r.status}`)
  const data = await r.json()
  if (data.notModified) return { turns: [], working: false, etag: data.etag ?? etag ?? null, notModified: true, queued: [] }
  return { turns: data.turns, working: data.working, etag: data.etag ?? null, notModified: false, queued: data.queued ?? [], start: data.start ?? 0, prompts: data.prompts }
}

// Opt-in AI summary of a session's latest exchange (written by the backend with the user's own
// Anthropic key). `pending` = it is being written, ask again; `etag` = the transcript state it is for.
// `max` = how many characters the preview can show; `model` = one of the backend's offered models
// ('' = its default). An older backend ignores both.
export async function paneSummary(n: string, o: { model?: string; max?: number } = {}): Promise<{ summary?: string | null; pending?: boolean; etag?: string | null }> {
  const r = await fetch(`${base()}/api/panes/${pid(n)}/summary${qs(srcParam(), modelQ(o.model), !!o.max && `max=${o.max}`)}`, { headers: authHeaders(), cache: 'no-store' })
  if (!r.ok) throw new Error(`paneSummary ${r.status}`)
  return r.json()
}

// Opt-in condensed version of a session's latest reply, for the reading view. Same shape and rules
// as paneSummary; `summary` null = nothing to condense (the reply is short, declined, …): show it whole.
export async function paneCondensed(n: string, model = ''): Promise<{ summary?: string | null; pending?: boolean; etag?: string | null }> {
  const r = await fetch(`${base()}/api/panes/${pid(n)}/condensed${qs(srcParam(), modelQ(model))}`, { headers: authHeaders(), cache: 'no-store' })
  if (!r.ok) throw new Error(`paneCondensed ${r.status}`)
  return r.json()
}

// Plan usage per account: how much of a Claude / Codex subscription's limits is used, in percent
// (null = unknown). `session` is the short window (5 hours), `week` the weekly one. The backend
// reads these from local files only. Empty from a backend that predates this.
export interface Limit { label: string; agent: string; session: number | null; week: number | null }
export async function getLimits(): Promise<Limit[]> {
  const r = await fetch(`${base()}/api/limits`, { headers: authHeaders(), cache: 'no-store' })
  if (!r.ok) return []
  const d = await r.json()
  return Array.isArray(d.limits) ? d.limits : []
}

// What the backend's paid API calls cost — today, the last 7 days and all time, per provider and
// model. `start` (seconds) = when its records begin; `since` = the same, set only when that is
// less than 7 days ago. `all` / `start` are missing from an older backend; the whole thing is null
// from one that predates this.
export interface UsageRow { provider: string; model: string; calls: number; in: number; out: number; seconds: number; usd: number; unpriced: number }
export interface Usage { today: UsageRow[]; week: UsageRow[]; all?: UsageRow[]; since: number | null; start?: number | null }
export async function getUsage(): Promise<Usage | null> {
  const r = await fetch(`${base()}/api/usage`, { headers: authHeaders(), cache: 'no-store' })
  if (!r.ok) return null
  const d = await r.json()
  return Array.isArray(d.today) && Array.isArray(d.week) ? d : null
}

export async function sendToPane(n: string, text: string, submit = true): Promise<void> {
  const r = await fetch(`${base()}/api/panes/${pid(n)}/send${qs(srcParam())}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ text, submit }),
  })
  if (!r.ok) throw new Error(`sendToPane ${r.status}`)
}

// Send raw tmux key names (e.g. ['Down','Down','Enter']) to drive a TUI menu.
export async function sendKeys(n: string, keys: string[]): Promise<void> {
  const r = await fetch(`${base()}/api/panes/${pid(n)}/keys${qs(srcParam())}`, {
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

// Send captured WAV audio to the server -> OpenAI speech-to-text (`model`: one the backend offers,
// '' = its default, Whisper) -> transcript + cost (USD).
export async function transcribe(wav: Blob, model = ''): Promise<{ text: string; cost: number; seconds: number }> {
  const r = await fetch(`${base()}/api/transcribe${qs(keyPathQ(), modelQ(model))}`, { method: 'POST', headers: authHeaders(), body: wav })
  if (!r.ok) throw new Error(`transcribe ${r.status}`)
  return r.json()
}

// New session: resolve a spoken folder to a directory, then spawn a Claude pane there.
export async function resolveFolder(text: string): Promise<{ found: boolean; path: string; create_path: string }> {
  const r = await fetch(`${base()}/api/resolve-folder${qs(srcParam())}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ text, base: getProjectsDir() || undefined }),
  })
  if (!r.ok) throw new Error(`resolveFolder ${r.status}`)
  return r.json()
}
// Existing windows (project tags) to pick from when creating a session.
export async function listWindows(): Promise<{ index: number; name: string; panes: number }[]> {
  const r = await fetch(`${base()}/api/windows${qs(srcParam())}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`listWindows ${r.status}`)
  return (await r.json()).windows
}
export async function newSession(path: string, tag?: string): Promise<{ ok?: boolean; n?: string; cwd?: string; how?: string; error?: string }> {
  const r = await fetch(`${base()}/api/new-session${qs(srcParam())}`, {
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
  // token + source both go in the query — EventSource can't set headers.
  const url = `${base()}/api/events/${pid(n)}` + qs(token ? `token=${encodeURIComponent(token)}` : '', srcParam())
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
