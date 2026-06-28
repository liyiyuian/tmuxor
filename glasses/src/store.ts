// External store + actions for the glasses control flow.
// Screens: list <-> detail. Within detail, a phase drives the sub-state:
//   view (scroll live pane, or MENU mode if the pane is asking) -> listening (mic) -> confirm (send).
import { listPanes, paneScreen, paneConversation, streamPane, sendToPane, sendKeys, translate, transcribe, resolveFolder, newSession, listWindows, health, type Pane, type Turn } from './api'
import { GlassBridgeSource } from 'even-toolkit/stt'
import { getTextWidth } from 'even-toolkit/pretext'

export type Phase = 'view' | 'listening' | 'confirm'
const SLOTS = 9
const DEBUG_VOICE = !!import.meta.env.VITE_DEBUG_VOICE

export interface MenuOption { num: number; title: string; current: boolean; checked: boolean }
export interface MenuState { question: string; options: MenuOption[]; multi: boolean; cursorIndex: number }

export interface AppState {
  panes: Pane[]
  loading: boolean
  error: string | null
  listIndex: number
  activePaneN: string | null
  activeLabel: string
  activeIsClaude: boolean
  activeCwd: string
  lines: string[]
  menu: MenuState | null
  scroll: number
  atBottom: boolean
  working: boolean
  activity: string
  voiceOn: boolean   // backend has an OpenAI key -> voice replies available
  voiceChecked: string[]  // when voice off, the locations the backend checked for a key
  phase: Phase
  draft: string
  draftKind: 'prompt' | 'command' | null
  busy: boolean
  status: string
  typingText: string  // live text being typed on the phone (echoed to the glasses)
  draftLines: string[]   // the transcript/command, pixel-wrapped full-width for REVIEW
  confirmScroll: number
  lastCost: number   // USD of the last transcription
  totalCost: number  // running USD this session
  // new-session flow (own screen)
  newPhase: 'tag' | 'tagvoice' | 'listening' | 'confirm' | 'busy' | 'done'
  newText: string
  newTags: string[]      // existing window names (project tags)
  newTagIndex: number    // highlight in the tag list (0 = "＋ New tag")
  newTag: string         // chosen/spoken tag
  newPath: string
  newCreate: boolean  // the chosen folder doesn't exist yet -> confirm to create it
  newStatus: string
  newPaneN: string | null
}

let state: AppState = {
  panes: [], loading: true, error: null, listIndex: 0,
  activePaneN: null, activeLabel: '', activeIsClaude: false, activeCwd: '',
  lines: [], menu: null, scroll: 0, atBottom: true, working: false, activity: '', voiceOn: true, voiceChecked: [],
  phase: 'view', draft: '', draftKind: null, busy: false, status: '', typingText: '', draftLines: [], confirmScroll: 0, lastCost: 0, totalCost: 0,
  newPhase: 'tag', newText: '', newTags: [], newTagIndex: 0, newTag: '', newPath: '', newCreate: false, newStatus: '', newPaneN: null,
}
const listeners = new Set<() => void>()
export function getSnapshot() { return state }
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function set(p: Partial<AppState>) { state = { ...state, ...p }; listeners.forEach((l) => l()) }

const maxScroll = (n: number) => Math.max(0, n - SLOTS)

const ORDER: Record<string, number> = { waiting: 0, working: 1, idle: 2, other: 3 }
export async function refresh() {
  try {
    const panes = await listPanes(true)
    panes.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.window - b.window || a.pane_index - b.pane_index)
    const sig = JSON.stringify(panes)
    if (sig !== lastPanesSig) { lastPanesSig = sig; set({ panes, loading: false, error: null }) }  // skip identical re-push
    else if (state.loading || state.error) set({ loading: false, error: null })
    health().then((h) => set({ voiceOn: h.voice, voiceChecked: h.checked || [] })).catch(() => {})
  } catch (e) { set({ loading: false, error: String(e) }) }
}

// --- detect an interactive option menu in the captured screen ---
function parseMenu(raw: string[]): MenuState | null {
  if (!raw.some((l) => /to navigate|to select|✔ ?submit|esc to cancel/i.test(l))) return null
  const options: MenuOption[] = []
  let multi = false
  for (const l of raw) {
    const m = l.match(/^\s*(❯|›|>|\*)?\s*(\d+)[.)]\s*(\[([ xX*])\]\s*)?(.+?)\s*$/)
    if (m && m[5] && !/^\d/.test(m[5])) {
      if (m[3]) multi = true
      options.push({ num: Number(m[2]), title: m[5].trim(), current: !!m[1], checked: /[xX*]/.test(m[4] || '') })
    }
  }
  if (options.length < 2) return null
  const q = (raw.find((l) => l.includes('?') && l.trim().length > 8) || '').trim().replace(/^[❯>›*\s]+/, '')
  return { question: q, options, multi, cursorIndex: Math.max(0, options.findIndex((o) => o.current)) }
}

// --- live pane view: strip TUI chrome ---
const DROP_RE: RegExp[] = [
  /^[\s─-╿=_·.\-]+$/, /^-{2}\s*INSERT/i, /auto[- ]?mode/i, /esc to interrupt/i,
  /\? for shortcuts/i, /\/clear to/i, /shift\+tab/i, /ctrl\+[a-z]/i, /for agents/i, /\bto save\b.*tokens/i,
]
function cleanLines(raw: string[]): string[] {
  const out: string[] = []
  for (let l of raw) {
    l = l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/^\s*[❯>›]\s?/, '').replace(/\s+$/, '')
    if (DROP_RE.some((re) => re.test(l))) continue
    if (l.trim() === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(l)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.length ? out : ['(no output)']
}

// Word-wrap to the full display width (pixel-accurate via pretext): break at spaces,
// only hard-breaking a single word wider than a row. `indent` is prepended to every
// continuation line (hanging indent) so wrapped bullets/prompts stay visually aligned.
const WRAP_PX = 568
function wrapPx(line: string, indent = ''): string[] {
  if (getTextWidth(line) <= WRAP_PX) return [line]
  const out: string[] = []
  let cur = ''
  for (const w of line.split(' ')) {
    const trial = cur === '' ? w : cur + ' ' + w
    if (getTextWidth(trial) <= WRAP_PX) { cur = trial; continue }
    if (cur !== '') out.push(cur)
    if (getTextWidth(indent + w) > WRAP_PX) {
      let r = indent + w
      while (getTextWidth(r) > WRAP_PX) {
        let lo = 1, hi = r.length, k = 1
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (getTextWidth(r.slice(0, mid)) <= WRAP_PX) { k = mid; lo = mid + 1 } else hi = mid - 1 }
        out.push(r.slice(0, k)); r = indent + r.slice(k)
      }
      cur = r
    } else { cur = indent + w }
  }
  if (cur !== '') out.push(cur)
  return out
}
function softWrap(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) { if (l === '') out.push(l); else out.push(...wrapPx(l)) }
  return out.length ? out : ['(no output)']
}

let es: EventSource | null = null
let answersTimer: ReturnType<typeof setInterval> | null = null

// shell pane: render the live terminal screen (its output IS the content)
function applyScreen(text: string) {
  const raw = text.split('\n')
  const lines = softWrap(cleanLines(raw))
  const ms = maxScroll(lines.length)
  set({ lines, menu: parseMenu(raw), scroll: state.atBottom ? ms : Math.min(state.scroll, ms) })
}

// A light dotted rule (sized to fit, never wraps) that separates Q&A turns —
// distinct from the solid box-drawing borders of a terminal so it doesn't read
// as chrome. Marked so wrapping/indent logic leaves it alone.
const DIVIDER = (() => { let s = ''; while (getTextWidth(s + '· ') <= 520) s += '· '; return s.trimEnd() })()

// continuation indent for a wrapped line: align under a bullet's/prompt's text
function hangIndent(line: string): string {
  const m = line.match(/^(\s*)(•|▶|\d+\.)\s/)
  return m ? ' '.repeat(m[1].length + 2) : ''
}

// claude pane: render the real conversation for easy scanning —
//   ·········  (divider between turns)
//   ▶ the prompt            (wrapped lines hang-indent under the text)
//   <blank>
//   the answer, paragraphs kept apart by single blanks
// convoLines are PRE-WRAPPED here so SSE can refresh the live working line
// (buildView) without re-wrapping the whole conversation.
let convoLines: string[] = []
let jumpToPrompt = false // FIRST open of a pane: land on the latest question
// per-pane scroll memory: re-opening a pane resumes where you left off (not the latest
// question). First-ever open this run has no entry -> jumpToPrompt. Reset on app reload.
const paneMem = new Map<string, { scroll: number; atBottom: boolean; promptCount: number; scrolledAway: boolean }>()
let pendingRestore: { scroll: number; atBottom: boolean; promptCount: number; scrolledAway: boolean } | null = null
let convoPromptCount = 0 // # of user questions in the current conversation (for new-question detection)
let convoEtag: string | null = null // last conversation ETag -> 304 skips re-fetch/parse
let lastLiveSig = '' // SSE activity+menu signature -> skip redundant identical BLE pushes
let lastPanesSig = '' // fleet-list signature -> skip redundant identical BLE pushes
let userScrolled = false // did the user manually scroll this view? -> reopen resumes vs jumps
function lastPromptIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('▶ ')) return i
  return 0
}
function renderTurns(turns: Turn[]): string[] {
  const logical: string[] = []
  const add = (l: string) => { if (l === '' && (logical.length === 0 || logical[logical.length - 1] === '')) return; logical.push(l) }
  turns.forEach((t, ti) => {
    if (t.role === 'user') {
      if (ti > 0) { add(''); add(DIVIDER) }          // break from the previous turn
      t.text.split('\n').forEach((l, i) => add(i === 0 ? '▶ ' + l : l))
      add('')                                         // gap before the answer
    } else {
      if (ti > 0 && turns[ti - 1].role === 'assistant') add('') // gap between separate replies
      t.text.split('\n').forEach(add)                 // paragraph blanks already present
    }
  })
  while (logical.length && logical[logical.length - 1] === '') logical.pop()
  const out: string[] = []
  for (const l of logical) {
    if (l === '' || l === DIVIDER) out.push(l)
    else out.push(...wrapPx(l, hangIndent(l)))
  }
  return out
}
function buildView() {
  const raw = [...convoLines]
  if (state.working) {
    if (raw.length) raw.push('')
    raw.push(...wrapPx(state.activity ? '⋯ ' + state.activity : '⋯ working…'))
  }
  const lines = raw.length ? raw : ['(no replies yet)']
  const ms = maxScroll(lines.length)
  set({ lines, scroll: state.atBottom ? ms : Math.min(state.scroll, ms) })
}
function applyConversation(turns: Turn[], working: boolean) {
  convoLines = renderTurns(turns)
  convoPromptCount = turns.reduce((n, t) => n + (t.role === 'user' ? 1 : 0), 0)
  if (jumpToPrompt) {
    // FIRST open this run: start at the most recent question (read question -> answer)
    jumpToPrompt = false
    set({ working, atBottom: false, scroll: lastPromptIndex(convoLines) })
  } else if (pendingRestore) {
    // re-opening: DEFAULT to the latest prompt. Only resume their saved spot if they had
    // deliberately scrolled UP into the history AND no newer question arrived since.
    const r = pendingRestore; pendingRestore = null
    const newQuestion = convoPromptCount > r.promptCount
    if (r.scrolledAway && !newQuestion) set({ working, atBottom: r.atBottom, scroll: r.scroll })
    else set({ working, atBottom: false, scroll: lastPromptIndex(convoLines) })
  } else {
    set({ working })
  }
  buildView()
}

// claude pane keeps an SSE to (a) detect an interactive menu and (b) surface the
// one-line live activity (the spinner status) while a turn is in flight.
function cleanActivity(raw: string[]): string {
  const lines = raw.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
  const s = lines.filter((l) => /esc to interrupt/i.test(l)).pop()
  if (!s) return ''
  return s.replace(/^[^\w]+/, '').split(/esc to interrupt/i)[0].replace(/[\s·,(|]+$/, '').trim()
}
function updateLive(text: string) {
  const raw = text.split('\n')
  const activity = cleanActivity(raw)
  const menu = parseMenu(raw)
  // skip if neither the activity line nor the menu changed — parseMenu mints a fresh
  // object each frame, so without this every SSE tick re-pushes an identical BLE frame.
  const menuSig = menu ? `${menu.question}|${menu.multi}|${menu.options.map((o) => o.title + o.checked + o.current).join(',')}` : ''
  const sig = activity + '||' + menuSig
  if (sig === lastLiveSig) return
  lastLiveSig = sig
  const reRender = state.working && activity !== state.activity
  set({ menu, activity })
  if (reRender) buildView()
}

function closeStream() { if (es) { es.close(); es = null } }
function stopAnswers() { if (answersTimer) { clearInterval(answersTimer); answersTimer = null } }

export function openPane(n: string, label: string, isClaude: boolean, cwd: string, listIndex: number) {
  closeStream(); stopAnswers()
  convoLines = []
  set({ activePaneN: n, activeLabel: label, activeIsClaude: isClaude, activeCwd: cwd, listIndex,
        lines: ['…'], menu: null, scroll: 0, atBottom: true, working: false, activity: '', phase: 'view', draft: '', draftKind: null, status: '', typingText: '' })
  if (isClaude) {
    const mem = paneMem.get(n)
    jumpToPrompt = !mem            // first time -> latest question
    pendingRestore = mem ?? null   // returning -> resume where they left off
    convoEtag = null; lastLiveSig = ''; userScrolled = false  // fresh pane -> force a full first fetch
    const pull = () => paneConversation(n, convoEtag).then((r) => {
      if (state.activePaneN !== n || r.notModified) return  // 304 -> nothing changed
      convoEtag = r.etag
      applyConversation(r.turns, r.working)
    }).catch(() => {})
    pull()
    answersTimer = setInterval(pull, 2500)
    es = streamPane(n, (t) => { if (state.activePaneN === n) updateLive(t) })
  } else {
    paneScreen(n, 80).then((t) => { if (state.activePaneN === n) applyScreen(t) }).catch(() => {})
    es = streamPane(n, (t) => { if (state.activePaneN === n) applyScreen(t) })
  }
}
export function closePane() {
  // remember where they left this pane (claude panes only). "scrolled away" = they manually
  // scrolled anywhere in this view; a reopen then RESUMES there. If they never scrolled (just
  // read the jumped-to latest prompt), a reopen re-anchors on the latest prompt.
  if (state.activePaneN && state.activeIsClaude) {
    paneMem.set(state.activePaneN, { scroll: state.scroll, atBottom: state.atBottom, promptCount: convoPromptCount, scrolledAway: userScrolled })
  }
  closeStream(); stopAnswers(); stopMic(); set({ activePaneN: null, phase: 'view' })
}

// Velocity-aware line scrolling. The G2 pad only emits discrete swipe flicks (and
// even-toolkit drops same-direction repeats within 350ms to filter duplicates), so
// instead of a fixed page-jump we move line-by-line and ACCELERATE: a single swipe
// nudges a couple of lines (precise/smooth); sustained same-direction swipes ramp up
// fast. Resets on a pause (>window) or a direction change.
const SCROLL_BASE = 2
const SCROLL_GAIN = 3
const SCROLL_MAX = 16
const SCROLL_WINDOW_MS = 650
let scrollTs = 0
let scrollDir: 'up' | 'down' | null = null
let scrollStep = SCROLL_BASE
export function scrollDetail(dir: 'up' | 'down') {
  userScrolled = true  // any manual scroll -> a reopen resumes here instead of jumping to latest
  const now = Date.now()
  const sustained = dir === scrollDir && now - scrollTs < SCROLL_WINDOW_MS
  scrollStep = sustained ? Math.min(SCROLL_MAX, scrollStep + SCROLL_GAIN) : SCROLL_BASE
  scrollTs = now; scrollDir = dir
  const ms = maxScroll(state.lines.length)
  const scroll = Math.max(0, Math.min(ms, state.scroll + (dir === 'up' ? -scrollStep : scrollStep)))
  set({ scroll, atBottom: scroll >= ms })
}

// --- menu mode: drive the real TUI selection with keystrokes ---
export async function pickMenuOption(targetIdx: number) {
  const m = state.menu, n = state.activePaneN
  if (!m || !n) return
  const delta = targetIdx - m.cursorIndex
  const keys: string[] = []
  for (let i = 0; i < Math.abs(delta); i++) keys.push(delta > 0 ? 'Down' : 'Up')
  keys.push(m.multi ? 'Space' : 'Enter') // multi: toggle (stay); single: select+submit
  try { await sendKeys(n, keys) } catch { /* SSE will resync */ }
}
export async function submitMenu() {
  const n = state.activePaneN
  if (!n) return
  try { await sendKeys(n, ['Enter']) } catch { /* ignore */ }
}

// --- voice: glasses mic -> WAV -> server Whisper -> prompt/command ---
let mic: GlassBridgeSource | null = null
let micUnsub: (() => void) | null = null
let pcm: Float32Array[] = []
let micRate = 16000
function stopMic() { try { micUnsub?.(); mic?.stop() } catch { /* ignore */ } micUnsub = null; mic = null }
function beginMic() {
  pcm = []
  try {
    mic = new GlassBridgeSource()
    micUnsub = mic.onAudioData((chunk, rate) => { pcm.push(chunk); micRate = rate })
    // start() is async — handle a denied/failed mic so the rejection isn't unhandled
    // (clean-console requirement) and the user gets told instead of a silent hang.
    mic.start().catch(() => { stopMic(); set({ status: 'mic unavailable — check microphone permission' }) })
  } catch { set({ status: 'mic unavailable — check microphone permission' }) }
}

export function startVoice() {
  // "listening" = waiting for input; voice records only if the backend has a key, otherwise the
  // phone shows a text box (submitTypedInput). Either way you can type on the phone.
  set({ phase: 'listening', status: '', typingText: '' })
  if (state.voiceOn) beginMic()
}
export function cancelInput() { stopMic(); pcm = []; set({ phase: 'view', status: '', draft: '', draftKind: null, typingText: '' }) }
export function redoVoice() { stopMic(); pcm = []; set({ draft: '', draftKind: null, status: '' }); startVoice() }

export async function stopVoice() {
  stopMic()
  let text = ''
  if (pcm.length) {
    const wav = pcmToWav(pcm, micRate); pcm = []
    set({ phase: 'confirm', busy: true, status: 'transcribing…' })
    try {
      const res = await transcribe(wav)
      text = res.text
      set({ lastCost: res.cost || 0, totalCost: state.totalCost + (res.cost || 0) })
    } catch { set({ phase: 'listening', status: 'transcribe failed — tap to retry' }); beginMic(); return }
  } else if (DEBUG_VOICE) {
    text = state.activeIsClaude ? 'summarize what you just did' : 'list files sorted by size'
  }
  if (!text) { set({ phase: 'listening', status: "didn't catch that — speak, then tap" }); beginMic(); return }
  await handleTranscript(text)
}

// Build the REVIEW body: pixel-wrapped full-width transcript/command + a cost footer.
function setConfirmLines() {
  const prefix = state.draftKind === 'command' ? '$ ' : ''
  const body = softWrap((prefix + state.draft).split('\n'))
  if (state.lastCost) { body.push(''); body.push(`voice cost $${state.lastCost.toFixed(4)} · total $${state.totalCost.toFixed(4)}`) }
  set({ draftLines: body, confirmScroll: 0 })
}
export function scrollConfirm(dir: 'up' | 'down') {
  const ms = maxScroll(state.draftLines.length)
  const step = 3
  set({ confirmScroll: Math.max(0, Math.min(ms, state.confirmScroll + (dir === 'up' ? -step : step))) })
}

async function handleTranscript(t: string) {
  if (state.activeIsClaude) {
    set({ draft: t, draftKind: 'prompt', phase: 'confirm', busy: false, status: '' })
    setConfirmLines()
  } else {
    set({ phase: 'confirm', draftKind: 'command', draft: '', busy: true, status: 'translating…' })
    try { set({ draft: await translate(t, state.activeCwd), busy: false, status: '' }); setConfirmLines() }
    // don't strand a raw-English "command" on the SEND screen — go back to retry
    catch { set({ phase: 'listening', draft: '', draftKind: null, busy: false, status: 'translate failed — tap to retry' }); beginMic() }
  }
}

// One clear send: type the prompt/command into the pane, submit, then snap to the live
// view at the bottom so you watch it work.
export async function sendNow() {
  const n = state.activePaneN
  if (!n || !state.draft) return
  set({ busy: true, status: 'sending…' })
  try {
    await sendToPane(n, state.draft, true)
    set({ phase: 'view', atBottom: true, working: true, busy: false, status: '', draft: '', draftKind: null })
    buildView()
  } catch { set({ busy: false, status: 'send failed — tap to retry' }) }
}

// --- new session: pick a tag (window) -> speak a folder -> confirm -> spawn ---
export async function startNewSession() {
  set({ newPhase: 'tag', newText: '', newTags: [], newTagIndex: 0, newTag: '', newPath: '', newCreate: false, newStatus: 'loading…', newPaneN: null })
  try { set({ newTags: (await listWindows()).map((w) => w.name).filter((n) => n.trim()), newStatus: '' }) }
  catch { set({ newStatus: 'tags failed — tap ＋ to add a new one' }) }
}
// tag list rows: index 0 = "＋ New tag", then existing tags (1..newTags.length)
export function moveNewTag(dir: 'up' | 'down') {
  const max = state.newTags.length
  set({ newTagIndex: dir === 'up' ? Math.max(0, state.newTagIndex - 1) : Math.min(max, state.newTagIndex + 1) })
}
export function chooseNewTag() {
  // speak the tag/folder if voice is on; otherwise type it on the phone (submitTypedInput)
  if (state.newTagIndex === 0) { set({ newPhase: 'tagvoice', newStatus: '', typingText: '' }); if (state.voiceOn) beginMic() }
  else { set({ newTag: state.newTags[state.newTagIndex - 1], newPhase: 'listening', newStatus: '', typingText: '' }); if (state.voiceOn) beginMic() }
}

// Phone-typed input — the alternative to voice at any "listening" point. Sends the typed text
// exactly where transcribed text would go (reply / new-tag name / new-session folder).

// Live phone typing — echoed to the glasses immediately. Typing ABANDONS any in-flight voice
// recording (typed text wins). Available at every input point, even when voice is on.
export function setTypingText(t: string) {
  if (t && mic) { stopMic(); pcm = [] }  // started typing -> drop the voice recording
  set({ typingText: t })
}

export async function submitTypedInput() {
  const t = state.typingText.trim()
  set({ typingText: '' })
  if (!t) return
  stopMic(); pcm = []
  if (state.newPhase === 'tagvoice') {
    set({ newTag: t.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || t, newPhase: 'listening', newStatus: '' })
    if (state.voiceOn) beginMic()
  } else if (state.newPhase === 'listening') {
    set({ newText: t, newStatus: 'finding folder…' })
    try {
      const r = await resolveFolder(t)
      if (r.found) set({ newPhase: 'confirm', newPath: r.path, newCreate: false, newStatus: '' })
      else set({ newPhase: 'confirm', newPath: r.create_path, newCreate: true, newStatus: '' })  // offer to create it
    } catch { set({ newStatus: 'lookup failed — type again' }) }
  } else if (state.activePaneN && state.phase === 'listening') {
    if (state.activeIsClaude) {
      const n = state.activePaneN
      set({ busy: true, status: 'sending…' })
      try { await sendToPane(n, t, true); set({ phase: 'view', atBottom: true, working: true, busy: false, status: '', draft: '', draftKind: null }); buildView() }
      catch { set({ busy: false, status: 'send failed — try again' }) }
    } else {
      await handleTranscript(t)  // shell pane: translate -> confirm review
    }
  }
}

// shared mic capture for the tag/folder voice steps; returns text or null (status set)
async function captureNewVoice(retryPhase: 'tagvoice' | 'listening', debug: string): Promise<string | null> {
  let text = ''
  if (pcm.length) {
    const wav = pcmToWav(pcm, micRate); pcm = []
    set({ newStatus: 'transcribing…' })
    try {
      const res = await transcribe(wav)
      text = res.text
      set({ lastCost: res.cost || 0, totalCost: state.totalCost + (res.cost || 0) })
    } catch { set({ newPhase: retryPhase, newStatus: "didn't catch that — tap to retry" }); return null }
  } else if (DEBUG_VOICE) { text = debug }
  if (!text) { set({ newPhase: retryPhase, newStatus: 'no speech — tap to retry' }); return null }
  return text
}

export function retryNewVoice() {
  const phase = state.newPhase === 'tagvoice' ? 'tagvoice' : 'listening'
  set({ newPhase: phase, newStatus: '' }); beginMic()
}
export async function stopNewTagVoice() {
  stopMic()
  const t = await captureNewVoice('tagvoice', 'testtag')
  if (t == null) return
  set({ newTag: t.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || t, newPhase: 'listening', newStatus: '' })
  beginMic()
}
export async function stopNewVoice() {
  stopMic()
  const t = await captureNewVoice('listening', 'demo-project')
  if (t == null) return
  set({ newText: t, newStatus: 'finding folder…' })
  try {
    const r = await resolveFolder(t)
    if (r.found) set({ newPhase: 'confirm', newPath: r.path, newCreate: false, newStatus: '' })
    else set({ newPhase: 'confirm', newPath: r.create_path, newCreate: true, newStatus: '' })  // offer to create it
  } catch { set({ newPhase: 'listening', newStatus: 'lookup failed — tap to retry' }) }
}
export async function createNewSession() {
  if (!state.newPath) return
  set({ newPhase: 'busy', newStatus: 'creating…' })
  try {
    const r = await newSession(state.newPath, state.newTag || undefined)
    if (r.ok && r.n) { await refresh(); set({ newPhase: 'done', newPaneN: r.n, newStatus: r.how || 'created' }) }
    else set({ newPhase: 'confirm', newStatus: r.error || 'create failed' })
  } catch { set({ newPhase: 'confirm', newStatus: 'create failed' }) }
}
export function cancelNewSession() { stopMic(); pcm = []; set({ newPhase: 'tag', newText: '', newTags: [], newTagIndex: 0, newTag: '', newPath: '', newCreate: false, newStatus: '', newPaneN: null, typingText: '' }) }

function pcmToWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const flat = new Float32Array(total)
  let off = 0
  for (const c of chunks) { flat.set(c, off); off += c.length }
  const buf = new ArrayBuffer(44 + total * 2)
  const dv = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + total * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, total * 2, true)
  for (let i = 0; i < total; i++) {
    const s = Math.max(-1, Math.min(1, flat[i]))
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}
