import { useSyncExternalStore, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { App } from './AppGlasses'
import { Setup } from './Setup'
import { loadPersistedConfig, getConfig } from './config'
import { subscribe, getSnapshot, submitTypedInput, setTypingText, cancelInput, cancelNewSession, refresh, hostBridgeLost, hostBridgeBack } from './store'

// Capture uncaught errors so a crash is DIAGNOSABLE instead of a silent "quit": stash the last
// one in localStorage (shown in Setup) and best-effort POST it to the backend journal.
//
// A report must never be able to cause, or keep pace with, a stream of errors. On 2026-10-09 an
// error that repeated without end on a real phone was reported every time: ~9,000 POSTs a minute.
// So: at most one report per distinct message per minute, at most REPORT_CAP per launch, and
// every report carries how many errors there have been — the count shows a loop without feeding it.
const REPORT_CAP = 20
const reportedAt = new Map<string, number>()
const launchedAt = Date.now()
let errorCount = 0
let reports = 0
function reportClientError(kind: string, err: unknown, show = true) {
  errorCount++
  const now = Date.now()
  const e = err as { message?: string; stack?: string } | undefined
  const head = `${kind}: ${(e && (e.message || String(err))) || String(err)}`.slice(0, 300)
  if (reports >= REPORT_CAP || now - (reportedAt.get(head) ?? -Infinity) < 60_000) return
  reportedAt.set(head, now)
  reports++
  const msg = `${head}\n${(e && e.stack) || ''}\n[error #${errorCount}, ${Math.round((now - launchedAt) / 1000)}s after launch, build ${__APP_VERSION__} (${__BUILD__}), ${navigator.userAgent}]`.slice(0, 4000)
  if (show) try { localStorage.setItem('conductor.lastError', msg) } catch { /* quota */ }
  try {
    const { base, token } = getConfig()
    if (base && token) fetch(`${base}/api/clientlog`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {})
  } catch { /* offline */ }
}
window.addEventListener('error', (e) => reportClientError('error', e.error ?? e.message))
// One rejection is not an app error but a state: the Even app's page hooks (focus/blur, "a resource
// loaded") call the host, and once the host has let go of this page those calls fail with WebKit's
// InvalidAccessError. Tell the store (the page goes quiet), log it once for diagnosis, and do not
// show it on the phone as "Last app error".
const hostGone = (r: unknown) => {
  const e = r as { name?: string; message?: string } | undefined
  return !!e && (e.name === 'InvalidAccessError' || /does not support the operation or argument/.test(String(e.message || '')))
}
window.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason
  if (hostGone(r)) { hostBridgeLost(); reportClientError('promise', r, false) } else reportClientError('promise', r)
})
window.addEventListener('pointerdown', hostBridgeBack)  // a touch on this page means it is on screen again
// Builds before 10-12 13:21 stored that event as the "last app error"; it never was one, so drop a
// leftover instead of showing it on every launch.
try { if (/does not support the operation or argument/.test(localStorage.getItem('conductor.lastError') || '')) localStorage.removeItem('conductor.lastError') } catch { /* no storage */ }

// Phone-side TEXT input — the alternative to voice at any "listening" point (reply, new-tag
// name, new-session folder). Shows whenever the app is waiting for input, so the app is fully
// usable even without an OpenAI key (no voice). Submits the typed text where voice would go.
function PhoneInput() {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  let ctx: { label: string; ph: string; cancel: () => void; status: string } | null = null
  if (s.newPhase === 'tagvoice') ctx = { label: 'New tag name', ph: 'e.g. api', cancel: cancelNewSession, status: s.newStatus }
  else if (s.newPhase === 'listening') ctx = { label: 'Folder for the new session', ph: 'e.g. my-project', cancel: cancelNewSession, status: s.newStatus }
  else if (s.menuFreeText) ctx = { label: 'Type your answer to the question', ph: 'your answer…', cancel: cancelInput, status: s.status }
  else if (s.activePaneN && s.phase === 'listening') ctx = { label: 'Type a message for this session', ph: 'your prompt…', cancel: cancelInput, status: s.status }
  if (!ctx) return null
  // store-controlled (value = s.typingText) so every keystroke echoes live to the glasses
  const send = () => submitTypedInput()
  const wrap: CSSProperties = { position: 'fixed', left: 0, right: 0, bottom: 0, background: '#0b0f0c', borderTop: '1px solid #173a26', padding: 14, fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box' }
  const inp: CSSProperties = { width: '100%', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid #1f6e45', background: '#0f1712', color: '#e8fff1', boxSizing: 'border-box' }
  const btn: CSSProperties = { flex: 1, padding: '12px', fontSize: 15, fontWeight: 600, borderRadius: 10, border: 'none', background: '#16c46a', color: '#04130a' }
  return (
    <div style={wrap}>
      <div style={{ color: '#7fd9a6', fontSize: 13, marginBottom: 6 }}>{ctx.label}{s.voiceOn ? ' (or speak on the glasses)' : ''}</div>
      {!s.voiceOn && (
        <div style={{ color: '#88a895', fontSize: 11, marginBottom: 8, lineHeight: 1.4 }}>
          Voice off — no OpenAI key found. Checked: {(s.voiceChecked.length ? s.voiceChecked : ['OPENAI_API_KEY env var']).join(' · ')}. Add the key in one of those, or set a key-file path in Settings.
        </div>
      )}
      <textarea style={{ ...inp, minHeight: 48, resize: 'vertical' }} value={s.typingText} autoFocus
        onChange={(e) => setTypingText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        placeholder={ctx.ph} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      {ctx.status && <div style={{ color: '#ffb38a', fontSize: 12, marginTop: 4 }}>{ctx.status}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <button style={btn} onClick={send}>Send</button>
        <button style={{ ...btn, background: 'transparent', color: '#88a895', border: '1px solid #1f6e45' }} onClick={() => ctx!.cancel()}>Cancel</button>
      </div>
    </div>
  )
}

// Phone-side root: the phone is a config + type-on-phone surface (the real UI is on the
// glasses), so it ALWAYS shows the Settings screen. <App/> runs in the background driving
// the glasses (it renders null in the DOM); PhoneInput overlays when input is needed.
// (App uses even-toolkit's useGlasses, which needs a Router — hence MemoryRouter.)
// onSave just kicks an immediate fleet refresh so a config change takes effect at once.
function Root() {
  return (
    <>
      <MemoryRouter><App /></MemoryRouter>
      <Setup onSave={() => { refresh(true) }} />
      <PhoneInput />
    </>
  )
}

// Seed config from the phone app's persistent store (survives reinstall) BEFORE first render,
// so a returning user goes straight to the app instead of the Setup screen.
loadPersistedConfig().finally(() => createRoot(document.getElementById('root')!).render(<Root />))
