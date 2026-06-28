// Control state machine: list <-> detail; detail phases view/listening/confirm.
// In 'view', if the pane is showing an option menu, render a clean selectable list (menu mode).
import { line, glassHeader, type DisplayData } from 'even-toolkit/types'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { moveHighlight } from 'even-toolkit/glass-nav'
import { truncateGlassText } from 'even-toolkit/pretext'
import { createGlassScreenRouter, type GlassScreen } from 'even-toolkit/glass-screen-router'
import type { AppState } from './store'
import type { Pane } from './api'

export interface Ctx {
  exitApp: () => void
  openPane: (n: string, label: string, isClaude: boolean, cwd: string, listIndex: number) => void
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
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const DETAIL_SLOTS = 9
const VIEW_SLOTS = 8  // conversation/shell view: header + 8 content + 1 footer (must match store VIEW_SLOTS)

function wrap(s: string, n: number): string[] {
  const out: string[] = []
  let r = s
  while (r.length > n) { out.push(r.slice(0, n)); r = r.slice(n) }
  out.push(r)
  return out
}

// rows in menu mode = options (+ a Submit row when multi-select)
const menuRowCount = (s: AppState) => (s.menu ? s.menu.options.length + (s.menu.multi ? 1 : 0) : 0)

const listScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    if (s.loading) return { lines: [...glassHeader('TMUXor'), line('loading…', 'meta')] }
    if (s.error) return { lines: [...glassHeader('TMUXor'), line('offline', 'meta'), line(clip(s.error, 26), 'meta')] }
    const wait = s.panes.filter((p) => p.status === 'waiting').length
    const work = s.panes.filter((p) => p.status === 'working').length
    const idle = Math.max(0, s.panes.length - work - wait)
    // one consistent bar; drop zero fields instead of hiding idle when busy
    const bar = [wait && `${wait}! need you`, work && `${work}● working`, idle && `${idle}○ idle`].filter(Boolean).join(' · ') || 'no sessions'
    // row 0 is a pinned "＋ new session" action; panes follow (null = the new-session row)
    const items: (Pane | null)[] = [null, ...s.panes]
    const VIS = 8
    const pages = Math.max(1, Math.ceil(items.length / VIS))
    const page = Math.min(pages, Math.floor(nav.highlightedIndex / VIS) + 1)
    const list = buildScrollableList({
      items,
      highlightedIndex: nav.highlightedIndex,
      maxVisible: VIS,
      // tag (project) first — it's the disambiguator across ~35 sessions; only the long title clips.
      // ▶ marks the selected row by TEXT (columns page mode flattens the line highlight style); the
      // 3-space else keeps rows aligned. Marker is inside truncateGlassText so width still fits ~568px.
      formatter: (it, i) =>
        truncateGlassText(`${i === nav.highlightedIndex ? '▶ ' : '   '}${it ? `${GLYPH[it.status] ?? '·'} ${it.tag}  ${it.label}` : '＋ new session'}`),
    })
    return { lines: [...glassHeader(`PANELS ${s.panes.length} · p${page}/${pages}`, bar), ...list] }
  },
  action(a, nav, s, ctx) {
    const total = s.panes.length + 1 // indices 0..panes.length (row 0 = new-session)
    if (a.type === 'HIGHLIGHT_MOVE') {
      // wrap around: swipe up from the first row jumps to the last, and vice versa —
      // the fast way to reach the far end of a long fleet without a page-jump gesture.
      const delta = a.direction === 'up' ? -1 : 1
      return { ...nav, highlightedIndex: (nav.highlightedIndex + delta + total) % total }
    }
    if (a.type === 'SELECT_HIGHLIGHTED') {
      if (nav.highlightedIndex === 0) { ctx.startNewSession(); return { screen: 'new', highlightedIndex: 0 } }
      const p = s.panes[nav.highlightedIndex - 1]
      if (p) {
        ctx.openPane(p.n, p.label, p.is_claude, p.cwd, nav.highlightedIndex)
        return { screen: 'detail', highlightedIndex: 0 }
      }
    }
    if (a.type === 'GO_BACK') { ctx.exitApp(); return nav } // root double-tap = system exit dialog
    return nav
  },
}

const detailScreen: GlassScreen<AppState, Ctx> = {
  display(s, nav): DisplayData {
    const title = clip(s.activeLabel || 'session', 18)
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
      // full-bleed, scrollable transcript (rendered in columns mode → no left margin)
      const total = s.draftLines.length
      const top = Math.max(0, Math.min(s.confirmScroll, Math.max(0, total - DETAIL_SLOTS)))
      const win = s.draftLines.slice(top, top + DETAIL_SLOTS)
      const up = top > 0 ? '▲' : ' '
      const dn = top + DETAIL_SLOTS < total ? '▼' : ' '
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
        const head = `approve? ${up}${dn}  swipe=read · tap=choose · ◀◀=back`
        return { lines: [line(truncateGlassText(head), 'normal'), ...win.map((l) => line(truncateGlassText(l), 'meta'))] }
      }
      // PICK: choose the option (▶ marks the selection; columns mode flattens the style).
      const rows = menuRowCount(s)
      const hi = Math.max(0, Math.min(nav.highlightedIndex, rows - 1))
      const items = m.options.map((o, i) => ({
        text: m.multi ? `${o.checked ? '[x]' : '[ ]'} ${o.title}` : `${o.num}. ${o.title}`,
        sel: i === hi,
      }))
      if (m.multi) items.push({ text: '▸ Submit', sel: hi === m.options.length })
      const SLOTS = 9
      const top = Math.min(Math.max(0, hi - 3), Math.max(0, items.length - SLOTS))
      const win = items.slice(top, top + SLOTS)
      const up = top > 0 ? '▲' : ' '
      const dn = top + SLOTS < items.length ? '▼' : ' '
      const head = `pick ${up}${dn} ${hi + 1}/${items.length}  tap=select · ◀◀=read${m.question ? '  ' + m.question : ''}`
      const out = [line(truncateGlassText(head), 'normal')]
      win.forEach((r) => out.push(line(truncateGlassText(`${r.sel ? '▶ ' : '   '}${r.text}`), r.sel ? 'inverted' : 'meta')))
      return { lines: out }
    }
    // view: header (session title) + 8 content lines + a footer (gesture hints + scroll position).
    // claude pane => replies only; shell pane => live screen. A transient status (send/translate
    // error) rides in the footer so the scrollable content area stays a fixed 8 lines.
    const slots = VIEW_SLOTS
    const top = Math.max(0, Math.min(s.scroll, Math.max(0, s.lines.length - slots)))
    const win = s.lines.slice(top, top + slots)
    const up = top > 0 ? '▲' : ' '
    const dn = top + slots < s.lines.length ? '▼' : ' '
    const wk = s.working ? ' ⋯' : ''
    const talk = s.voiceOn ? 'tap=talk' : 'tap=type'
    const pos = s.lines.length > slots ? `  ${Math.min(top + slots, s.lines.length)}/${s.lines.length}` : ''
    const footer = s.status || `${up}${dn} ${talk} · ◀◀${pos}`
    return { lines: [
      line(truncateGlassText(`${title}${wk}`), 'normal'),
      ...win.map((l) => line(truncateGlassText(l), 'meta')),
      line(truncateGlassText(footer), 'meta'),
    ] }
  },
  action(a, nav, s, ctx) {
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
        if (a.type === 'GO_BACK') { ctx.closePane(); return { screen: 'list', highlightedIndex: s.listIndex } }
        return nav
      }
      const rows = menuRowCount(s)
      if (a.type === 'HIGHLIGHT_MOVE') return { ...nav, highlightedIndex: moveHighlight(nav.highlightedIndex, a.direction, rows - 1) }
      if (a.type === 'SELECT_HIGHLIGHTED') {
        if (s.menu.multi && nav.highlightedIndex === s.menu.options.length) ctx.submitMenu()
        else ctx.pickMenuOption(nav.highlightedIndex)
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
      ctx.closePane(); return { screen: 'list', highlightedIndex: s.listIndex }
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
        line('✓ Claude → ' + (s.newStatus || 'created'), 'normal'),
        ...wrap(s.newPath, 42).slice(0, 3).map((l) => line(l, 'meta')),
      ] }
    if (s.newPhase === 'tag') {
      // step 1: pick the project tag (window) — row 0 = new tag, then existing windows
      const rows = ['＋ New tag (speak)', ...s.newTags]
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
        ctx.openPane(s.newPaneN, p?.label || 'new', true, p?.cwd || s.newPath, 0)
        return { screen: 'detail', highlightedIndex: 0 }
      }
      if (a.type === 'GO_BACK') { ctx.cancelNewSession(); return { screen: 'list', highlightedIndex: 0 } }
      return nav
    }
    return nav // busy: swallow input
  },
}

export const router = createGlassScreenRouter<AppState, Ctx>({ list: listScreen, detail: detailScreen, new: newScreen }, 'list')
