// External store + actions for the glasses control flow.
// Screens: list <-> detail. Within detail, a phase drives the sub-state:
//   view (scroll live pane, or MENU mode if the pane is asking) -> listening (mic) -> confirm (send).
import { listPanes, paneScreen, paneConversation, streamPane, sendToPane, sendKeys, translate, transcribe, resolveFolder, newSession, listWindows, health, type Pane, type Turn } from './api'
import { GlassBridgeSource } from 'even-toolkit/stt'
import { getTextWidth, truncateGlassText } from 'even-toolkit/pretext'
import { getIdleSleepSec, getWakeOnChange, isConfigured, getPins, setPins } from './config'

export type Phase = 'view' | 'listening' | 'confirm'
const SLOTS = 9
const DEBUG_VOICE = !!import.meta.env.VITE_DEBUG_VOICE

export interface MenuOption { num: number; title: string; current: boolean; checked: boolean; free: boolean; desc?: string }
// `ask` = an AskUserQuestion prompt (multi-tab: several questions + a Submit tab). Those need
// per-question picking, manual tab-advance (→) and an explicit Submit, unlike a plain Yes/No prompt.
// `tabCount` = number of tabs in the strip (questions + Submit) — used to jump to the Submit tab.
export interface MenuState { question: string; options: MenuOption[]; multi: boolean; cursorIndex: number; ask: boolean; tabCount: number }

export interface AppState {
  panes: Pane[]
  loading: boolean
  error: string | null
  listSel: string   // highlighted list row, by pane id (see listRow); '' = none yet -> the top row at launch
  listPos: number   // the row it was last on — where the highlight stays if that session disappears
  preview: string[] // the highlighted session's latest exchange, shown beside the list (pre-wrapped)
  activePaneN: string | null
  activeLabel: string
  activeIsClaude: boolean
  activeCwd: string
  lines: string[]
  menu: MenuState | null
  menuPhase: 'read' | 'pick'  // permission prompt: READ the command first, then PICK the option
  menuBody: string[]          // the command/diff/context being approved (pre-wrapped), for READ
  menuScroll: number          // scroll position within menuBody
  menuFreeText: boolean       // typing a free-text answer ("Type something") INTO the open menu field
  scroll: number
  atBottom: boolean
  working: boolean
  activity: string
  voiceOn: boolean   // backend has an OpenAI key -> voice replies available
  voiceChecked: string[]  // when voice off, the locations the backend checked for a key
  asleep: boolean    // glasses HUD blanked after inactivity (idle screen-sleep)
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
  panes: [], loading: true, error: null, listSel: '', listPos: 0, preview: [],
  activePaneN: null, activeLabel: '', activeIsClaude: false, activeCwd: '',
  lines: [], menu: null, menuPhase: 'read', menuBody: [], menuScroll: 0, menuFreeText: false, scroll: 0, atBottom: true, working: false, activity: '', voiceOn: true, voiceChecked: [], asleep: false,
  phase: 'view', draft: '', draftKind: null, busy: false, status: '', typingText: '', draftLines: [], confirmScroll: 0, lastCost: 0, totalCost: 0,
  newPhase: 'tag', newText: '', newTags: [], newTagIndex: 0, newTag: '', newPath: '', newCreate: false, newStatus: '', newPaneN: null,
}
const listeners = new Set<() => void>()
export function getSnapshot() { return state }
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function set(p: Partial<AppState>) { state = { ...state, ...p }; listeners.forEach((l) => l()) }

const VIEW_SLOTS = 9  // conversation/shell view: scroll arrows + position moved into the header, so 9 content lines, no footer
const maxScroll = (n: number, vis: number = SLOTS) => Math.max(0, n - vis)

// --- idle screen-sleep: blank the HUD after inactivity; wake on a gesture (AppGlasses bumps
// lastActivity + swallows the waking gesture) or, if enabled, when a session changes state. ---
let lastActivity = Date.now()
let prevStatus = new Map<string, string>()
export function noteActivity() { lastActivity = Date.now(); if (state.asleep) set({ asleep: false }) }
export function idleTick() {
  const sec = getIdleSleepSec()
  // never sleep mid-input: only the passive view/list state (phase 'view') is sleepable; while
  // listening/reviewing, voice/typing activity also bumps lastActivity (see beginMic/setTypingText).
  // Also never sleep while a live prompt (menu READ/PICK) is open — blanking it would swallow the
  // answer/approve tap and the prompt is exactly "needs your input".
  if (!sec || state.asleep || state.phase !== 'view' || state.menu) return
  if (Date.now() - lastActivity >= sec * 1000) set({ asleep: true })
}

// The list highlight is anchored to a SESSION (its pane id), not a row number. The list re-sorts on
// every poll (a status change, a pin), and a row number would silently slide onto a different
// session between the swipe that highlights it and the tap that opens it.
const NEW_ROW = '+'  // pseudo-id of the "＋ new session" row (always last)
export function listRows(s: AppState): string[] { return [...s.panes.map((p) => p.n), NEW_ROW] }
// Row of the anchored selection. If that session is gone (or nothing is chosen yet), stay on the
// row the highlight was last on.
export function listRow(s: AppState): number {
  const rows = listRows(s), i = rows.indexOf(s.listSel)
  return i >= 0 ? i : Math.max(0, Math.min(s.listPos, rows.length - 1))
}
export function selectRow(n: string) {
  if (n !== state.listSel) set({ listSel: n, listPos: Math.max(0, listRows(state).indexOf(n)) })
  showPreview()
}
// A new pane list: keep the selection on a row that exists — the same session if it is still
// listed, else whatever now sits on the row it was on — so `listSel` always names the highlighted
// row (the preview and the pin menu act on it). With no sessions yet it stays unset, so the list
// still opens on the first session when they arrive.
function withSel(panes: Pane[]): Partial<AppState> {
  const rows = [...panes.map((p) => p.n), NEW_ROW]
  let i = rows.indexOf(state.listSel)
  if (i < 0) { if (!panes.length) return { panes }; i = Math.max(0, Math.min(state.listPos, rows.length - 1)) }
  return { panes, listSel: rows[i], listPos: i }
}

// --- list preview: the highlighted session's latest exchange, drawn beside the list ---
// Shown from a per-session cache at once, then re-checked (cheap: etag) once the swipes settle and
// on every list poll. The settle delay is longer than the fastest swipe cadence (even-toolkit drops
// same-direction repeats inside 350ms), so scrolling down the list costs one request, not one per row. Frontend-only — it reuses the conversation endpoint, so no backend update.
const PREVIEW_PX = 236  // text width of the preview column (screens.ts listPreview / AppGlasses columns)
const PREVIEW_ROWS = 8  // the lines beside the list rows, under the header
const NO_PREVIEW: string[] = []
const previewCache = new Map<string, { etag: string | null; lines: string[] }>()
let previewTimer: ReturnType<typeof setTimeout> | null = null
// The prompt (one clipped line), then the END of the reply to it — where the session stands now,
// which is what you triage on (a finished session's conclusion, or its question to you).
function previewOf(turns: Turn[], working: boolean): string[] {
  let u = -1
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') { u = i; break }
  const head = u >= 0 ? [truncateGlassText('▶ ' + turns[u].text.split('\n')[0], PREVIEW_PX)] : []
  const paras = turns.slice(u + 1).filter((t) => t.role === 'assistant').flatMap((t) => t.text.split('\n')).filter((l) => l.trim())
  if (working) paras.push('● working…')
  // Fill the space from the END of the reply: whole paragraphs while they fit, then the tail of the
  // next one, marked … so it doesn't read as the start of a sentence.
  const room = PREVIEW_ROWS - head.length
  let reply: string[] = []
  for (const para of paras.reverse()) {
    const w = wrapPx(para, '', PREVIEW_PX), free = room - reply.length
    if (w.length <= free) { reply = [...w, ...reply]; continue }
    if (free > 0) { const tail = w.slice(-free); tail[0] = '… ' + tail[0]; reply = [...tail, ...reply] }
    break
  }
  return [...head, ...reply]
}
function showPreview() {
  const n = state.listSel
  const lines = previewCache.get(n)?.lines ?? NO_PREVIEW
  if (lines !== state.preview) set({ preview: lines })
  if (previewTimer) clearTimeout(previewTimer)
  // only while the list is on screen, and only for a session that is on it (a request for a pane
  // that is gone would return a 4xx)
  if (!isConfigured() || state.activePaneN || state.asleep || !state.panes.some((p) => p.n === n)) return
  const gen = fleetGen
  previewTimer = setTimeout(() => {
    paneConversation(n, previewCache.get(n)?.etag).then((r) => {
      if (r.notModified || gen !== fleetGen) return
      const lines = previewOf(r.turns, r.working)
      previewCache.set(n, { etag: r.etag, lines })
      if (state.listSel === n) set({ preview: lines })
    }).catch(() => {})
  }, 600)
}

const ORDER: Record<string, number> = { waiting: 0, working: 1, done: 2, idle: 3, other: 4 }
// Panes that went working -> idle and haven't been opened yet: they stay pinned in a top "done"
// band (labeled », above plain idle) until the user opens them (openPane clears the mark). Dropped
// automatically once a pane is no longer idle (worked again / now needs input) or has vanished.
const finished = new Set<string>()
// Pinned sessions form a band at the very top (still ordered by status inside it), then the rest.
// A pin counts only while the id is still in the folder it was pinned in: tmux reuses pane ids after
// a server restart, so a stored pin could otherwise land on an unrelated session. A mismatch only
// hides the ★ (nothing is deleted), so a transient cwd change heals itself on the next poll.
function decorateAndSort(raw: Pane[]): Pane[] {
  const pinCwd = new Map(getPins().map((p) => [p.n, p.cwd]))
  return raw
    .map((p) => ({ ...p, done: finished.has(p.n), pinned: pinCwd.get(p.n) === p.cwd }))
    .sort((a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1)
                    || (ORDER[a.done ? 'done' : a.status] ?? 9) - (ORDER[b.done ? 'done' : b.status] ?? 9)
                    || a.window - b.window || a.pane_index - b.pane_index)
}
const MAX_PINS = 30  // pins of sessions that are gone are kept (they may be on the other backend), so cap growth
// Flips what the user SEES (p.pinned), replacing any stale entry stored under the same id.
export function togglePin(n: string) {
  const p = state.panes.find((x) => x.n === n)
  if (!p) return
  const rest = getPins().filter((x) => x.n !== n)
  setPins(p.pinned ? rest : [...rest, { n, cwd: p.cwd }].slice(-MAX_PINS))
  repaintPanes()
}
// Re-decorate + re-sort the CURRENT panes against `finished` and push if changed — reflects an
// openPane clear immediately (the list poll only runs while no pane is open, so it can lag 5s).
function repaintPanes() {
  const panes = decorateAndSort(state.panes)
  const sig = JSON.stringify(panes)
  if (sig !== lastPanesSig) { lastPanesSig = sig; set(withSel(panes)) }
}
let fleetGen = 0 // bumped on a backend switch so an in-flight poll from the OLD source is discarded
export async function refresh() {
  // Do NOT hit the network before the user has entered a backend URL + token: with an empty base
  // the fetch would go to a RELATIVE /api/panes (the app's own origin) and 404 — which the Even Hub
  // review harness flags as a 4xx. Stay idle until configured (the phone shows Setup meanwhile).
  if (!isConfigured()) { if (state.loading || state.error) set({ loading: false, error: null }); return }
  const gen = fleetGen
  try {
    const raw = await listPanes(true)
    if (gen !== fleetGen) return // source changed while this poll was in flight -> stale namespace
    const present = new Set(raw.map((p) => p.n))
    for (const n of finished) if (!present.has(n)) finished.delete(n)  // pane gone -> drop the mark
    for (const n of previewCache.keys()) if (!present.has(n)) previewCache.delete(n)
    for (const p of raw) {
      if (prevStatus.get(p.n) === 'working' && p.status === 'idle') finished.add(p.n)  // just finished -> pin as "done"
      else if (p.status !== 'idle') finished.delete(p.n)                                // re-activated -> no longer "done"
    }
    // wake the sleeping HUD when a session finishes or starts needing you (working -> idle/waiting)
    if (getWakeOnChange() && prevStatus.size) {
      for (const p of raw) if (prevStatus.get(p.n) === 'working' && (p.status === 'idle' || p.status === 'waiting')) { noteActivity(); break }
    }
    prevStatus = new Map(raw.map((p) => [p.n, p.status]))
    const panes = decorateAndSort(raw)
    const sig = JSON.stringify(panes)
    if (sig !== lastPanesSig) { lastPanesSig = sig; set({ ...withSel(panes), loading: false, error: null }) }  // skip identical re-push
    else if (state.loading || state.error) set({ loading: false, error: null })
    health().then((h) => set({ voiceOn: h.voice, voiceChecked: h.checked || [] })).catch(() => {})
    showPreview()  // keep the highlighted session's preview current
  } catch (e) { if (gen === fleetGen) set({ loading: false, error: String(e) }) }
}

// --- detect an interactive option menu in the captured screen ---
function parseMenu(raw: string[]): MenuState | null {
  // GATE: only a LIVE prompt counts — its footer ("Enter to select…", "(esc)", …) sits at the BOTTOM
  // of the screen. When the session is idle the bottom is the Claude input box instead, so this
  // rejects conversation scrollback that merely QUOTES a menu (tab strips, "❯ 1.", "Submit" — common
  // when the chat is ABOUT menus), which would otherwise lock the view onto that quoted text.
  const tailLines = raw.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean).slice(-5)
  // a live prompt ends in EITHER a footer (AskUserQuestion) OR a numbered option (permission / plan /
  // trust) at the very bottom; when idle, the bottom is the input box, so neither holds -> reject
  // (and conversation scrollback quoting a menu, which has the input box below it, is rejected too).
  const footerAtBottom = /to navigate|to select|to submit|esc to cancel|\(esc\)|enter to (?:select|confirm|submit|continue|proceed)|tab\/arrow|space to (?:toggle|select)/i.test(tailLines.join('\n'))
  const optionAtBottom = tailLines.slice(-2).some((l) => /^[│|]?\s*[❯›]?\s*\d+[.)]\s/.test(l))
  if (!footerAtBottom && !optionAtBottom) return null
  // ...but if the very bottom is clearly the idle Claude input box, it's NOT a live prompt — a footer
  // QUOTED a few lines up (within the 5-line window) could otherwise sneak past the check above.
  if (/\? for shortcuts|shift\+tab|auto-?accept edits|^[│|]\s*>|^>\s*$/im.test(tailLines.slice(-3).join('\n'))) return null
  // An option line: an optional box-border │, an optional ❯/› cursor, a number, then the label.
  // (capture-pane's -J already rejoined soft-wrapped options, so each option is one logical line.)
  // The checkbox content is ' ' (unchecked) or x/X/*/✓/✔ (checked) — Claude renders a CHECKED
  // multi-select box as `[✔]` (U+2714), so ✓/✔ MUST be in the class or it isn't recognized as a box
  // and the glyph leaks into the title (then we'd prepend our own [ ] → a doubled "[ ] [ ]").
  const OPT = /^\s*[│|]?\s*(❯|›|>|\*)?\s*(\d+)[.)]\s*(\[([ xX*✓✔])\]\s*)?(.+?)\s*$/
  const isCursor = (l: string) => /^\s*[│|]?\s*[❯›]\s*\d+[.)]/.test(l)  // a real TUI cursor (not >/*/list)
  // AskUserQuestion shows a tab strip ending in Submit, e.g.
  //   ←  ☐ Saturday AM  ☐ Superpower  ☐ Dream trip  ✔ Submit  →
  // That strip (checkbox glyphs + the word Submit) uniquely marks this prompt type at every stage,
  // including the final Submit screen (which has NO numbered options of its own). The number of
  // [☐☑✔] markers = the tab count (questions + Submit), used to jump to the Submit tab.
  // The REAL tab strip is the LAST checkbox+Submit line (the live prompt sits at the bottom of the
  // screen); earlier matches can be conversation scrollback that merely quotes "☐ … ✔ Submit".
  let tabLine = '', tabIdx = -1
  for (let i = raw.length - 1; i >= 0; i--) if (/\bsubmit\b/i.test(raw[i]) && /[☐☑✔]/.test(raw[i])) { tabLine = raw[i]; tabIdx = i; break }
  const ask = !!tabLine
  const tabCount = (tabLine.match(/[☐☑✔]/g) || []).length || 1
  const FREE = /\btype something\b|^\s*other\s*$|^\s*custom\b/i
  const opts: { i: number; num: number; title: string; cur: boolean; box: boolean; checked: boolean; free: boolean }[] = []
  raw.forEach((l, i) => {
    const m = l.match(OPT)
    // Skip a PURE-numeric title (a stray "2024" / version line, not a real label) but KEEP "30 minutes";
    // for an ask, also ignore option lines ABOVE the live tab strip (chat scrollback quoting a prompt).
    if (m && m[5] && !/^\d+(?:[.)]\d+)*\s*$/.test(m[5]) && (!ask || i > tabIdx)) opts.push({ i, num: Number(m[2]), title: m[5].trim(), cur: isCursor(l), box: !!m[3], checked: /[xX*✓✔]/.test(m[4] || ''), free: FREE.test(m[5]) })
  })
  // Final Submit screen of an AskUserQuestion: the tab strip is there but no numbered options — give
  // a Submit-only menu so the user can still send (an Enter on the active Submit tab submits).
  if (opts.length < 2) return ask ? { question: 'review & submit', options: [], multi: false, cursorIndex: 0, ask: true, tabCount } : null
  // ANCHOR the option list to the ❯ cursor: keep only the consecutive-numbered run that contains
  // the cursor. This rejects "phantom" options from a numbered list in the plan / scrollback ABOVE
  // the prompt (no cursor, and doesn't chain into the real run that starts at 1). Without a cursor,
  // fall back to the LAST run starting at 1 (the live prompt sits at the bottom) + require a footer.
  let lo: number, hi: number
  // anchor to the LAST cursor option — the live prompt is at the BOTTOM, so if scrollback above also
  // shows a "❯ 1." (e.g. the chat quoting a prompt), the bottom-most cursor is the real one.
  let ci = -1
  for (let k = opts.length - 1; k >= 0; k--) if (opts[k].cur) { ci = k; break }
  if (ci >= 0) {
    lo = hi = ci
    while (lo > 0 && opts[lo - 1].num === opts[lo].num - 1) lo--
    while (hi < opts.length - 1 && opts[hi + 1].num === opts[hi].num + 1) hi++
  } else {
    if (!raw.some((l) => /to navigate|to select|✔ ?submit|esc to cancel/i.test(l))) return null
    lo = -1
    for (let k = opts.length - 1; k >= 0; k--) if (opts[k].num === 1) { lo = k; break }
    if (lo < 0) return null
    hi = lo
    while (hi < opts.length - 1 && opts[hi + 1].num === opts[hi].num + 1) hi++
  }
  const block = opts.slice(lo, hi + 1)
  if (block.length < 2) return null
  // Question text: for an AskUserQuestion it's the line(s) between the tab strip and the first option
  // (it may end in ':' not '?', so don't require a '?'); otherwise fall back to the first '?' line
  // (permission prompts say "Do you want to proceed?").
  let q = ''
  if (ask) {
    // scan UP from the first option to the NEAREST tab strip above it (the real prompt's strip, just
    // above the question) — NOT the first strip in the capture, which may be chat scrollback quoting
    // one (then the "question" would swallow that conversation text).
    let tabI = -1
    for (let i = opts[lo].i - 1; i >= 0; i--) if (/[☐☑✔]/.test(raw[i]) && /\bsubmit\b/i.test(raw[i])) { tabI = i; break }
    if (tabI >= 0) q = raw.slice(tabI + 1, opts[lo].i)
      .map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
      .filter((l) => l && !/^[\s─-╿=_·.\-]+$/.test(l))
      .join(' ')
  }
  // fallback (permission/plan): the nearest '?' line ABOVE the first option — scanning up (bounded)
  // avoids grabbing a '?' from chat scrollback far above.
  if (!q) for (let i = opts[lo].i - 1; i >= 0 && i >= opts[lo].i - 12; i--) {
    const t = raw[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
    if (t.includes('?') && t.length > 8) { q = t.replace(/^[│|❯>›*\s]+/, ''); break }
  }
  return {
    question: q,
    options: block.map((o, k) => {
      // capture the option's DESCRIPTION (the indented prose line(s) right after it, before the next
      // option) so the READ view can be rebuilt from clean parsed text — wrapped to the glasses width
      // instead of inheriting the terminal's narrower wrap points.
      const endI = k + 1 < block.length ? block[k + 1].i : o.i + 4
      const desc = raw.slice(o.i + 1, Math.min(endI, raw.length))
        .map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/^[│|\s]+/, '').trim())
        .filter((l) => l && !/^[─\-═_·.]+$/.test(l) && !/to navigate|to select|esc to cancel|tab\/arrow|^next$|^chat about this\.?$/i.test(l) && !OPT.test(l))
        .join(' ')
      return { num: o.num, title: o.title, current: o.cur, checked: o.checked, free: o.free, desc }
    }),
    multi: block.some((o) => o.box),
    cursorIndex: Math.max(0, block.findIndex((o) => o.cur)),
    ask,
    tabCount,
  }
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
// Wrap a touch under the 576px panel: at ~568 a filled line sat right at the device's usable edge,
// so the firmware re-wrapped it on screen, leaving a stray short remainder ("wrapped early
// sometimes"). 548 matches the answer view's proven-good option width and keeps a safe margin.
const WRAP_PX = 548
function wrapPx(line: string, indent = '', width = WRAP_PX): string[] {
  if (getTextWidth(line) <= width) return [line]
  const out: string[] = []
  let cur = ''
  for (const w of line.split(' ')) {
    const trial = cur === '' ? w : cur + ' ' + w
    if (getTextWidth(trial) <= width) { cur = trial; continue }
    if (cur !== '') out.push(cur)
    if (getTextWidth(indent + w) > width) {
      let r = indent + w
      while (getTextWidth(r) > width) {
        let lo = 1, hi = r.length, k = 1
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (getTextWidth(r.slice(0, mid)) <= width) { k = mid; lo = mid + 1 } else hi = mid - 1 }
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
  const ms = maxScroll(lines.length, VIEW_SLOTS)
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
// continuation indent for a wrapped MENU/READ line: align under the option text, past any cursor
// (❯/›/▶), number (1.) and checkbox ([ ]) prefix — so a long option's wrapped lines stay aligned
// under the option (matching the answer view) instead of dropping back to the left margin.
function menuHangIndent(line: string): string {
  const m = line.match(/^(\s*(?:[❯›▶]\s+)?(?:\d+[.)]\s+)?(?:\[.\]\s+)?)/)
  return ' '.repeat(Math.min(m ? m[1].length : 0, 8))
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
      // ▶ marks the prompt; indent its continuation lines 2 so a multi-line prompt reads as one
      // left-shifted block (without the indent, lines 2+ look exactly like the assistant's reply)
      t.text.split('\n').forEach((l, i) => add(i === 0 ? '▶ ' + l : (l.trim() ? '  ' + l : l)))
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
    raw.push(...wrapPx(state.activity ? '● ' + state.activity : '● working…'))  // ● = working, as in the list (⋯ is not in the G2 font)
  }
  const lines = raw.length ? raw : ['(no replies yet)']
  const ms = maxScroll(lines.length, VIEW_SLOTS)
  const cap = lines.length > VIEW_SLOTS ? Math.max(0, lines.length - 1) : 0
  // atBottom -> live edge. Otherwise: if the user has NOT manually scrolled, FOLLOW the latest prompt
  // — so the view never gets stuck at a stale line after the conversation grows underneath a menu
  // (e.g. while an AskUserQuestion is open). If they HAVE scrolled, preserve their spot so a poll
  // doesn't yank it back. (jumpToLatest double-tap still stages prompt -> end -> list on top of this.)
  const scroll = state.atBottom ? ms : (userScrolled ? Math.min(state.scroll, cap) : Math.min(lastPromptIndex(lines), cap))
  set({ lines, scroll })
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
    // restoring a scrolled-up spot counts as "manually scrolled" so buildView preserves it (doesn't
    // re-follow the latest prompt and clobber the resume).
    if (r.scrolledAway && !newQuestion) { userScrolled = true; set({ working, atBottom: r.atBottom, scroll: r.scroll }) }
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
// The full prompt as you'd read it on the terminal — the question, the numbered options AND
// their descriptions (an AskUserQuestion's structure lives in those indented descriptions, so
// keep the option lines as anchors), minus only TUI chrome (handled by cleanLines) and the
// navigation-hint line. Pre-wrapped to the display width. PICK then chooses among the options.
function menuBodyLines(raw: string[]): string[] {
  const isTabStrip = (l: string) => /[☐☑✔]/.test(l) && /\bsubmit\b/i.test(l)
  // For an AskUserQuestion the capture has conversation scrollback ABOVE the prompt; start the body
  // at the tab strip (the LAST such line = the live prompt at the bottom) so READ shows the PROMPT,
  // never the scrollback. A permission prompt has no tab strip -> keep the full body (the command to
  // read sits above the options).
  let tabI = -1
  for (let i = raw.length - 1; i >= 0; i--) if (isTabStrip(raw[i])) { tabI = i; break }
  const src = tabI >= 0 ? raw.slice(tabI) : raw
  // Drop the keyboard-hint FOOTER (its keys are gesture-driven here) but KEEP the tab strip — the
  // real strip has arrow glyphs AND "Submit", so it would match the arrow nav pattern; exempt it.
  const navRe = /to navigate|to select|to submit|esc to cancel|(?:←|→|↑|↓).*(?:switch|select|toggle|confirm|cancel|submit|navigate)/i
  const kept = cleanLines(src).filter((l) => isTabStrip(l) || !navRe.test(l))
  const out: string[] = []
  for (const l of kept) out.push(...(l === '' ? [''] : wrapPx(l, menuHangIndent(l))))
  return out.length ? out : ['(no output)']
}
// READ body for an AskUserQuestion, rebuilt from the PARSED prompt (clean question + option labels +
// descriptions) and wrapped to the glasses width — NOT the raw capture. The raw lines are pre-wrapped
// at the terminal's (narrower) width, so on the glasses they broke at the wrong spots; rebuilding from
// parsed text makes the read view fill the width consistently, exactly like the answer view.
function buildAskBody(m: MenuState): string[] {
  const out = wrapPx(m.question || 'review & submit')
  for (const o of m.options) {
    out.push('')
    const label = (m.multi && !o.free) ? `${o.checked ? '[x]' : '[ ]'} ${o.title}` : `${o.num}. ${o.title}`
    out.push(...wrapPx(label, menuHangIndent(label)))
    if (o.desc) out.push(...wrapPx('   ' + o.desc, '   '))
  }
  return out
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
  const patch: Partial<AppState> = { menu, activity }
  if (menu) {
    // AskUserQuestion: rebuild the READ body from clean parsed text (wraps to the glasses width).
    // Permission / plan prompts keep the raw capture (the exact command/diff matters verbatim).
    const body = (menu.ask && menu.options.length) ? buildAskBody(menu) : menuBodyLines(raw)
    patch.menuBody = body
    // Open the READ view whenever a NEW question appears — the first prompt, AND each next question
    // of an AskUserQuestion as you advance (→ next question) — so you read it before answering.
    // Re-renders of the SAME question (e.g. right after you select an option) keep your current
    // phase, so answering an option never bounces you out of PICK.
    if (!state.menu || state.menu.question !== menu.question) {
      patch.menuPhase = 'read'
      // The capture is the whole terminal screen, so conversation scrollback sits ABOVE the prompt.
      // Anchor READ at the actionable part, NOT line 0 (which would show old conversation): the tab
      // strip for an AskUserQuestion, or the numbered-option list for a permission prompt.
      // menuBodyLines already slices an ask body to START at the tab strip, so READ opens at the top
      // (scroll 0); a permission prompt keeps its full body, so anchor at the numbered options (the
      // command/diff to read sits above them).
      const optIdx = body.findIndex((l) => /^\s*(❯|›|>|\*)?\s*\d+[.)]\s/.test(l))
      patch.menuScroll = menu.ask ? 0 : (optIdx > 0 ? Math.max(0, optIdx - 3) : 0)
    }
  }
  set(patch)
  if (reRender) buildView()
}

function closeStream() { if (es) { es.close(); es = null } }
function stopAnswers() { if (answersTimer) { clearInterval(answersTimer); answersTimer = null } }

export function openPane(n: string, label: string, isClaude: boolean, cwd: string) {
  closeStream(); stopAnswers()
  if (finished.delete(n)) repaintPanes()  // opening a finished session acknowledges it -> unpin from the "done" band
  convoLines = []
  set({ activePaneN: n, activeLabel: label, activeIsClaude: isClaude, activeCwd: cwd, listSel: n,
        lines: ['…'], menu: null, menuPhase: 'read', menuBody: [], menuScroll: 0, menuFreeText: false, scroll: 0, atBottom: true, working: false, activity: '', phase: 'view', draft: '', draftKind: null, status: '', typingText: '' })
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
    // Closing counts as having SEEN this session. The fleet poll is paused while a pane is open, so
    // prevStatus still holds the pre-open value ('working'); without this, the first post-close poll
    // would see working->idle for a completion the user just watched and false-pin it in the done
    // band. Record the live state instead (a pane left mid-work still pins when it finishes later),
    // and drop any pin added by an asleep-poll while the pane was open.
    prevStatus.set(state.activePaneN, state.working ? 'working' : 'idle')
    if (finished.delete(state.activePaneN)) repaintPanes()
  }
  closeStream(); stopAnswers(); stopMic(); set({ activePaneN: null, phase: 'view' })
  showPreview()  // back on the list: show what the session we just left says now
}

// Switching backend (tmux <-> herdr) changes the pane-id namespace, so the open pane view, the
// done-band memory, and per-pane scroll memory all refer to ids that no longer exist on the newly
// selected source. Drop them and re-poll so nothing straddles two backends (a frozen open view).
// Pins are NOT dropped: tmux and herdr ids can't collide, so each backend's pins wait for it.
export function resetForSourceChange() {
  fleetGen++                  // invalidate any in-flight poll from the old source
  closePane()                 // back to the fleet; stops the open pane's SSE/poll
  finished.clear()
  prevStatus = new Map()
  paneMem.clear()
  previewCache.clear()
  lastPanesSig = ''
  set({ panes: [], loading: true, error: null, listSel: '', listPos: 0, preview: NO_PREVIEW })
  refresh()
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
  const ms = maxScroll(state.lines.length, VIEW_SLOTS)
  const scroll = Math.max(0, Math.min(ms, state.scroll + (dir === 'up' ? -scrollStep : scrollStep)))
  set({ scroll, atBottom: scroll >= ms })
}

// Scroll the permission-prompt body (READ mode) — same velocity accel as scrollDetail.
export function scrollMenu(dir: 'up' | 'down') {
  const now = Date.now()
  const sustained = dir === scrollDir && now - scrollTs < SCROLL_WINDOW_MS
  scrollStep = sustained ? Math.min(SCROLL_MAX, scrollStep + SCROLL_GAIN) : SCROLL_BASE
  scrollTs = now; scrollDir = dir
  const ms = maxScroll(state.menuBody.length)
  const menuScroll = Math.max(0, Math.min(ms, state.menuScroll + (dir === 'up' ? -scrollStep : scrollStep)))
  set({ menuScroll })
}
// READ -> PICK once you've seen the command; double-tap in PICK returns to READ.
export function menuToPick() { set({ menuPhase: 'pick' }) }
export function menuToRead() { set({ menuPhase: 'read' }) }

// Staged "return to live" for the conversation view (double-tap):
//   scrolled up above the latest prompt -> jump to that prompt;
//   below the prompt but not at the bottom -> jump to the bottom (live edge);
//   already at the bottom -> return false so the caller leaves to the list.
export function jumpToLatest(): boolean {
  // at the live edge, or the whole conversation fits on screen -> nothing to jump to; leave to list
  if (state.atBottom || state.lines.length <= VIEW_SLOTS) return false
  const ms = maxScroll(state.lines.length, VIEW_SLOTS)
  // Claude pane not already showing the latest prompt at the top (whether you scrolled up above it
  // OR down into its answer) -> bring that prompt to the TOP. scroll may exceed the normal bottom
  // (ms) so even a short last exchange lands prompt-first (the view display + buildView allow this
  // over-scroll). Shell panes have no prompt marker, and "already on the prompt" -> live edge.
  if (state.activeIsClaude) {
    const promptPos = lastPromptIndex(state.lines)
    if (state.scroll !== promptPos) { set({ scroll: promptPos, atBottom: false }); return true }
    // already ON the prompt AND it's at/past the live edge (nothing below) -> the prompt stage and
    // the live-edge stage coincide, so don't burn a double-tap on a no-op set; leave to the list.
    if (promptPos >= ms) return false
  }
  set({ scroll: ms, atBottom: true })
  return true
}

// --- menu mode: drive the real TUI selection with keystrokes ---
// Send keys ONE AT A TIME with a gap. The prompt's TUI (Ink/React) processes a BATCHED "Down Space"
// by applying the Space to the row it was on BEFORE the Down's cursor move re-renders (verified
// on-device: it toggled the wrong row). Spacing them out lets each cursor move land before the next
// key. ~150ms matches the backend's own send_text settle delay.
async function sendKeysSpaced(n: string, keys: string[]) {
  for (let i = 0; i < keys.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 150))
    await sendKeys(n, [keys[i]])
  }
}
// DELTA nav: a swipe only moves the LOCAL ▶ highlight (no keystroke). On TAP we move the prompt's ❯
// from where it is (cursorIndex) to the highlighted row and act. Robust to the G2 pad emitting a
// BURST of swipe events (the burst just moves ▶; the tap reconciles the delta).
export async function pickMenuOption(targetIdx: number) {
  const m = state.menu, n = state.activePaneN
  if (!m || !n) return
  const opt = m.options[targetIdx]
  const nav: string[] = []
  for (let d = targetIdx - m.cursorIndex, i = 0; i < Math.abs(d); i++) nav.push(d > 0 ? 'Down' : 'Up')
  // The ❯ STAYS where we leave it (verified on-device: no auto-advance after a toggle), so the
  // optimistic cursorIndex = targetIdx — which keeps the NEXT pick's delta correct. On a FAILED
  // keystroke restore the pre-pick `m` (the sig-dedup won't otherwise correct an optimistic change).
  if (opt?.free) {
    // free-text ("Type something"): move to it + Enter to open its inline input, then the type path.
    set({ menu: { ...m, cursorIndex: targetIdx }, menuFreeText: true })
    try { await sendKeysSpaced(n, [...nav, 'Enter']); startVoice() } catch { set({ menu: m, menuFreeText: false }) }
  } else if (m.multi) {
    // multi-select: move to the row + Space to toggle; flip the checkbox locally for instant feedback.
    const options = m.options.map((o, i) => (i === targetIdx ? { ...o, checked: !o.checked } : o))
    set({ menu: { ...m, cursorIndex: targetIdx, options } })
    try { await sendKeysSpaced(n, [...nav, 'Space']) } catch { set({ menu: m }) }
  } else if (m.ask) {
    // AskUserQuestion single-select: move to the option + Enter to select it (footer: "Enter to
    // select"; digits are NOT hotkeys). It selects, it does NOT submit (separate Submit-tab step).
    set({ menu: { ...m, cursorIndex: targetIdx } })
    try { await sendKeysSpaced(n, [...nav, 'Enter']) } catch { set({ menu: m }) }
  } else {
    // plain single-select (permission Yes/No): the NUMBER then Enter — absolute, so it can never
    // approve the WRONG option regardless of cursor position.
    try { await sendKeysSpaced(n, [String(opt?.num ?? targetIdx + 1), 'Enter']) } catch { /* SSE will resync */ }
  }
}
// AskUserQuestion: advance to the next question/tab. Right cycles the question tabs — but ONLY from a
// normal numbered option; on the special "Type something" / "Next" / "Chat about this" rows it's
// swallowed (verified on-device: after a free-text answer the ❯ sits on "Type something" and Right did
// nothing). So first walk the ❯ UP to option 1, then Right. Use the EXACT tracked cursor index for the
// step count — NOT a fixed over-count: the list wraps around, so overshooting cycled the ❯ back onto a
// special row and Right died again ("cursor flew through all the rows, nothing advanced"). Exactly
// `cursorIndex` Ups lands on option 1 whether the list wraps or clamps, and can never overshoot.
export async function menuTabNext() {
  const n = state.activePaneN, m = state.menu
  if (!n) return
  const ups: string[] = Array(Math.max(0, m?.cursorIndex ?? 0)).fill('Up')
  try { await sendKeysSpaced(n, [...ups, 'Right']) } catch { /* SSE will resync */ }
}
export async function submitMenu() {
  const n = state.activePaneN
  if (!n) return
  // Bare Enter: this is only reached from the option-less Submit screen (the synthetic menu, ❯ on the
  // submit action) or a plain multi-select's "» Submit". The NORMAL multi-question Submit screen has
  // a real "Submit answers" option the user taps directly (pickMenuOption), so no tab-jumping here.
  try { await sendKeys(n, ['Enter']) } catch { /* SSE will resync */ }
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
    micUnsub = mic.onAudioData((chunk, rate) => { pcm.push(chunk); micRate = rate; noteActivity() })
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
export function cancelInput() {
  // close the prompt's opened free-text field so it isn't left stuck in its inline input. Single-select
  // uses Escape; multi-select toggles the checked free option back off with Space instead (Escape in a
  // multi-select can cancel the whole prompt). Only when menuFreeText — an ordinary reply has no field.
  if (state.menuFreeText && state.activePaneN) {
    sendKeys(state.activePaneN, [state.menu?.multi ? 'Space' : 'Escape']).catch(() => {})
  }
  stopMic(); pcm = []; set({ phase: 'view', status: '', draft: '', draftKind: null, typingText: '', menuFreeText: false })
}
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
  if (state.menuFreeText) {
    // spoken free-text answer to an AskUserQuestion: type it INTO the field, back to menu. Multi-select
    // takes NO trailing Enter — Enter there UNCHECKS the just-typed answer (verified on-device);
    // single-select takes Enter (confirm + auto-advance).
    const n = state.activePaneN, multi = !!state.menu?.multi
    set({ menuFreeText: false, phase: 'view', busy: false, status: '' })
    if (n) { try { await sendToPane(n, text, !multi) } catch { /* SSE resyncs */ } }
    return
  }
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
    // "working…" only applies to a Claude pane (it's processing your prompt); a shell pane has no such
    // state, so setting working:true + buildView would clobber its live screen with a permanent '● working…'.
    const claude = state.activeIsClaude
    set({ phase: 'view', atBottom: true, working: claude, busy: false, status: '', draft: '', draftKind: null })
    if (claude) buildView()
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
  noteActivity()  // typing keeps the HUD awake even with no glasses gestures
  set({ typingText: t })
}

export async function submitTypedInput() {
  const t = state.typingText.trim()
  set({ typingText: '' })
  stopMic(); pcm = []
  if (state.menuFreeText) {
    // free-text answer to an AskUserQuestion: type it INTO the open field (+Enter) and return to the
    // menu — NOT a new prompt, so no "working" spinner / conversation switch. The SSE re-renders the
    // prompt (answer filled / advanced to the next question).
    const n = state.activePaneN, multi = !!state.menu?.multi
    set({ menuFreeText: false, phase: 'view', status: '' })
    // text -> type it into the field. Multi-select takes NO trailing Enter (Enter unchecks the answer);
    // single-select takes Enter (confirm + advance). empty -> undo: multi unchecks the free option
    // (Space), single closes the inline field (Escape) — don't leave the prompt stuck in its input.
    if (n) { try { await (t ? sendToPane(n, t, !multi) : sendKeys(n, [multi ? 'Space' : 'Escape'])) } catch { /* SSE resyncs */ } }
    return
  }
  if (!t) return
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
