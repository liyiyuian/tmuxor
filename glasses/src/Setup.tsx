import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getConfig, setConfig, getProjectsDir, setProjectsDir, getOpenaiKeyPath, setOpenaiKeyPath, getIdleSleepSec, setIdleSleepSec, getWakeOnChange, setWakeOnChange, getAiSummary, setAiSummary, getSeenNews, setSeenNews, getSummaryModel, setSummaryModel, getVoiceModel, setVoiceModel, getPreview, setPreview, getHiddenTags, setHiddenTags, getCondense, setCondense, getUsageLine, setUsageLine } from './config'
import { listPanes, getUsage, type Usage, type UsageRow, type ModelChoice } from './api'
import { subscribe, getSnapshot, togglePin, previewSettingChanged, workspaceFilterChanged, condenseSettingChanged, modelSettingChanged, loadLimits } from './store'

// Decode the `tmuxor:<base64>` blob that install.sh prints into a config.
function decodeBlob(text: string): { base: string; token: string } | null {
  try {
    const raw = text.trim().replace(/^tmuxor:/, '').replace(/-/g, '+').replace(/_/g, '/')
    const o = JSON.parse(atob(raw))
    const base = (o.base || '').trim(); const token = (o.token || '').trim()
    if (!/^https:\/\/.+/i.test(base) || !token) return null
    return { base, token }
  } catch { return null }
}

const STATUS: Record<string, string> = { waiting: 'needs you', working: 'working', idle: 'idle' }

const C = { bg: '#0b0f0c', card: '#0f1712', line: '#173a26', edge: '#1f6e45', accent: '#16c46a', text: '#d6ffe6', soft: '#b9d8c6', mute: '#7f9a8b' }
const card: CSSProperties = { border: `1px solid ${C.edge}`, borderRadius: 12, background: C.card, overflow: 'hidden' }
const rowBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', border: 'none', borderBottom: `1px solid ${C.line}`, background: 'transparent', color: C.text, textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer' }
const pill = (on: boolean): CSSProperties => ({ flex: 'none', minWidth: 44, padding: '5px 10px', borderRadius: 999, fontSize: 13, fontWeight: 700, textAlign: 'center', background: on ? C.accent : 'transparent', color: on ? '#04130a' : C.mute, border: `1px solid ${on ? C.accent : '#2c4a3a'}` })
const chip = (on: boolean): CSSProperties => ({ padding: '7px 12px', borderRadius: 999, fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', background: on ? '#123524' : 'transparent', color: on ? C.text : '#5f7a6b', border: `1px solid ${on ? C.accent : '#243a2e'}`, textDecoration: on ? 'none' : 'line-through' })

// A setting is one button: tap the row to switch it; the pill on the right says where it stands.
function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} style={rowBtn} onClick={() => onChange(!on)}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2, lineHeight: 1.35 }}>{hint}</span>
      </span>
      <span style={pill(on)}>{on ? 'On' : 'Off'}</span>
    </button>
  )
}
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h3 style={{ margin: 0, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: '#7fd9a6' }}>{title}</h3>
      {hint && <p style={{ margin: '4px 0 0', fontSize: 12, color: C.mute }}>{hint}</p>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  )
}
// money as it reads best at these sizes: cents and up as $1.23, anything smaller with four decimals
const money = (usd: number) => usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.0001 ? `$${usd.toFixed(4)}` : usd > 0 ? '<$0.0001' : '$0'
function CostTable({ title, rows }: { title: string; rows: UsageRow[] }) {
  const total = rows.reduce((n, r) => n + r.usd, 0)
  return (
    <div data-testid="cost-table" style={{ padding: '10px 14px', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600 }}><span>{title}</span><span>{money(total)}</span></div>
      {rows.length === 0 && <div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>No paid calls.</div>}
      {rows.map((r) => (
        <div key={r.provider + r.model} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, color: C.soft, marginTop: 6 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.provider} · {r.model} <span style={{ color: C.mute }}>· {r.calls} call{r.calls === 1 ? '' : 's'}</span></span>
          <span style={{ flex: 'none' }}>{r.unpriced === r.calls ? 'price unknown' : money(r.usd)}</span>
        </div>
      ))}
    </div>
  )
}
// one short "what changed" note, shown once: a new gesture is useless if nobody knows it exists
const NEWS_ID = 'menu-2'
const SESSIONS_SHOWN = 6  // pinned sessions sort first, so they are always among these
// screen-sleep choices; a value set by an older build that is not one of these is shown as its own choice
const SLEEP: [number, string][] = [[0, 'Never'], [30, '30 s'], [60, '1 min'], [300, '5 min']]

// Phone-side screen: your sessions (pin them here), a gesture cheat-sheet, and the settings form.
// Each user points the app at THEIR OWN backend with THEIR OWN token — nothing is shipped in the
// app. Fastest path: paste the config code install.sh prints (copy it from your terminal, or scan
// its QR with your phone's camera to copy the text).
export function Setup({ onSave }: { onSave: () => void }) {
  const c = getConfig()
  const [base, setBase] = useState(c.base)
  const [token, setToken] = useState(c.token)
  const [blob, setBlob] = useState('')
  const [projects, setProjects] = useState(getProjectsDir())
  const [keyPath, setKeyPath] = useState(getOpenaiKeyPath())
  const [idleSec, setIdleSec] = useState(String(getIdleSleepSec()))
  const [wakeChange, setWakeChange] = useState(getWakeOnChange())
  const [aiSummary, setAi] = useState(getAiSummary())
  const [showCfg, setShowCfg] = useState(!c.base)  // the connection form is open until you're set up
  const [preview, setPv] = useState(getPreview())
  const [hiddenTags, setHidden] = useState(getHiddenTags())
  const [condense, setCond] = useState(getCondense())
  const [usage, setUsage] = useState<Usage | null>(null)
  const [usageLine, setUl] = useState(getUsageLine())
  const [sumModel, setSumModel] = useState(getSummaryModel())
  const [voiceModel, setVoiceM] = useState(getVoiceModel())
  const [news, setNews] = useState(() => getSeenNews() !== NEWS_ID)
  const [allSessions, setAllSessions] = useState(false)  // the session list shows its first few until asked for the rest
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastErr, setLastErr] = useState(() => { try { return localStorage.getItem('conductor.lastError') || '' } catch { return '' } })

  // Live connection status — the phone's only status indicator now that the bottom bar is gone.
  // <App/> polls the fleet in the background, so the store reflects whether the backend is
  // actually reachable right now (not just at the moment you last hit Save).
  const live = useSyncExternalStore(subscribe, getSnapshot)
  const configured = !!getConfig().base
  const status = !configured
    ? '○ Not set up yet — paste your setup code below'
    : live.error ? '○ Can’t reach your backend — check the URL & token'
    : `● Connected · ${live.panes.length} session${live.panes.length === 1 ? '' : 's'}`
  const statusColor = configured && !live.error ? '#16c46a' : '#ffb38a'

  // a setting flipped from the glasses menu: show its new value here too
  useEffect(() => {
    setPv(getPreview()); setAi(getAiSummary()); setUl(getUsageLine()); setWakeChange(getWakeOnChange()); setIdleSec(String(getIdleSleepSec()))
  }, [live.settingsRev])

  // API cost: asked for when the page opens and on "Refresh" — never polled.
  const loadUsage = () => { if (getConfig().base && getConfig().token) getUsage().then(setUsage).catch(() => setUsage(null)) }
  useEffect(loadUsage, [configured])

  // Test the connection before declaring success, so a wrong URL/token/down backend fails
  // HERE (on the phone) instead of dropping the user into an "offline" glasses screen.
  const connect = async (b: string, t: string) => {
    setErr(''); setBusy(true)
    setConfig({ base: b, token: t })
    setProjectsDir(projects)
    setOpenaiKeyPath(keyPath)
    setIdleSleepSec(Number(idleSec) || 0)
    setWakeOnChange(wakeChange)
    setAiSummary(aiSummary)
    try {
      await listPanes()
      setShowCfg(false)  // connected -> fold the connection form; the everyday settings stay in view
      onSave()
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      setErr(/\b401\b/.test(msg) ? 'Token rejected — check your CONDUCTOR_TOKEN.'
        : "Can't reach the backend — check the URL, and that the service + `tailscale serve` are running.")
    } finally { setBusy(false) }
  }

  const applyBlob = () => { const cfg = decodeBlob(blob); cfg ? connect(cfg.base, cfg.token) : setErr('That setup code is not valid — copy the whole line from install.sh.') }
  const save = () => {
    const b = base.trim()
    if (!/^https:\/\/.+/i.test(b)) { setErr('Backend URL must start with https://'); return }
    if (!token.trim()) { setErr('An access token is required (set CONDUCTOR_TOKEN on your backend).'); return }
    connect(b, token.trim())
  }

  const wrap: CSSProperties = { background: C.bg, color: C.text, minHeight: '100vh', padding: 20, fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box' }
  const label: CSSProperties = { display: 'block', fontSize: 13, color: '#7fd9a6', margin: '14px 0 6px' }
  const input: CSSProperties = { width: '100%', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: `1px solid ${C.edge}`, background: C.card, color: '#e8fff1', boxSizing: 'border-box' }
  const btn: CSSProperties = { marginTop: 12, width: '100%', padding: '14px', fontSize: 16, fontWeight: 600, borderRadius: 10, border: 'none', background: C.accent, color: '#04130a', opacity: busy ? 0.6 : 1 }
  const fold: CSSProperties = { fontSize: 15, fontWeight: 600, color: C.text, padding: '12px 0', cursor: 'pointer' }
  const sleepNow = Number(idleSec) || 0
  const sleepOpts: [number, string][] = SLEEP.some(([v]) => v === sleepNow) ? SLEEP : [...SLEEP, [sleepNow, `${sleepNow} s`]]

  const CONNECTION = (
    // set once: open until the first successful connection, folded afterwards
    <details open={showCfg} onToggle={(e) => setShowCfg(e.currentTarget.open)} style={{ marginTop: 18 }}>
      <summary style={fold}>Connection</summary>
      <label style={{ ...label, marginTop: 0 }} htmlFor="cfg-blob">Setup code — run <code>install.sh</code> on your computer and paste what it prints</label>
      <textarea id="cfg-blob" style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
        value={blob} onChange={(e) => { setBlob(e.target.value); setErr('') }} placeholder="tmuxor:…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button style={btn} onClick={applyBlob} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>

      <details style={{ marginTop: 14 }}>
        <summary style={{ ...fold, fontSize: 13, fontWeight: 500, color: C.soft, padding: '6px 0' }}>Enter it by hand</summary>
        <label style={label} htmlFor="cfg-url">Backend URL</label>
        <input id="cfg-url" type="url" inputMode="url" style={input} value={base} onChange={(e) => { setBase(e.target.value); setErr('') }} placeholder="https://… (your Tailscale address)" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <label style={label} htmlFor="cfg-token">Token</label>
        <input id="cfg-token" type="password" style={input} value={token} onChange={(e) => { setToken(e.target.value); setErr('') }} placeholder="your CONDUCTOR_TOKEN" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <label style={label} htmlFor="cfg-projects">Projects folder (optional)</label>
        <input id="cfg-projects" style={input} value={projects} onChange={(e) => { setProjects(e.target.value); setErr('') }} placeholder="~/projects — where new sessions go" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <label style={label} htmlFor="cfg-keypath">OpenAI key file (optional)</label>
        <input id="cfg-keypath" style={input} value={keyPath} onChange={(e) => { setKeyPath(e.target.value); setErr('') }} placeholder="only if voice can't find your key" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button style={btn} onClick={save} disabled={busy}>{busy ? 'Connecting…' : 'Save & connect'}</button>
      </details>
      {err && <p style={{ color: '#ff8a8a', fontSize: 13 }}>{err}</p>}
    </details>
  )

  return (
    <div style={wrap}>
      <h2 style={{ margin: 0, fontSize: 20 }}>G2C</h2>
      <p style={{ color: statusColor, fontSize: 13, margin: '8px 0 0', fontWeight: 600 }}>{status}</p>

      {lastErr && (
        <div style={{ background: '#241010', border: '1px solid #6e2a2a', borderRadius: 8, padding: '8px 10px', margin: '10px 0 0' }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: '#ff9b9b' }}>⚠ Last app error — please copy this to your developer</div>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0', fontFamily: 'monospace', fontSize: 10, color: '#ffc9c9', maxHeight: 140, overflow: 'auto' }}>{lastErr}</pre>
          <button type="button" style={{ marginTop: 6, padding: '6px 10px', fontSize: 12, borderRadius: 8, border: '1px solid #6e2a2a', background: 'transparent', color: '#ff9b9b' }}
            onClick={() => { try { localStorage.removeItem('conductor.lastError') } catch { /* */ } setLastErr('') }}>Dismiss</button>
        </div>
      )}

      {configured && news && (
        <div data-testid="news" style={{ ...card, padding: '12px 14px', marginTop: 14, borderColor: C.accent }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>New in the glasses menu</div>
          <div style={{ fontSize: 13, color: C.soft, marginTop: 4, lineHeight: 1.45 }}>
            Tap, then hold opens the menu. It now has <b>Next that needs you</b> (in the session list), <b>Condensed / full reply</b> (in
            a session, when Condensed replies is on) and <b>Pin / unpin session</b>, plus quick switches for the preview, AI summary, plan
            usage, wake on finish and screen sleep. Tap, double-tap and swipe work as before.
          </div>
          <button type="button" style={{ ...pill(true), marginTop: 10, cursor: 'pointer', fontFamily: 'inherit' }}
            onClick={() => { setSeenNews(NEWS_ID); setNews(false) }}>Got it</button>
        </div>
      )}

      {!configured && CONNECTION}

      {/* everyday settings, most used first. Every control is a button and applies at once. */}
      {live.tags.length > 1 && (
        <Section title="Workspaces" hint="Tap one to hide it from the glasses, tap again to bring it back.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {live.tags.map((t) => {
              const shown = !hiddenTags.includes(t.tag)
              return (
                <button key={t.tag} type="button" data-testid="ws-chip" aria-pressed={shown} aria-label={`${t.tag}, ${t.n} session${t.n === 1 ? '' : 's'}, ${shown ? 'shown' : 'hidden'}`} style={chip(shown)}
                  onClick={() => { const next = shown ? [...hiddenTags, t.tag] : hiddenTags.filter((x) => x !== t.tag); setHidden(next); setHiddenTags(next); workspaceFilterChanged() }}>
                  {t.tag} <span style={{ color: C.mute, fontSize: 12 }}>{t.n}</span>
                </button>
              )
            })}
          </div>
        </Section>
      )}

      {configured && !live.error && live.panes.length > 0 && (
        <Section title="Sessions" hint="Tap a session to pin it to the top of your glasses.">
          {/* never a scrolling box inside the scrolling page: on a phone a swipe that starts on it moves
              the box, not the page, and the settings below become unreachable. Show a few, expand in place. */}
          <div data-testid="sessions" style={card}>
            {(allSessions ? live.panes : live.panes.slice(0, SESSIONS_SHOWN)).map((p) => (
              <button key={p.n} type="button" data-testid="session-row" aria-pressed={!!p.pinned} aria-label={`${p.pinned ? 'Unpin' : 'Pin'} ${p.tag} ${p.label}`}
                style={{ ...rowBtn, padding: '10px 14px', background: p.pinned ? '#123524' : 'transparent', fontWeight: p.pinned ? 700 : 400 }} onClick={() => togglePin(p.n)}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>
                  <b>{p.tag}</b> {p.label} <span style={{ color: C.mute, fontWeight: 400 }}>· {p.done ? 'done' : STATUS[p.status] || p.status}</span>
                </span>
                <span style={{ flex: 'none', fontSize: 20, lineHeight: 1, color: p.pinned ? C.accent : '#4a6557' }}>{p.pinned ? '★' : '☆'}</span>
              </button>
            ))}
            {live.panes.length > SESSIONS_SHOWN && (
              <button type="button" data-testid="sessions-more" style={{ ...rowBtn, justifyContent: 'center', borderBottom: 'none', color: '#7fd9a6', fontSize: 14 }} onClick={() => setAllSessions(!allSessions)}>
                {allSessions ? 'Show fewer' : `Show all ${live.panes.length}`}
              </button>
            )}
          </div>
        </Section>
      )}

      <Section title="On the glasses">
        <div style={card}>
          <Toggle label="Preview" hint="Show the highlighted session's latest reply beside the list." on={preview}
            onChange={(v) => { setPv(v); setPreview(v); previewSettingChanged() }} />
          {live.canSummarize && preview && (
            <Toggle label="AI summary" hint="A short summary, sized to fit the preview, instead of the raw reply. Sends that request and reply to Anthropic with your own key." on={aiSummary}
              onChange={(v) => { setAi(v); setAiSummary(v) }} />
          )}
          {live.canCondense && (
            <Toggle label="Condensed replies" hint="Open a session to its latest reply cut to one screen; the glasses menu switches to the full reply. Sends that request and reply to Anthropic with your own key." on={condense}
              onChange={(v) => { setCond(v); setCondense(v); condenseSettingChanged() }} />
          )}
          <Toggle label="Plan usage" on={usageLine}
            hint={live.limits.length
              ? live.limits.map((l) => `${l.label} ${[l.session, l.week].map((v) => v == null ? '–' : (100 - v) + '%').join(' / ')}`).join(' · ') + ' left (5-hour / week)'
              : 'Small level bars in the top row: how much of your Claude and Codex plans is left.'}
            onChange={(v) => { setUl(v); setUsageLine(v); loadLimits(true) }} />
          <Toggle label="Wake on finish" hint="Light up when a session finishes or needs you." on={wakeChange}
            onChange={(v) => { setWakeChange(v); setWakeOnChange(v) }} />
          <div style={{ ...rowBtn, cursor: 'default', borderBottom: 'none', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 120 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>Screen sleep</span>
              <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>Blank the glasses after this long without a gesture.</span>
            </span>
            <span role="group" aria-label="Screen sleep" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {sleepOpts.map(([v, name]) => (
                <button key={v} type="button" data-testid="sleep-opt" aria-pressed={sleepNow === v} style={{ ...pill(sleepNow === v), cursor: 'pointer', fontFamily: 'inherit' }}
                  onClick={() => { setIdleSec(String(v)); setIdleSleepSec(v) }}>{name}</button>
              ))}
            </span>
          </div>
        </div>
      </Section>

      {/* which model does the paid work — offered by the backend, cheapest first; '' = its default */}
      {live.models && (live.canSummarize || live.voiceOn) && (
        <Section title="Models" hint="Which model your backend uses, at list prices. The first of each is the cheapest.">
          <div style={card}>
            {([
              live.canSummarize && ['AI summary and condensed replies', 'Anthropic, per million tokens in / out', live.models.summary, sumModel || live.models.summary_default,
                (id: string) => { setSumModel(id); setSummaryModel(id); modelSettingChanged() }, (m: ModelChoice) => m.in == null ? '' : `$${m.in} / $${m.out}`],
              live.voiceOn && ['Voice', 'OpenAI speech to text, per minute', live.models.voice, voiceModel || live.models.voice_default,
                (id: string) => { setVoiceM(id); setVoiceModel(id) }, (m: ModelChoice) => m.per_min == null ? '' : `$${m.per_min}`],
            ] as (false | [string, string, ModelChoice[], string, (id: string) => void, (m: ModelChoice) => string])[]).map((g) => g && (
              <div key={g[0]} style={{ ...rowBtn, cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <span>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{g[0]}</span>
                  <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>{g[1]}</span>
                </span>
                <span role="group" aria-label={g[0]} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {g[2].map((m) => (
                    <button key={m.id} type="button" data-testid="model-opt" aria-pressed={g[3] === m.id} style={{ ...pill(g[3] === m.id), cursor: 'pointer', fontFamily: 'inherit' }}
                      onClick={() => g[4](m.id)}>{m.label}{g[5](m) && <span style={{ fontWeight: 400, opacity: 0.8 }}> · {g[5](m)}</span>}</button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {usage && (
        <Section title="API cost" hint="What your backend's own API calls cost, at list prices. Not your Claude or Codex subscription.">
          <div style={card}>
            <CostTable title="Today" rows={usage.today} />
            <CostTable title="Last 7 days" rows={usage.week} />
            {usage.all && <CostTable title={`All time${usage.start ? ` · since ${new Date(usage.start * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`} rows={usage.all} />}
            <button type="button" style={{ ...rowBtn, justifyContent: 'center', borderBottom: 'none', color: '#7fd9a6', fontSize: 13 }} onClick={loadUsage}>
              {!usage.all && usage.since ? `Counting since ${new Date(usage.since * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ` : ''}Refresh
            </button>
          </div>
        </Section>
      )}

      {configured && CONNECTION}

      <details>
        <summary style={fold}>How to use the glasses</summary>
        <ul style={{ margin: 0, paddingLeft: 18, color: C.soft, fontSize: 13, lineHeight: 1.6 }}>
          <li><b>List</b> — swipe to move, tap to open, double-tap to exit.</li>
          <li><b>In a session</b> — swipe to scroll, tap to reply (speak, or type here), double-tap to go back.</li>
          <li><b>When it asks you something</b> — read it, tap, swipe to your answer, tap to choose.</li>
          <li><b>The glasses menu</b> (tap, then hold) — <i>Next that needs you</i> jumps down the list to the next session waiting on you, then back to the top. <i>Condensed / full reply</i> switches an open session's reply (with Condensed replies on). <i>Pin / unpin session</i> keeps a session on top. The rest are quick switches for settings on this page (preview, AI summary, plan usage, wake on finish, screen sleep never / 30 s); the top row says what changed.</li>
          <li><b>Marks</b> — ○ idle · » working · ● finished · ! needs you (Codex: ◇ ◆). CAPITALS = pinned. ＊ = written by AI.</li>
          <li><b>Pin from the glasses</b> — highlight a session, tap then press and hold, choose “Pin / unpin session”.</li>
        </ul>
      </details>

      {/* which build this is — the version number is held between submissions, so it can't say */}
      <p style={{ color: '#6f8a7b', fontSize: 11, margin: '18px 0 0', textAlign: 'center' }}>G2C {__APP_VERSION__} · build {__BUILD__}</p>
    </div>
  )
}
