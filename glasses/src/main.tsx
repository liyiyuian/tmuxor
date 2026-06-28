import { useSyncExternalStore, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { App } from './AppGlasses'
import { Setup } from './Setup'
import { loadPersistedConfig } from './config'
import { subscribe, getSnapshot, submitTypedInput, setTypingText, cancelInput, cancelNewSession, refresh } from './store'

// Phone-side TEXT input — the alternative to voice at any "listening" point (reply, new-tag
// name, new-session folder). Shows whenever the app is waiting for input, so the app is fully
// usable even without an OpenAI key (no voice). Submits the typed text where voice would go.
function PhoneInput() {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  let ctx: { label: string; ph: string; cancel: () => void; status: string } | null = null
  if (s.newPhase === 'tagvoice') ctx = { label: 'New tag name', ph: 'e.g. api', cancel: cancelNewSession, status: s.newStatus }
  else if (s.newPhase === 'listening') ctx = { label: 'Folder for the new session', ph: 'e.g. my-project', cancel: cancelNewSession, status: s.newStatus }
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
      <Setup onSave={() => { refresh() }} />
      <PhoneInput />
    </>
  )
}

// Seed config from the phone app's persistent store (survives reinstall) BEFORE first render,
// so a returning user goes straight to the app instead of the Setup screen.
loadPersistedConfig().finally(() => createRoot(document.getElementById('root')!).render(<Root />))
