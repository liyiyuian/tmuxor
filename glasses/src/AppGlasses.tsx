import { useEffect, useSyncExternalStore } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { EvenAppBridge, OsEventTypeList, pickLoose, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  getSnapshot, subscribe, refresh, noteActivity, idleTick,
  listRows, listRow, selectRow, togglePin, toggleShortView, jumpToAttention,
  openPane, closePane, scrollDetail, startVoice, stopVoice, cancelInput,
  redoVoice, sendNow, scrollConfirm,
  pickMenuOption, menuTabNext, submitMenu, scrollMenu, menuToPick, menuToRead, jumpToLatest,
  startNewSession, moveNewTag, chooseNewTag, stopNewTagVoice, stopNewVoice, retryNewVoice, createNewSession, cancelNewSession,
  type AppState,
} from './store'
import { router, listPreview, type Ctx } from './screens'
import { getConfig } from './config'
import { line, type GlassNavState } from 'even-toolkit/types'

// root double-tap -> hand off to the foreground layer's system exit dialog (exitMode 1)
const exitApp = () => { waitForEvenAppBridge().then((b) => b.shutDownPageContainer(1)).catch(() => {}) }

// --- shared-bridge hooks (the same singleton even-toolkit drives) ---
const bridge = EvenAppBridge.getInstance()

// even-toolkit maps an event with NO eventType to a tap (a click's type is 0, which the host omits).
// An event type this SDK build doesn't know ALSO parses to "no type" — that is how a long-press
// arrived as a tap on SDK 0.0.11 and approved the highlighted option. Drop anything the SDK can't
// name before any listener (even-toolkit's included) sees it, so a future gesture can't do the same.
const listen = bridge.onEvenHubEvent.bind(bridge)

// Gesture trace — DIAGNOSTIC BUILDS ONLY (VITE_TRACE=1 at build time; a normal build compiles it
// out). Posts what the glasses send for each gesture, and what the app made of it, to the backend's
// journal: event shapes and numbers, never text. Bounded: TRACE_MAX lines per launch, at most one
// small POST a second, and only when there is something to send.
const TRACE = !!import.meta.env.VITE_TRACE
const TRACE_MAX = 300
let traceBuf: string[] = [], traceN = 0, traceAt = Date.now()
function trace(s: string) {
  if (!TRACE || traceN >= TRACE_MAX) return
  const now = Date.now(); traceBuf.push(`+${now - traceAt}ms ${s}`); traceAt = now; traceN++
}
const shape = (v: unknown, k = '', d = 0): unknown =>
  typeof v === 'string' ? (/type|source/i.test(k) && v.length <= 40 ? v : `str${v.length}`)
    : Array.isArray(v) ? `arr${v.length}`
      : v && typeof v === 'object' ? (d > 3 ? 'obj' : Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, shape(x, kk, d + 1)])))
        : v
if (TRACE) {
  listen((e) => {
    if (e.audioEvent) return
    const ev = e.listEvent ?? e.textEvent ?? e.sysEvent
    trace(`EVENT ${e.listEvent ? 'list' : e.textEvent ? 'text' : e.sysEvent ? 'sys' : 'other'} type=${ev?.eventType} raw=${JSON.stringify(shape(e.jsonData ?? e))}`)
  })
  setInterval(() => {
    if (!traceBuf.length) return
    const c = getConfig(), msg = `TRACE build ${__BUILD__}\n` + traceBuf.splice(0).join('\n')
    if (c.base && c.token) fetch(`${c.base}/api/clientlog`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {})
  }, 1000)
}
bridge.onEvenHubEvent = (cb) => listen((e) => {
  const ev = e.listEvent ?? e.textEvent ?? e.sysEvent
  if (ev && ev.eventType == null) {
    const raw = pickLoose(e.jsonData ?? {}, 'eventType')
    if (raw != null && OsEventTypeList.fromJson(raw) === undefined) return
  }
  // Press and hold (SDK 0.0.14+) is NOT a usable gesture on the real G2 (traced on the glasses,
  // 2026-10-12): they send an ordinary tap first and the hold event only 0.7-0.9 s later, so the
  // tap has already acted by the time a hold could be recognised. Swallow the hold and its release
  // so they are never read as anything else; extra actions go in the system menu below instead.
  if (ev?.eventType === OsEventTypeList.LONG_PRESS_EVENT || ev?.eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return
  cb(e)
})

// Contextual menu (SDK 0.0.14+): the OS overlay raised by tap-then-hold. even-toolkit builds every
// page itself with no menu hook, and the host REPLACES the menu on each build (omitting it clears
// it) — so carry our actions on every page build. On an older Even app this is a silent no-op.
// The labels are fixed (they only change with a page build), so each is one plain verb; an item
// that does not apply where you are does nothing.
const MENU_PIN = 1, MENU_NEXT = 2, MENU_VIEW = 3
const menuObject = { menuItems: [
  { itemName: 'Next that needs you', itemID: MENU_NEXT },
  { itemName: 'Condensed / full reply', itemID: MENU_VIEW },
  { itemName: 'Pin / unpin session', itemID: MENU_PIN },
] }
// what each text container on the glasses currently shows (see the dedup below); a page build
// replaces the containers, so it empties this
const shown = new Map<number, string>()
for (const m of ['createStartUpPageContainer', 'rebuildPageContainer'] as const) {
  const build = (bridge[m] as (c: object) => Promise<unknown>).bind(bridge)
  ;(bridge as unknown as Record<string, unknown>)[m] = (c: object) => { shown.clear(); return build(Object.assign(c, { menuObject })) }
}

// even-toolkit re-sends EVERY column on every display update, changed or not (its setContent always
// marks the element dirty). With the list's second column that doubled the Bluetooth writes per
// frame, and an unchanged screen was re-sent whenever any state changed (e.g. each 5s poll). Send a
// container's text only when it differs from what the glasses already show — measured in the sim, a
// 5-swipe burst went from 24 bridge calls to about what it was before the preview existed.
const upgrade = bridge.textContainerUpgrade.bind(bridge)
bridge.textContainerUpgrade = async (u) => {
  const id = Number(u.containerID), sig = `${u.contentOffset ?? 0}|${u.contentLength ?? ''}|${u.content ?? ''}`
  if (shown.get(id) === sig) return true
  shown.delete(id)  // unknown until this send succeeds
  const ok = await upgrade(u)
  if (ok) shown.set(id, sig)
  return ok
}
// The menu click arrives outside even-toolkit's action pipeline, so track where the glasses are.
let lastNav: GlassNavState = { screen: 'list', highlightedIndex: 0 }
// A pick from the system menu. Pin / unpin: the open session, else the highlighted list row.
// Next that needs you: in the list, the next waiting session below the highlight (else the top).
// Condensed / full reply: the open session's latest reply (when Condensed replies is on).
function onMenu(id?: number) {
  if (id !== MENU_PIN && id !== MENU_NEXT && id !== MENU_VIEW) return
  const s = getSnapshot()
  noteActivity()
  if (id === MENU_NEXT) { if (!s.activePaneN && lastNav.screen === 'list') jumpToAttention() }
  else if (id === MENU_VIEW) toggleShortView()
  else { const n = s.activePaneN ?? (lastNav.screen === 'list' ? listRows(s)[listRow(s)] : ''); if (n) togglePin(n) }
}

const ctx: Ctx = {
  exitApp,
  selectRow,
  openPane, closePane, scrollDetail, startVoice, stopVoice, cancelInput,
  redoVoice, sendNow, scrollConfirm,
  pickMenuOption, menuTabNext, submitMenu, scrollMenu, menuToPick, menuToRead, jumpToLatest,
  startNewSession, moveNewTag, chooseNewTag, stopNewTagVoice, stopNewVoice, retryNewVoice, createNewSession, cancelNewSession,
}

export function App() {
  useSyncExternalStore(subscribe, getSnapshot) // re-render -> re-push glasses display on store change

  useEffect(() => {
    refresh()
    // poll the fleet only while the list is showing — while a pane is open the
    // conversation has its own poll, so skip ~30 capture-pane subprocesses/5s.
    const t = setInterval(() => { const s = getSnapshot(); if (!s.activePaneN || s.asleep) refresh() }, 5000)
    const sleepTimer = setInterval(idleTick, 1000)  // blank the HUD once the idle timeout passes
    // When (re)launched — from the phone app menu OR the glasses menu — pull a fresh
    // fleet immediately so you don't wait for the next poll.
    let unsub: (() => void) | undefined
    let unsubMenu: (() => void) | undefined
    waitForEvenAppBridge()
      .then((b) => {
        unsub = b.onLaunchSource(() => { refresh() })
        unsubMenu = b.onEvenHubEvent((e) => onMenu(e.menuItemClickEvent?.itemID))
      })
      .catch(() => {})
    // full teardown (SSE stream, conversation poll, mic) if App ever unmounts
    return () => { clearInterval(t); clearInterval(sleepTimer); unsub?.(); unsubMenu?.(); closePane() }
  }, [])

  useGlasses<AppState>({
    appName: 'G2C',
    getSnapshot,
    // column 1 = the whole screen (flush-left, no 2-space prefix); column 2 overlaps its right two
    // thirds and carries only the list's preview (blank on every other screen — see listPreview).
    columns: [{ x: 0, w: 576 }, { x: 192, w: 384 }],
    // asleep -> push a blank (single space) so the HUD goes dark; wake on the next gesture.
    toDisplayData: (s, nav) => (s.asleep ? { lines: [line(' ', 'meta')] } : router.toDisplayData(s, nav)),
    toColumns: (s, nav) => (s.asleep ? { columns: [' ', ' '] } : { columns: [router.toDisplayData(s, nav).lines.map((l) => l.text).join('\n'), listPreview(s, nav.screen)] }),
    onGlassAction: (a, nav, s) => {
      trace(`APP action ${a.type}${'direction' in a ? ' ' + a.direction : ''} on ${nav.screen}`)
      const wasAsleep = getSnapshot().asleep
      noteActivity()              // any gesture resets the idle timer (and wakes a sleeping HUD)
      if (wasAsleep) return nav   // the waking gesture only wakes — it doesn't also act
      return (lastNav = router.onGlassAction(a, nav, s, ctx))
    },
    deriveScreen: () => 'list',
    // Columns mode for: the session LIST, the live detail VIEW, and the REVIEW transcript.
    // The list MUST be columns, not the home/text page — on the real G2 a home-page text
    // container does not forward swipe->scroll events to the app (taps work, scroll doesn't),
    // so a long fleet couldn't scroll; columns mode forwards them (same as the detail view).
    // The selected row is shown by a ▶ marker (screens.ts), since columns flattens line styles.
    // Styled text mode stays for the menu + the new-session input screens.
    getPageMode: (screen) => {
      const s = getSnapshot()
      if (screen === 'list') return 'columns'
      if (!s.activePaneN) return 'text'        // new-session input screens
      if (s.menu) return 'columns'             // permission prompt: READ-scroll + PICK-move need swipe
      if (s.phase === 'view') return 'columns'
      if (s.phase === 'confirm' && !s.busy) return 'columns'
      return 'text'                            // listening / confirm-busy
    },
  })

  return null
}
