// Per-user connection config. Stored in the WebView's localStorage (fast, sync) AND mirrored
// to the Even app's persistent storage via the SDK, so it survives app reinstalls/updates —
// the user enters it once and never again (unless they clear it). Nothing is baked into the
// shipped app. The build-time env fallback is used ONLY for a personal build (VITE_PERSONAL=1).
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

const LS_URL = 'conductor.baseUrl'
const LS_TOKEN = 'conductor.token'
const LS_PROJECTS = 'conductor.projectsDir'      // where new sessions' folders are created
const LS_OPENAI_PATH = 'conductor.openaiKeyPath' // optional PATH to the OpenAI key FILE (never the key itself)
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

function persist() {
  const c = getConfig()
  waitForEvenAppBridge()
    .then((b) => b.setLocalStorage(PERSIST_KEY, JSON.stringify({ base: c.base, token: c.token, projectsDir: getProjectsDir(), openaiKeyPath: getOpenaiKeyPath() })))
    .catch(() => {})
}

export function setConfig(c: Config) {
  localStorage.setItem(LS_URL, c.base.trim().replace(/\/+$/, ''))
  localStorage.setItem(LS_TOKEN, c.token.trim())
  persist()
}
export function setProjectsDir(p: string) { localStorage.setItem(LS_PROJECTS, p.trim()); persist() }
export function setOpenaiKeyPath(p: string) { localStorage.setItem(LS_OPENAI_PATH, p.trim()); persist() }

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
      }
    }
  } catch { /* no bridge / nothing stored -> Setup screen */ }
}
