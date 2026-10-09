// Control state machine: list <-> detail; detail phases view/listening/confirm.
// In 'view', if the pane is showing an option menu, render a clean selectable list (menu mode).
import { line, glassHeader, type DisplayData } from 'even-toolkit/types'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { moveHighlight } from 'even-toolkit/glass-nav'
import { truncateGlassText, getTextWidth } from 'even-toolkit/pretext'
import { createGlassScreenRouter, type GlassScreen } from 'even-toolkit/glass-screen-router'
import { listRows, listRow, PREVIEW_PX, NO_PREVIEW, type AppState } from './store'
import type { Pane } from './api'
import { isConfigured, getPreview } from './config'

export interface Ctx {
  exitApp: () => void
  openPane: (n: string, label: string, isClaude: boolean, cwd: string) => void
  selectRow: (n: string) => void
  closePane: () => void
  scrollDetail: (dir: 'up' | 'down') => void
  scrollMenu: (dir: 'up' | 'down') => void
  menuToPick: () => void
  menuToRead: () => void
  jumpToLatest: () => boolean
  startVoice: () => void
  stopVoice: () => void
  cancelInput: () => void
  redoVoice: () => void
  sendNow: () => void
  scrollConfirm: (dir: 'up' | 'down') => void
  pickMenuOption: (idx: number) => void
  menuTabNext: () => void
  submitMenu: () => void
  startNewSession: () => void
  moveNewTag: (dir: 'up' | 'down') => void
  chooseNewTag: () => void
  stopNewTagVoice: () => void
  stopNewVoice: () => void
  retryNewVoice: () => void
  createNewSession: () => void
  cancelNewSession: () => void
}

const GLYPH: Record<string, string> = { waiting: '!', working: '●', idle: '○', other: '·' }
const PIN = '★'  // marks a pinned session (list row + open-session header)
// The list screen is two columns sharing the display: rows in the left third (clipped to listPx), a
// preview panel in the right two thirds (listPreview; AppGlasses columns). With the preview switched
// off on the phone the rows get the whole width.
const listPx = () => (getPreview() ? 172 : 548)
// A solid rule under the panel's title. Box-drawing ─ joins into one line in the glasses font; no
// glyph joins VERTICALLY (every one is shorter than the line pitch — a column of | reads as dashes).
const RULE = (() => { let r = ''; while (getTextWidth(r + '─') <= PREVIEW_PX) r += '─'; return r })()
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const DETAIL_SLOTS = 9
const VIEW_SLOTS = 9  // conversation/shell view: header (with scroll/position) + 9 content, no footer (must match store VIEW_SLOTS)

function wrap(s: string, n: number): string[] {
  const out: string[] = []
  let r = s
  while (r.length > n) { out.push(r.slice(0, n)); r = r.slice(n) }
  out.push(r)
  return out
}

// Pixel-accurate word-wrap to at most `max` display lines (proportional font); each line is also
// truncateGlassText-clipped at render. Used to show the prompt question above the option list.
function wrapLines(s: string, max: number, width = 568): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of s.split(/\s+/)) {
    const trial = cur ? cur + ' ' + w : w
    if (getTextWidth(trial) <= width) { cur = trial; continue }
    if (cur) out.push(cur)
    if (out.length >= max) return out.slice(0, max)
    cur = w
  }
  if (cur) out.push(cur)
  return out.slice(0, max)
}

// PICK rows = the options, then synthetic action rows. AskUserQuestion ('ask') gets a "next
// question" (→) and a "submit" (↵); a plain multi-select gets just a Submit. One list drives both
// the display and the tap handler so a highlighted row always maps to the same action.
type MenuRow = { text: string; kind: 'opt' | 'next' | 'submit'; idx: number }
function menuRows(s: AppState): MenuRow[] {
  const m = s.menu
  if (!m) return []
  // Glyph note: the G2 firmware font lacks ☐/☑/✔/✎/▸ (they render blank), but → ▶ » · do render.
  // So free-text keeps its number (the "Type something" label is self-explanatory), "next" uses →,
  // and "submit" uses » (a checkmark/▸ would be invisible).
  const rows: MenuRow[] = m.options.map((o, i) => ({
    kind: 'opt', idx: i,
    // free-text ("Type something") isn't a checkbox even in a multi-select — keep it as "N. title",
    // not a fake "[ ]". Real multi-select options show their tick state; single-select shows "N.".
    text: (m.multi && !o.free) ? `${o.checked ? '[x]' : '[ ]'} ${o.title}` : `${o.num}. ${o.title}`,
  }))
  if (m.ask) {
    // Single-select questions AUTO-ADVANCE on answer (verified on-device), so they need no extra row.
    // MULTI-select doesn't advance, so it gets "→ next question". The real Submit screen has its OWN
    // "Submit answers" option you tap — no synthetic submit. Only the rare option-less Submit screen
    // (the synthetic menu) gets a "» submit answers" fallback.
    if (m.multi && m.options.length) rows.push({ kind: 'next', idx: -1, text: '→ next question' })
    else if (!m.options.length) rows.push({ kind: 'submit', idx: -1, text: '» submit answers' })
  } else if (m.multi) {
    rows.push({ kind: 'submit', idx: -1, text: '» Submit' })
  }
  return rows
}

const listScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    if (!isConfigured()) return { lines: [...glassHeader('G2C'), line('Not set up yet', 'meta'), line('Open G2C on your phone', 'meta'), line('and enter your backend URL + token', 'meta')] }
    if (s.loading) return { lines: [...glassHeader('G2C'), line('loading…', 'meta')] }
    if (s.error) return { lines: [...glassHeader('G2C'), line('offline', 'meta'), line(clip(s.error, 26), 'meta')] }
    const wait = s.panes.filter((p) => p.status === 'waiting').length
    const work = s.panes.filter((p) => p.status === 'working').length
    const done = s.panes.filter((p) => p.done).length  // just-finished (working->idle), pinned until opened
    const idle = Math.max(0, s.panes.length - work - wait - done)
    // one consistent bar; drop zero fields instead of hiding idle when busy
    const segs = [wait && `${wait}! need you`, work && `${work}● working`, done && `${done}» done`, idle && `${idle}○ idle`].filter(Boolean)
    // Sessions first (pinned ★ band on top, then by status); "＋ new session" is the LAST row. So the
    // list opens on the session that most needs you, and new-session is one swipe up (the list wraps).
    const items: (Pane | null)[] = [...s.panes, null]
    const hi = listRow(s)
    const VIS = 8
    const pages = Math.max(1, Math.ceil(items.length / VIS))
    const page = Math.min(pages, Math.floor(hi / VIS) + 1)
    const list = buildScrollableList({
      items,
      highlightedIndex: hi,
      maxVisible: VIS,
      // tag (project) first — it's the disambiguator across ~35 sessions; only the long title clips
      // (to listPx, leaving the right side for the preview). ▶ marks the selected row by TEXT (columns
      // page mode flattens the line highlight style); the 3-space else keeps rows aligned.
      formatter: (it, i) =>
        truncateGlassText(`${i === hi ? '▶ ' : '   '}${it ? `${it.pinned ? PIN : ''}${it.done ? '»' : (GLYPH[it.status] ?? '·')} ${it.tag}  ${it.label}` : '＋ new session'}`, listPx()),
    })
    // The header must stay ONE line (a wrapped header pushes the list past the 10-line screen): with
    // every count in double digits the full bar is ~600px, so drop the least urgent counts to fit.
    const head = (n: number) => `SESSIONS ${s.panes.length} · p${page}/${pages}  ${segs.slice(0, n).join(' · ') || 'no sessions'}`
    let n = segs.length
    while (n > 1 && getTextWidth(head(n)) > 548) n--
    return { lines: [...glassHeader(head(n)), ...list] }
  },
  action(a, nav, s, ctx) {
    if (a.type === 'GO_BACK') { ctx.exitApp(); return nav } // root double-tap = system exit dialog
    // no list on screen (not set up / loading / offline) -> nothing to move or open. Also keeps an
    // unconfigured app off the network (a tap used to start the new-session flow and fetch).
    if (!isConfigured() || s.loading || s.error) return nav
    // the highlight is anchored to a session id (store.listSel), so resolve the row from that
    const rows = listRows(s), hi = listRow(s)
    if (a.type === 'HIGHLIGHT_MOVE') {
      // wrap around: swipe up from the first row jumps to the last, and vice versa —
      // the fast way to reach the far end of a long fleet without a page-jump gesture.
      const next = (hi + (a.direction === 'up' ? -1 : 1) + rows.length) % rows.length
      ctx.selectRow(rows[next])
      return { ...nav, highlightedIndex: next }
    }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      const p = s.panes[hi]
      if (!p) { ctx.startNewSession(); return { screen: 'new', highlightedIndex: 0 } } // the ＋ row
      ctx.openPane(p.n, p.label, p.is_claude, p.cwd)
      return { screen: 'detail', highlightedIndex: 0 }
    }
    return nav
  },
}

// The second column: a preview of the highlighted session beside the list rows. Both columns share
// the display, so EVERY other screen must send a blank here or the last preview stays drawn over it.
export function listPreview(s: AppState, screen: string): string {
  // nothing while the highlight is moving (NO_PREVIEW): the panel is drawn once, after the pause
  if (screen !== 'list' || !getPreview() || !isConfigured() || s.loading || s.error || s.preview === NO_PREVIEW) return ' '
  const p = s.panes[listRow(s)]
  // the title carries the full name — the row beside it is clipped to a third of the screen
  const title = truncateGlassText(p ? `${p.tag}  ${p.label}` : 'New session', PREVIEW_PX)
  // 6 lines under the rule. The "needs you" notice takes one; if the preview then no longer fits,
  // keep its first line (the request) and the END of the reply — on a session that needs you, the
  // end is the question.
  const wait = !!p && p.status === 'waiting', rows = wait ? 5 : 6
  const pv = s.preview.length > rows ? [s.preview[0], ...s.preview.slice(1 - rows)] : s.preview
  const body = !p ? ['Start a new Claude session', 'in a project folder.'] : [...(wait ? ['! needs you — tap to read'] : []), ...pv]
  // two blank lines keep it clear of the header, which runs the full width
  return ['', '', title, RULE, ...body].join('\n')
}

const detailScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    // The phone can close the pane out from under us (backend switch in Setup -> resetForSourceChange).
    // The router keeps its own current-screen state, so without this the glasses would stay stranded
    // on a dead detail view. Render an exit hint; any gesture (action below) returns to the list.
    if (!s.activePaneN) {
      return { lines: [
        ...glassHeader('session closed', 'LIST'),
        line('Backend was switched on the phone.', 'normal'),
        line('', 'meta'),
        line('Tap → back to the session list', 'meta'),
      ] }
    }
    const title = (s.panes.find((p) => p.n === s.activePaneN)?.pinned ? PIN + ' ' : '') + clip(s.activeLabel || 'session', 18)
    if (s.phase === 'listening') {
      return { lines: [
        ...glassHeader(title, s.typingText ? 'TYPING' : (s.voiceOn ? 'LISTENING' : 'TYPE ON PHONE')),
        line('● ' + (s.typingText ? truncateGlassText(s.typingText) : (s.status || (s.voiceOn ? `Speak your ${s.activeIsClaude ? 'message' : 'command'}…` : 'Type it on your phone…'))), 'normal'),
        line('', 'meta'),
        line(s.voiceOn ? 'Tap when done · type on phone · ◀◀ cancels' : 'Type on your phone · ◀◀ cancels', 'meta'),
      ] }
    }
    if (s.phase === 'confirm') {
      if (s.busy) return { lines: [...glassHeader(title, 'REVIEW'), line(s.status || 'working…', 'meta')] }
      // full-bleed, scrollable transcript (rendered in columns mode → no left margin).
      // a status line (send/translate failure) takes one slot so we never exceed the ~10-line budget.
      const total = s.draftLines.length
      const slots = DETAIL_SLOTS - (s.status ? 1 : 0)
      const top = Math.max(0, Math.min(s.confirmScroll, Math.max(0, total - slots)))
      const win = s.draftLines.slice(top, top + slots)
      const up = top > 0 ? '▲' : ' '
      const dn = top + slots < total ? '▼' : ' '
      const label = s.activeIsClaude ? 'You said' : 'Will run'
      const out = [line(`${label} ${up}${dn}  tap=SEND ◀◀=redo`, 'normal'), ...win.map((l) => line(l, 'meta'))]
      if (s.status) out.push(line(s.status, 'meta')) // surface send/translate failures
      return { lines: out }
    }
    // MENU MODE: the pane is asking for approval. READ first (see the full command/diff,
    // scrollable), then PICK the option — so you never approve something you can't see.
    if (s.menu) {
      const m = s.menu
      if (s.menuPhase === 'read') {
        const body = s.menuBody.length ? s.menuBody : [m.question || 'approve?']
        const top = Math.max(0, Math.min(s.menuScroll, Math.max(0, body.length - DETAIL_SLOTS)))
        const win = body.slice(top, top + DETAIL_SLOTS)
        const up = top > 0 ? '▲' : ' '
        const dn = top + DETAIL_SLOTS < body.length ? '▼' : ' '
        const head = `read ${up}${dn}  swipe · tap=${m.ask ? 'answer' : 'choose'} · ◀◀=back`
        return { lines: [line(truncateGlassText(head), 'normal'), ...win.map((l) => line(truncateGlassText(l), 'meta'))] }
      }
      // PICK: choose the option (▶ marks the selection; columns mode flattens the style).
      const items = menuRows(s)
      const hi = Math.max(0, Math.min(nav.highlightedIndex, items.length - 1))
      // show the question (≤2 wrapped lines) ABOVE the options so you don't have to go back to READ
      // just to recall it; the option window shrinks so the total stays within the line budget.
      const qLines = m.question ? wrapLines(m.question, 2) : []
      const budget = 9 - qLines.length            // display lines available for options (header takes 1)
      // Wrap each option onto as many lines as it needs — long labels used to get truncated to one line.
      // Flatten to display lines tagged with their selected state, then window the LINES around the
      // highlighted option (not whole rows) so a long highlighted option stays visible; every line of an
      // option shares its ▶ / inverted style. Continuation lines hang-indent under the marker.
      const dl: { text: string; sel: boolean }[] = []
      items.forEach((r, i) => {
        const sel = i === hi
        const segs = wrapLines(r.text, 6, 544)    // 544 leaves ~24px for the ▶/indent prefix
        ;(segs.length ? segs : ['']).forEach((seg, j) => dl.push({ text: (j === 0 ? (sel ? '▶ ' : '   ') : '   ') + seg, sel }))
      })
      const hiFirst = Math.max(0, dl.findIndex((d) => d.sel))
      const start = Math.min(Math.max(0, hiFirst - 1), Math.max(0, dl.length - budget))
      const winLines = dl.slice(start, start + budget)
      // AskUserQuestion: tag the header so the user knows it's multi-step (answer each, then submit).
      const verb = m.ask ? 'answer' : 'pick'
      const arrows = `${start > 0 ? '▲' : ''}${start + budget < dl.length ? '▼' : ''}`
      const head = s.status ? `${verb}  ${s.status}` : `${verb} ${hi + 1}/${items.length} ${arrows} ◀◀=read`
      const out = [line(truncateGlassText(head), 'normal'), ...qLines.map((l) => line(truncateGlassText(l), 'normal'))]
      winLines.forEach((d) => out.push(line(truncateGlassText(d.text), d.sel ? 'inverted' : 'meta')))
      return { lines: out }
    }
    // view: ONE header row carrying title + scroll arrows + position + tap hint, then 9 content
    // lines (no separate footer — that frees a whole row for the conversation). claude pane =>
    // replies only; shell pane => live screen. A transient status (send/translate error) takes over
    // the header row when present.
    const slots = VIEW_SLOTS
    // allow top up to len-1 (not just len-slots) so a jump-to-prompt can place the latest prompt
    // at the TOP even when it's within the last few lines (window then shows it + blanks below)
    const top = Math.max(0, Math.min(s.scroll, Math.max(0, s.lines.length - 1)))
    const win = s.lines.slice(top, top + slots)
    const up = top > 0 ? '▲' : ' '
    const dn = top + slots < s.lines.length ? '▼' : ' '
    const wk = s.working ? ' ●' : ''  // ● = working, as in the list (⋯ is not in the G2 font, it drew blank)
    const talk = s.voiceOn ? 'tap=talk' : 'tap=type'
    const pos = s.lines.length > slots ? ` ${Math.min(top + slots, s.lines.length)}/${s.lines.length}` : ''
    const head = s.status ? `${title}  ${s.status}` : `${title}${wk}  ${up}${dn}${pos}  ${talk}`
    return { lines: [
      line(truncateGlassText(head), 'normal'),
      ...win.map((l) => line(truncateGlassText(l), 'meta')),
    ] }
  },
  action(a, nav, s, ctx) {
    if (!s.activePaneN) return { screen: 'list', highlightedIndex: 0 } // pane closed under us -> eject
    if (s.phase === 'listening') {
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.stopVoice()
      else if (a.type === 'GO_BACK') ctx.cancelInput()
      return nav
    }
    if (s.phase === 'confirm') {
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.sendNow()
      else if (a.type === 'HIGHLIGHT_MOVE') ctx.scrollConfirm(a.direction)  // swipe = scroll the transcript
      else if (a.type === 'GO_BACK') ctx.redoVoice()                        // double-tap = back to recording (redo)
      return nav
    }
    // MENU MODE: READ the command (swipe to scroll, tap to choose, double-tap to leave),
    // then PICK (swipe highlights an option, tap picks/toggles, double-tap back to READ).
    if (s.menu) {
      if (s.menuPhase === 'read') {
        if (a.type === 'HIGHLIGHT_MOVE') { ctx.scrollMenu(a.direction); return nav }
        if (a.type === 'SELECT_HIGHLIGHTED') { ctx.menuToPick(); return { ...nav, highlightedIndex: s.menu.cursorIndex } }
        if (a.type === 'GO_BACK') { ctx.closePane(); return { screen: 'list', highlightedIndex: listRow(s) } }
        return nav
      }
      const rows = menuRows(s)
      // a swipe only moves the LOCAL ▶ highlight; the tap (pickMenuOption) then moves the prompt's ❯
      // to it in one batch (robust to the G2 pad emitting a burst of swipe events).
      if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: moveHighlight(nav.highlightedIndex, a.direction, rows.length - 1) }
      if (a.type === 'SELECT_HIGHLIGHTED') {
        const hi2 = Math.max(0, Math.min(nav.highlightedIndex, rows.length - 1))
        const row = rows[hi2]
        if (row?.kind === 'submit') ctx.submitMenu()
        else if (row?.kind === 'next') ctx.menuTabNext()
        else ctx.pickMenuOption(row?.idx ?? hi2)
        // do NOT advance the ▶ highlight on a toggle: the prompt's ❯ cursor STAYS on the toggled row
        // (verified on-device — Space doesn't auto-advance), so ▶ must stay too or they desync and
        // every later swipe lands one off. Move to the next item with a swipe.
        return nav
      }
      if (a.type === 'GO_BACK') { ctx.menuToRead(); return nav }
      return nav
    }
    // view
    if (a.type === 'HIGHLIGHT_MOVE') { ctx.scrollDetail(a.direction); return nav }
    if (a.type === 'SELECT_HIGHLIGHTED') { ctx.startVoice(); return nav }
    // double-tap returns you toward the live edge first (latest prompt -> bottom), then leaves
    if (a.type === 'GO_BACK') {
      if (ctx.jumpToLatest()) return nav
      ctx.closePane(); return { screen: 'list', highlightedIndex: listRow(s) }
    }
    return nav
  },
}

const newScreen: GlassScreen<AppState, Ctx> = {
  display(s): DisplayData {
    if (s.newPhase === 'busy')
      return { lines: [...glassHeader('NEW SESSION'), line(s.newStatus || 'working…', 'normal')] }
    if (s.newPhase === 'done')
      return { lines: [
        ...glassHeader('NEW SESSION', 'tap=open ◀◀=list'),
        line('» Claude → ' + (s.newStatus || 'created'), 'normal'),
        ...wrap(s.newPath, 42).slice(0, 3).map((l) => line(l, 'meta')),
      ] }
    if (s.newPhase === 'tag') {
      // step 1: pick the project tag (window) — row 0 = new tag, then existing windows
      const rows = ['＋ New tag ' + (s.voiceOn ? '(speak)' : '(type)'), ...s.newTags]
      const hi = Math.max(0, Math.min(s.newTagIndex, rows.length - 1))
      const SLOTS = 9
      const top = Math.min(Math.max(0, hi - 3), Math.max(0, rows.length - SLOTS))
      const up = top > 0 ? '▲' : ' '
      const dn = top + SLOTS < rows.length ? '▼' : ' '
      const out = [line(`${up}${dn} ${hi + 1}/${rows.length} tap=pick ◀◀=back`, 'normal')]
      rows.slice(top, top + SLOTS).forEach((t, i) => {
        const sel = top + i === hi
        out.push(line(truncateGlassText(`${sel ? '▶ ' : '   '}${t}`), sel ? 'inverted' : 'meta'))
      })
      // surface loading/failure so an empty tag list isn't mistaken for "no tags exist"
      if (s.newStatus) out.push(line(s.newStatus, 'meta'))
      return { lines: out }
    }
    if (s.newPhase === 'tagvoice')
      return { lines: [
        ...glassHeader('NEW TAG', s.typingText ? 'TYPING' : (s.voiceOn ? 'tap=done ◀◀=back' : 'type on phone ◀◀=back')),
        line('● ' + (s.typingText ? truncateGlassText(s.typingText) : (s.newStatus || (s.voiceOn ? 'Speak the tag name…' : 'Type the tag name on your phone…'))), 'normal'),
        line('e.g. "api", "web", "infra"', 'meta'),
      ] }
    if (s.newPhase === 'confirm') {
      const out = [...glassHeader('NEW SESSION', 'tap=create ◀◀=cancel'), line(`tag:  ${s.newTag || '(new window by folder)'}`, 'normal'),
        line(s.newCreate ? 'folder (NEW — will be created):' : 'folder:', s.newCreate ? 'normal' : 'meta')]
      out.push(...wrap(s.newPath, 42).slice(0, 4).map((l) => line(l, 'normal')))
      if (s.newStatus) out.push(line(s.newStatus, 'meta'))
      return { lines: out }
    }
    // listening (folder)
    return { lines: [
      ...glassHeader(s.newTag ? `tag: ${clip(s.newTag, 12)}` : 'NEW SESSION', s.typingText ? 'TYPING' : (s.voiceOn ? 'tap=done ◀◀=back' : 'type on phone ◀◀=back')),
      line('● ' + (s.typingText ? truncateGlassText(s.typingText) : (s.newStatus || (s.voiceOn ? 'Speak the folder…' : 'Type the folder on your phone…'))), 'normal'),
      line('e.g. "my-project", "notes"', 'meta'),
    ] }
  },
  action(a, nav, s, ctx) {
    if (s.newPhase === 'tag') {
      if (a.type === 'HIGHLIGHT_MOVE') { ctx.moveNewTag(a.direction); return nav }
      if (a.type === 'SELECT_HIGHLIGHTED') { ctx.chooseNewTag(); return nav }
      if (a.type === 'GO_BACK') { ctx.cancelNewSession(); return { screen: 'list', highlightedIndex: 0 } }
      return nav
    }
    if (s.newPhase === 'tagvoice') {
      if (a.type === 'SELECT_HIGHLIGHTED') { if (s.newStatus.includes('retry')) ctx.retryNewVoice(); else ctx.stopNewTagVoice() }
      else if (a.type === 'GO_BACK') { ctx.cancelNewSession(); return { screen: 'list', highlightedIndex: 0 } }
      return nav
    }
    if (s.newPhase === 'listening') {
      if (a.type === 'SELECT_HIGHLIGHTED') { if (s.newStatus.includes('retry')) ctx.retryNewVoice(); else ctx.stopNewVoice() }
      else if (a.type === 'GO_BACK') { ctx.cancelNewSession(); return { screen: 'list', highlightedIndex: 0 } }
      return nav
    }
    if (s.newPhase === 'confirm') {
      if (a.type === 'SELECT_HIGHLIGHTED') ctx.createNewSession()
      else if (a.type === 'GO_BACK') { ctx.cancelNewSession(); return { screen: 'list', highlightedIndex: 0 } }
      return nav
    }
    if (s.newPhase === 'done') {
      if (a.type === 'SELECT_HIGHLIGHTED' && s.newPaneN) {
        const p = s.panes.find((x) => x.n === s.newPaneN)
        ctx.openPane(s.newPaneN, p?.label || 'new', true, p?.cwd || s.newPath)
        return { screen: 'detail', highlightedIndex: 0 }
      }
      if (a.type === 'GO_BACK') { ctx.cancelNewSession(); return { screen: 'list', highlightedIndex: 0 } }
      return nav
    }
    return nav // busy: swallow input
  },
}

export const router = createGlassScreenRouter<AppState, Ctx>({ list: listScreen, detail: detailScreen, new: newScreen }, 'list')
