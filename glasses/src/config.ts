// Per-user connection config. Stored in the WebView's localStorage (fast, sync) AND mirrored
// to the Even app's persistent storage via the SDK, so it survives app reinstalls/updates —
// the user enters it once and never again (unless they clear it). Nothing is baked into the
// shipped app. The build-time env fallback is used ONLY for a personal build (VITE_PERSONAL=1).
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

const LS_URL = 'conductor.baseUrl'
const LS_TOKEN = 'conductor.token'
const LS_PROJECTS = 'conductor.projectsDir'      // where new sessions' folders are created
const LS_OPENAI_PATH = 'conductor.openaiKeyPath' // optional PATH to the OpenAI key FILE (never the key itself)
const LS_IDLE_SEC = 'conductor.idleSleepSec'     // seconds the glasses HUD stays on before sleeping (0 = always on)
const LS_WAKE_CHANGE = 'conductor.wakeOnChange'  // wake the HUD when a session changes (working -> done / needs-input)
const LS_SOURCE = 'conductor.source'             // which backend multiplexer to drive: '' = backend default, else 'tmux'|'herdr'
const LS_PINS = 'conductor.pins'                 // sessions pinned to the top of the list (client-side; see Pin)
const LS_AI_SUMMARY = 'conductor.aiSummary'      // opt-in: summarize list previews with the user's own Anthropic key
const PERSIST_KEY = 'conductor.config'           // single key in the phone app's persistent store
const PERSONAL = !!import.meta.env.VITE_PERSONAL  // personal build only

export interface Config { base: string; token: string }

export function getConfig(): Config {
  const envBase = PERSONAL ? import.meta.env.VITE_CONDUCTOR_API : ''
  const envToken = PERSONAL ? import.meta.env.VITE_CONDUCTOR_TOKEN : ''
  const base = (localStorage.getItem(LS_URL) || envBase || '').replace(/\/+$/, '')
  const token = localStorage.getItem(LS_TOKEN) || envToken || ''
  return { base, token }
}

// Optional override for where new-session folders are created (default: the backend's ~/projects).
export function getProjectsDir(): string { return localStorage.getItem(LS_PROJECTS) || '' }
// Optional PATH (on the backend) to a file holding the OpenAI key — the key itself never touches
// the phone; the backend reads it from this path (it also auto-discovers common locations).
export function getOpenaiKeyPath(): string { return localStorage.getItem(LS_OPENAI_PATH) || '' }
// Glasses idle sleep: seconds of no interaction before the HUD blanks (0 = always on).
export function getIdleSleepSec(): number { return Math.max(0, Math.floor(Number(localStorage.getItem(LS_IDLE_SEC) || '0')) || 0) }
// Wake the blanked HUD when a session changes state (working -> done / needs-input). Default on.
export function getWakeOnChange(): boolean { return localStorage.getItem(LS_WAKE_CHANGE) !== '0' }
// Which backend hosts the sessions: '' = let the backend use its configured default (tmux);
// otherwise 'tmux' | 'herdr'. Sent as ?source= on every backend call; the backend gates on
// what it actually has (advertised via /api/health) and falls back to its default if absent.
export function getSource(): string { return localStorage.getItem(LS_SOURCE) || '' }
// AI summaries in the list preview. OFF unless the user turns it on: it sends session text to
// Anthropic from their backend and is billed to their own key.
export function getAiSummary(): boolean { return localStorage.getItem(LS_AI_SUMMARY) === '1' }
// Pinned sessions, kept on this phone (no backend change needed). Keyed by the pane id `n` — tmux
// ('29') and herdr ('w3:p6') ids can't collide, so one list serves both backends. `cwd` is a
// fingerprint: tmux reuses pane ids after a server restart, so a pin whose id now belongs to a
// session in a DIFFERENT folder is stale and is ignored (store.ts decorateAndSort) instead of
// sticking to the wrong session.
export interface Pin { n: string; cwd: string }
export function getPins(): Pin[] {
  try { const v = JSON.parse(localStorage.getItem(LS_PINS) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

function persist() {
  const c = getConfig()
  waitForEvenAppBridge()
    .then((b) => b.setLocalStorage(PERSIST_KEY, JSON.stringify({ base: c.base, token: c.token, projectsDir: getProjectsDir(), openaiKeyPath: getOpenaiKeyPath(), idleSleepSec: getIdleSleepSec(), wakeOnChange: getWakeOnChange(), source: getSource(), pins: getPins(), aiSummary: getAiSummary() })))
    .catch(() => {})
}

export function setConfig(c: Config) {
  localStorage.setItem(LS_URL, c.base.trim().replace(/\/+$/, ''))
  localStorage.setItem(LS_TOKEN, c.token.trim())
  persist()
}
export function setProjectsDir(p: string) { localStorage.setItem(LS_PROJECTS, p.trim()); persist() }
export function setOpenaiKeyPath(p: string) { localStorage.setItem(LS_OPENAI_PATH, p.trim()); persist() }
export function setIdleSleepSec(n: number) { localStorage.setItem(LS_IDLE_SEC, String(Math.max(0, Math.floor(n) || 0))); persist() }
export function setWakeOnChange(on: boolean) { localStorage.setItem(LS_WAKE_CHANGE, on ? '1' : '0'); persist() }
export function setSource(s: string) { localStorage.setItem(LS_SOURCE, (s || '').trim()); persist() }
export function setPins(p: Pin[]) { localStorage.setItem(LS_PINS, JSON.stringify(p)); persist() }
export function setAiSummary(on: boolean) { localStorage.setItem(LS_AI_SUMMARY, on ? '1' : '0'); persist() }

export function isConfigured(): boolean { const c = getConfig(); return !!c.base && !!c.token }

// Seed localStorage from the phone app's persistent store at boot, so a fresh install/update
// reconnects automatically without re-entering anything. Call before rendering.
export async function loadPersistedConfig(): Promise<void> {
  if (isConfigured()) return // localStorage (or personal-build env) already has it
  try {
    const b = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ])
    if (!b) return
    const raw = await b.getLocalStorage(PERSIST_KEY)
    if (raw) {
      const c = JSON.parse(raw)
      if (c && c.base && c.token) {
        localStorage.setItem(LS_URL, c.base); localStorage.setItem(LS_TOKEN, c.token)
        if (c.projectsDir) localStorage.setItem(LS_PROJECTS, c.projectsDir)
        if (c.openaiKeyPath) localStorage.setItem(LS_OPENAI_PATH, c.openaiKeyPath)
        if (c.idleSleepSec != null) localStorage.setItem(LS_IDLE_SEC, String(c.idleSleepSec))
        if (c.wakeOnChange != null) localStorage.setItem(LS_WAKE_CHANGE, c.wakeOnChange ? '1' : '0')
        if (c.source) localStorage.setItem(LS_SOURCE, c.source)
        if (Array.isArray(c.pins)) localStorage.setItem(LS_PINS, JSON.stringify(c.pins))
        if (c.aiSummary != null) localStorage.setItem(LS_AI_SUMMARY, c.aiSummary ? '1' : '0')
      }
    }
  } catch { /* no bridge / nothing stored -> Setup screen */ }
}
