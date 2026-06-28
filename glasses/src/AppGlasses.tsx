import { useEffect, useSyncExternalStore } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  getSnapshot, subscribe, refresh, noteActivity, idleTick,
  openPane, closePane, scrollDetail, startVoice, stopVoice, cancelInput,
  redoVoice, sendNow, scrollConfirm,
  pickMenuOption, submitMenu, scrollMenu, menuToPick, menuToRead, jumpToLatest,
  startNewSession, moveNewTag, chooseNewTag, stopNewTagVoice, stopNewVoice, retryNewVoice, createNewSession, cancelNewSession,
  type AppState,
} from './store'
import { router, type Ctx } from './screens'
import { line } from 'even-toolkit/types'

// root double-tap -> hand off to the foreground layer's system exit dialog (exitMode 1)
const exitApp = () => { waitForEvenAppBridge().then((b) => b.shutDownPageContainer(1)).catch(() => {}) }

const ctx: Ctx = {
  exitApp,
  openPane, closePane, scrollDetail, startVoice, stopVoice, cancelInput,
  redoVoice, sendNow, scrollConfirm,
  pickMenuOption, submitMenu, scrollMenu, menuToPick, menuToRead, jumpToLatest,
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
    waitForEvenAppBridge()
      .then((b) => { unsub = b.onLaunchSource(() => { refresh() }) })
      .catch(() => {})
    // full teardown (SSE stream, conversation poll, mic) if App ever unmounts
    return () => { clearInterval(t); clearInterval(sleepTimer); unsub?.(); closePane() }
  }, [])

  useGlasses<AppState>({
    appName: 'TMUXor',
    getSnapshot,
    columns: [{ x: 0, w: 576 }], // single full-width column => flush-left, no 2-space prefix
    // asleep -> push a blank (single space) so the HUD goes dark; wake on the next gesture.
    toDisplayData: (s, nav) => (s.asleep ? { lines: [line(' ', 'meta')] } : router.toDisplayData(s, nav)),
    toColumns: (s, nav) => (s.asleep ? { columns: [' '] } : { columns: [router.toDisplayData(s, nav).lines.map((l) => l.text).join('\n')] }),
    onGlassAction: (a, nav, s) => {
      const wasAsleep = getSnapshot().asleep
      noteActivity()              // any gesture resets the idle timer (and wakes a sleeping HUD)
      if (wasAsleep) return nav   // the waking gesture only wakes — it doesn't also act
      return router.onGlassAction(a, nav, s, ctx)
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
