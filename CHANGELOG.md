# Changelog — G2C (formerly TMUXor)

User-facing changes per version. Newest first. Deeper technical notes live in the
project memory; this file is the short "what changed" for each build.

> Builds: G2C ships as a single **public** `.ehpk` — it bakes no secrets, so every user
> enters their own backend URL + token on the app's Setup screen.

## 1.0.41 — 2026-10-12
- **The list follows your layout.** Sessions are now in your multiplexer's own order — Herdr
  workspaces, then tabs (tmux: windows, then panes) — with pinned ones on top. Before, they were
  re-sorted by status, so a session kept moving. Status is still the mark on each row and the
  counts in the header.
- **Codex sessions.** Codex CLI sessions now appear in the list, named after their Herdr tab, with
  the same preview and reading view. Needs the updated backend. Answering a Codex approval prompt
  from the glasses has not been tested.
- **New status marks.** **○** idle, **»** working, **●** finished since you last opened it, **!**
  needs you; a Codex session uses **◇** and **◆**. (Working and finished swapped marks.)
- **Herdr only.** G2C is now built and documented for Herdr. The phone no longer offers a backend
  picker, and the backend reads Herdr by default.
- **Settings on one page.** "Connection & settings" is always open, and the list of sessions to
  pin (★) now lives inside it.
- **Installer fixes.** `install.sh` now also downloads `sources.py` (without it a fresh install could
  not start), checks for Herdr instead of tmux, tells the service where the `herdr` binary is, and
  keeps lines you added to the settings file (such as `ANTHROPIC_API_KEY`) when it is re-run.
- **Choose which workspaces to show.** The phone's settings list your workspaces with a tick each
  (all on by default); untick one and its sessions are left off the glasses.
- **Optional condensed replies (off by default).** A second switch in the phone's settings,
  "Condense the latest reply with Claude Haiku": opening a session then shows its latest reply as
  about one screen (marked `＊`), leading with anything it is waiting on you for and keeping the
  exact names, numbers and commands. While it is being written the view says "＊ condensing…" above
  the full reply. Earlier replies, short replies and approval prompts are never condensed; switch it
  off to read the full reply. Same rules as the preview summaries: your own Anthropic key on your
  backend, once per reply, never while the session is working. Needs the updated backend.
- **Fix: summaries garbled names.** Cleaning the model's text removed every `_`, `*`, `#` and `>`,
  so `rotate_token()` became `rotatetoken()` and `a -> b` became `a - b`. Only markdown marks are
  removed now.
- **Better instructions for the model.** Summaries and condensed replies now give the answer or
  outcome itself instead of describing it, start with "Needs you:" only when the session really is
  waiting on you, list choices only when the reply offers them (they are never invented), and are
  cut at a word, not mid-word, when they run long.
- **A new mark for model-written text.** It starts with `＊` (the closest the glasses font has to
  Claude's spark) instead of `~`.
- **Pinned sessions** show their workspace letter in CAPITALS on the glasses instead of a ★ in
  front (the glasses font has no bold); on the phone a pinned row is bold.
- **Settings redesigned.** What you use most is on top, and every setting is a button: tap a
  session to pin it, tap a workspace to hide it, tap a row to switch something on or off. Short
  one-line hints replace the long explanations. The connection form folds away once you are
  connected. The session list no longer scrolls inside the page (that could trap the page on a
  phone); it shows six and expands in place.
- **Plan usage above the list.** The line under the header shows how much of your Claude and
  Codex plans is used, as battery-style blocks: per account the 5-hour window, then the week
  (filled = used). The phone shows the exact percentages and has a switch for it. The backend reads
  this from local files only: your newest Codex session, and for Claude a small status-line helper
  (`g2c_usage_hook.py`, see SETUP.md). Needs the updated backend.
- **API cost.** The settings page shows what your backend's own API calls cost today and over the
  last 7 days, by provider and model, at list prices (your Claude or Codex subscription is not
  part of this). Needs the updated backend.
- **Shorter rows beside the preview.** With the preview on, a row shows only the first letter of
  its workspace, so more of the session's name fits; the preview's title shows the whole name.
- **Fix: a session attached to a background session showed the wrong conversation.** When a pane's
  Claude was a front end for a background session running elsewhere, the glasses read a different
  session under that pane and never updated. The backend now follows Herdr's session id, or the
  pane's title, to the session actually on screen.
- **A page the Even app has let go of goes quiet.** After the app is closed or reopened the Even
  app keeps the old page alive; that page now stops polling instead of failing over and over, and
  the event is no longer shown as "Last app error".
- **Queued prompts.** A prompt you send while the agent is busy waits in its queue; the reading
  view now shows one line per waiting prompt ("◇ queued: …") until the agent takes it up.
- **The preview says when more is coming.** Its rule shows "loading…", "updating…" or
  "summarizing…" while newer text is on the way, so you don't start reading something that is about
  to be replaced.

## 1.0.40 — 2026-10-12
*(1.0.39 was a test build and was never published; this entry covers both.)*
- **Preview beside the list.** The right two thirds of the session list is now a panel for the
  highlighted session: its full name, a rule, then its latest exchange — your last prompt and the
  end of the reply — so you can tell what a session is doing, or what it concluded, without opening
  it. A session that needs you says so. Session names in the list are clipped to make room (the
  panel's title shows the full name). Don't want it? Switch off "Show a preview of the highlighted
  session beside the list" in the phone's settings and the list gets the whole width back, with no
  extra requests. Nothing is drawn or fetched while you are still swiping:
  the preview appears when you pause (about half a second), so scrolling costs the glasses no more
  than it did before. With the updated backend the preview downloads about 2 KB instead of the whole
  conversation; an older backend still works, it just transfers more.
- **Less Bluetooth traffic everywhere.** The app now sends a part of the screen to the glasses only
  when its text actually changed. Before, every update re-sent the whole screen, including an
  identical copy every 5 seconds while idle.
- **Optional AI summaries (off by default).** If your backend has your own Anthropic API key, the
  phone's settings offer "Summarize list previews with Claude Haiku". When on, the preview shows a
  one-line summary (marked `~`) that leads with what the session is waiting on. Your backend sends
  the highlighted session's latest request and the end of its reply to Anthropic under your key:
  once per change in the words being summarized (not every time the transcript file is touched),
  never while the session is still working, never from a page you haven't touched for 10 minutes,
  and never again for a transcript that was declined or failed. Needs the updated backend (`conductor_api.py`); without it, or with the
  switch off, you get the plain preview and no extra requests.
- **Fix: an error could be reported thousands of times a minute.** The Even app's web view reports
  every network request a plugin makes to the host app; when that host call fails, the failure is
  itself an error — and this app's error reporter answered each one with another network request.
  On one phone that looped about 9,000 times a minute, from every copy of the page the Even app had
  kept alive. The reporter now sends at most one report per distinct error per minute and 20 per
  launch, and the backend counts repeats instead of logging each one. (Published 1.0.36–1.0.37 have
  the uncapped reporter.)
- **Fix: the preview and summaries treated Claude Code's auto-compaction text as your request.**
  After a session compacted, the preview's first line read "This session is being continued…" and
  the summary was asked about that text. The backend now skips those records (also in the reading
  view), and sends at most the first 2,000 characters of a request to the model.
- **Which build is this?** The phone screen now shows the version and build time at the bottom.
- **Fix: the "working" indicator was invisible.** It used a glyph the glasses' font doesn't have,
  so it drew blank in the session header and on the live activity line. It is now ●, the same
  mark the list uses for a working session.

## 1.0.38 — 2026-10-08
- **New name: G2C** (was TMUXor). Display name only — same app and package id, so it updates in
  place and keeps your settings; the `tmuxor:` setup code from `install.sh` still works.
- **Pin sessions to the top.** Star a session and it stays in a ★ band at the top of the list
  (ordered by status inside the band). Pin from the phone — the app screen now lists your sessions
  with a ★ toggle — or from the session list on the glasses: highlight it, tap then press-and-hold to
  open the system menu, and choose **Pin / unpin session**. Pins are saved on your phone alongside
  your connection settings; no backend update is needed.
- **Safety fix: a long-press could approve a command.** Newer Even apps send long-press events. The
  SDK this app was built on (0.0.11) didn't know them, so one arrived as a plain tap — on the
  approve screen that picked the highlighted option, and the release picked it again (reproduced in
  the Even simulator; not confirmed on hardware). Fixed by moving to Even Hub SDK 0.0.16, plus a
  guard that drops any event type the SDK can't name.
- **The highlight follows the session, not the row.** The list re-sorts as sessions change state;
  the ▶ used to stay on a row number, so it could slide onto a different session between your swipe
  and your tap. It is now anchored to the session.
- **Easier list.** It opens on the session that most needs you; **＋ new session** moved to the last
  row (one swipe up from the top). The header reads SESSIONS and always stays on one line. While
  the app is not set up, loading, or offline, taps on the glasses do nothing (and make no requests).
- **Phone screen.** Leads with your sessions and a short "How to use the glasses" guide; the
  connection form folds away once you're connected.
- **Requires Even app 2.2.10 or later** (Even Hub SDK 0.0.16). Update the Even app first if this
  build doesn't appear.

## 1.0.37 — 2026-07-09
- **Review fix:** the app no longer makes any network request before you've entered your backend
  URL + token. Previously the fleet poll fired immediately on launch, which (with no backend set)
  hit a relative `/api/panes` and returned 404 — flagged by the Even Hub review. The glasses now
  show a "set up on your phone" prompt until a backend is configured, then start polling.

## 1.0.36 — 2026-07-06
- **Herdr sessions now show their real names.** They were showing the project folder name
  (e.g. every session in one repo looked identical); the list now shows each session's actual
  Claude name (its `/rename` title or auto-name), resolved from the session record.
- **Crash diagnostics.** Uncaught app errors are now captured and shown on the Setup screen (and
  logged to your backend) instead of the app silently quitting — so an instability can be reported
  and fixed. (Investigating a reported quit/scroll issue in herdr session views.)

## 1.0.35 — 2026-07-06
- **Finished sessions stay pinned on top.** When a working session completes (working → idle) it no
  longer drops back into the idle pack — it pins in a "done" band at the top of the list, marked »,
  until you open it (opening acknowledges it). The header count bar shows a `N» done` segment.
- **Choose your backend: tmux or Herdr.** The backend now supports [Herdr](https://herdr.dev/) as an
  alternative session host alongside tmux. If your machine runs both, the phone Setup screen shows a
  backend picker (Auto / tmux / herdr); the choice is sent per-request and the backend gates it on
  what's actually installed. Herdr sessions get their status (working / needs-input / idle) from
  Herdr's native agent state instead of screen inference. Pure-tmux setups are completely unchanged —
  no picker appears and requests are byte-identical to 1.0.33.
- Under the hood: pane ids are now opaque tokens (tmux `29`, herdr `w3:p6`) and URL-encoded; switching
  backend resets the open view + done-band memory so nothing straddles two backends; multi-line text
  to a herdr session is sent with soft newlines so it lands as one prompt.
- **Fixes from the pre-release review (multi-agent, adversarially verified):** a session whose
  completion you just watched is no longer false-pinned in the done band (closing a pane counts as
  having seen it); switching backend while a session view is open no longer strands the glasses on a
  dead screen (it ejects back to the list); a herdr-only machine (no tmux) now works out of the box
  instead of failing every request; long permission diffs under herdr are fully scrollable; new
  sessions under herdr join the existing project workspace instead of duplicating it; an in-flight
  fleet poll can no longer repopulate the list with the old backend's sessions after a switch.

## 1.0.33 — 2026-07-01
- **Resubmission build — no functional changes from 1.0.32.** The Even Hub review of 1.0.32 asked for
  a detailed change log of everything in the update. Version bumped so the build can be re-uploaded
  with that log attached; a consolidated summary of all changes since the last approved build (1.0.7)
  is in `store-assets/whats-new-1.0.33.txt`.

## 1.0.32 — 2026-06-30
- **Review pass (multi-agent code review, verified findings).** Backend: project-dir encoding now
  matches Claude Code's real mapping (replaces `.` as well as `/`) so sessions whose folder contains a
  dot — e.g. git worktrees under `.claude/…` or version-dotted dirs — no longer show an empty
  conversation; the audit log is created/kept private (chmod 600); `/api/health` no longer reveals
  OpenAI-key presence to unauthenticated callers; the transcript sort no longer 500s if a file rotates
  mid-request; the conversation/resolve caches are now bounded (no slow memory growth in the long-lived
  service). App: sending to a **shell** pane no longer leaves a stuck "⋯" working line; the HUD no
  longer goes to sleep while a prompt is open (which could swallow your answer tap); the new-session
  "done" marker uses a glyph that actually renders (the old ✓ drew blank); and "New tag (speak)" now
  says "(type)" when voice is off.

## 1.0.31 — 2026-06-30
- **The read view of a question prompt now wraps to the glasses, not the terminal.** It was showing
  the raw terminal capture, whose lines are pre-wrapped at the terminal's (narrower) width — so the
  question and option labels broke at the terminal's spots, leaving early breaks on the glasses. The
  read view of an AskUserQuestion is now rebuilt from the parsed question + option labels +
  descriptions and wrapped to the glasses width, so it fills evenly like the answer view. (Permission
  / plan prompts still show the raw command/diff verbatim.)

## 1.0.30 — 2026-06-30
- **Conversation text no longer wraps early.** Lines were being filled right up to the device's
  usable edge, so the firmware re-wrapped them on screen and left stray short remainders ("wrapped
  early sometimes"). The conversation/read wrap width now matches the answer view's proven-good
  width with a safe margin, so lines fill consistently.

## 1.0.29 — 2026-06-29
- **Long options now wrap consistently in the READ view too.** The answer view already wrapped long
  labels with a hanging indent; the read/conversation view of the prompt was wrapping the raw lines
  with no hanging indent, so a long option's continuation lines fell back to the left margin and
  looked broken. The read view now indents wrapped option lines under the option text (past the
  `❯`/number/checkbox prefix), matching the answer view.

## 1.0.28 — 2026-06-29
- **Long option labels now WRAP instead of getting cut off** in the answer view. Each option wraps
  onto as many lines as it needs; the list scrolls by display line so the highlighted (long) option
  stays fully visible, and ▲/▼ in the header show when there's more above/below. (The long question
  itself was already readable in the conversation/read view.)

## 1.0.27 — 2026-06-29
- **"→ next question" advance fixed properly.** 1.0.26 moved the cursor up by a fixed over-count
  before pressing Right, but the prompt's option list **wraps around** — so overshooting cycled the
  cursor back onto a special row and Right was swallowed again (the cursor "flew through all the rows"
  and nothing advanced). It now steps up by the *exact* tracked cursor position, landing precisely on
  option 1 (works whether the list wraps or clamps, and can never overshoot), then presses Right.

## 1.0.26 — 2026-06-29
- **Multi-select "→ next question" now actually advances**, and **free-text answers are no longer
  cleared.** Diagnosed from the backend's keystroke audit log + on-device captures: the prompt only
  cycles its question tabs (Right) from a *normal* numbered option — on the special "Type something" /
  "Next" / "Chat about this" rows the keystroke is swallowed. After you typed a free-text answer the
  cursor was sitting on "Type something", so "→ next question" did nothing. The app now walks the
  cursor up onto a normal option before advancing. Separately, a free-text answer in a multi-select
  was being submitted with a trailing Enter that *unchecked* it — multi-select answers are now typed
  without that Enter (single-select still confirms with Enter), so your typed answer sticks.

## 1.0.24 — 2026-06-29
- **Multi-question controls simplified to match how the prompt actually works.** Single-select
  questions auto-advance when you answer (no button needed). Multi-select questions get a single
  "→ next question" button. And you submit by tapping the real **"Submit answers"** option on the
  final screen — the old "» submit answers" shortcut is gone (it was navigating in a way that could
  clear a typed answer).

## 1.0.23 — 2026-06-29
- **Multi-select wrong-toggle FIXED at the root.** Captured the prompt's behavior key-by-key: when
  the move (Down) and the toggle (Space) are sent together, the prompt applies the toggle to the row
  it was on BEFORE the move registered — so it ticked/cleared the wrong option. The app now sends the
  keystrokes one at a time with a small gap, so each cursor move lands before the toggle. This also
  makes single-select and the multi-question Submit step more reliable.

## 1.0.22 — 2026-06-29
- **Multi-select navigation reworked (again) based on the real terminal behavior.** The previous
  version sent a keystroke on every swipe, which overshot because the G2 pad fires a burst of swipe
  events — so the cursor jumped several rows. Now a swipe just moves the highlight, and the tap moves
  the prompt's cursor to it in one go and toggles. The off-by-one from before (the app assumed the
  prompt's cursor jumps down after a tick — it doesn't) is also fixed. Swipe to the option, tap to
  tick; the highlight stays where you tick.

## 1.0.21 — 2026-06-29
- **Multi-select highlight now matches the prompt.** After you tick an option, the on-glasses ▶ stays
  on that option (the prompt's cursor stays put too) instead of jumping ahead a row — so the highlight
  no longer drifts out of sync and every following swipe lands where you expect. Move to the next
  option with a swipe.

## 1.0.20 — 2026-06-29
- **Multi-select reworked so it ticks the RIGHT option.** Swiping now moves the prompt's own cursor
  one step at a time (in lockstep with the highlight), and a tap toggles exactly the highlighted row
  — instead of computing a relative "move N rows" that drifted and ticked/cleared the wrong items.
- This should also stop the occasional jump to the conversation mid-question — that was a wrong tap
  landing on "Chat about this" (which exits the prompt). With correct toggling it won't happen.

## 1.0.19 — 2026-06-29
- **Robustness pass** (from a multi-agent code review of the menu/conversation handling):
  - If a keystroke to the session fails, the on-glasses state no longer sticks in a wrong/optimistic
    state — it reverts to what's really on screen.
  - Cancelling a "Type something" answer (or leaving it empty) now properly closes that text field in
    the session instead of leaving it open.
  - Options whose label starts with a number (e.g. "30 minutes", "2 hours") are no longer dropped.
  - "Type something" no longer shows a stray empty checkbox in a multi-select question.
  - Further hardened prompt detection so quoted menus / numbered lists in the conversation can't leak
    into a real prompt's options or question (extends the 1.0.17/1.0.18 fixes).
  - A double-tap when you're already at the bottom no longer wastes a tap.

## 1.0.18 — 2026-06-29
- **Multi-select no longer ticks the wrong item.** After you tick one, the prompt moves its cursor
  down by one; the app now follows that, so the next tap hits the item you expect (and you can
  tap-tap straight down the list, or swipe to jump).
- **The question shown above the options is always the real one** now, even if the conversation just
  above happened to quote a menu (that was making the "question" pick up chat text).

## 1.0.17 — 2026-06-29
- **The app no longer mistakes chat text for a live prompt.** If a conversation *talks about* menus
  (numbered lists, the word "Submit", checkboxes — e.g. a session discussing this very feature), the
  app used to think a prompt was active and lock the view so you couldn't scroll. It now only treats
  it as a prompt when a real one is at the bottom of the screen. (Mostly affected testing in a
  session that was literally about menus; real coding sessions wouldn't hit it.)

## 1.0.16 — 2026-06-29
- **No more flashing into the conversation when answering.** The read view of a multi-question prompt
  now starts right at the question, instead of sometimes landing on earlier conversation text that
  shares the screen.
- **Multi-select feels instant.** Tapping a topping flips its checkbox immediately (it used to wait
  ~1s for a refresh), so you can clearly see what's selected as you go.

## 1.0.15 — 2026-06-29
- **Multi-select checkboxes fixed.** A checked option no longer shows a doubled `[ ] [ ]` — it now
  shows a single `[x]`. (Claude marks a checked box with a ✔ glyph the parser wasn't recognizing, so
  it leaked through and the firmware font draws ✔ blank.)
- **The question now shows in the answer view too**, above the options — no need to flip back to the
  read view to remember what's being asked. (Long questions show up to two lines.)
- Free-text ("Type something") now also opens the keyboard from a multi-select question (before, it
  only toggled like a checkbox).

## 1.0.14 — 2026-06-29
- **Conversation view stays put sensibly.** While you haven't manually scrolled, it now follows the
  latest prompt — so after a multi-question prompt (or any prompt) closes, it no longer shows a
  stale, scrolled-back position (this is what made a typed/free-text answer "jump somewhere else").
  Double-tap still works the same: jump to the recent prompt, then to the live edge, then out to the
  list. If you scroll manually, your spot is kept (and a reopen resumes there).

## 1.0.13 — 2026-06-29
- **Multi-question prompts no longer jump to old conversation.** Each question's read view now opens
  right on the question (the tab strip + question + options) instead of scrolling up into the earlier
  conversation that shares the screen. You can still swipe up to see that context if you want.

## 1.0.12 — 2026-06-29
- **Free-text answers ("Type something") fixed.** After you type your answer it now goes into the
  question's text field and returns you to the prompt — previously it was treated like a brand-new
  message and flipped to the "working…" conversation screen. The phone keyboard for this is labelled
  "Type your answer to the question".

## 1.0.11 — 2026-06-29
- **Multi-question prompts: each next question opens in the read view as you advance**, so you can
  actually read it before answering (1.0.10 left you on the compact answer list and you had to
  double-tap to read the next question). Answering an option still keeps you put — only moving to a
  new question brings up its read view.

## 1.0.10 — 2026-06-29
- **Multi-question prompts fixed to match how Claude really renders them.** Tested against the live
  prompt: questions are now answered by moving the highlight and confirming (the prompt's own keys
  are "Enter to select · arrow keys to navigate" — not number keys), and a multi-question prompt
  opens straight into the answer view and STAYS on each question as you go (it no longer jumps back
  to the prompt text after every answer). The READ view shows the real question tab strip + Submit.
- **One more line of conversation.** The scroll arrows + position indicator moved up into the title
  row, so the conversation/output view now shows 9 lines instead of 8 (no separate bottom bar).
- ⚠ Still verify on-device: advancing between questions (→ next question) and submitting (» submit
  answers) use keys that aren't officially documented.

## 1.0.9 — 2026-06-29
- **Multi-question prompts (AskUserQuestion) can now be answered end-to-end.** When Claude asks
  several questions at once (a tab strip ending in *Submit*), the glasses now show the tab strip,
  let you answer each question, move on with **→ next question**, and finish with **» submit
  answers** — instead of only handling the first question. Free-text ("Type something") opens the
  phone keyboard (or voice) and types straight into that field.
- Picking an answer in a multi-question prompt no longer risks an early submit (it selects without
  pressing Enter; you submit explicitly).
- ⚠ The exact keys Claude's multi-question prompt uses aren't documented, so this flow is built to
  the observed behavior and should be confirmed on the real glasses; single-question + Yes/No
  prompts are unchanged.

## 1.0.8 — 2026-06-29
- **Conversations read much better.** Code blocks are kept VERBATIM with a │ left rail — they used
  to be silently corrupted (`**kwargs`→`kwargs`, `a * b`→`a  b`, `__init__`→`init`); section
  headings show with ■, blockquotes with »; and a multi-line question stays indented under its ▶ so
  it no longer blurs into the reply.
- **Option prompts are more robust across all Claude Code prompt types.** Plan-mode no longer turns
  the plan's numbered steps into fake choices (options are anchored to the ❯ cursor's run); a
  single choice is confirmed by its number key (cursor-independent, so a momentary mis-read can't
  approve the WRONG option); boxed prompts are tolerated. (The conversation markers are a backend
  change — re-run install.sh or restart the service; the option fixes are in the app build.)

## 1.0.7 — 2026-06-29
- **Store-review fix:** removed the two stray URLs the Even reviewer flagged from the bundle — the
  Setup field's example URL (now a plain text hint) and React/react-router's dead "error docs"
  links (react.dev/errors, reactrouter.com), which the app never connects to. No functional change.

## 1.0.6 — 2026-06-28
- **Fix: option prompts now actually show up.** Claude's Bash / edit permission prompts ("Do you
  want to proceed? ❯ 1. Yes / 2. No …") weren't being detected — only AskUserQuestion-style ones
  were — so the glasses showed the conversation (bash code blocks) instead of the live question +
  choices. Now any prompt with the ❯ cursor on a numbered option is recognized, and the read view
  opens right at the question + options (the command/context scrolls up).

## 1.0.5 — 2026-06-28
- **Fix: multi-option prompts (AskUserQuestion) read clearly.** The read view had kept each
  option's description but dropped the "1. … / 2. …" lines above them, so the descriptions looked
  orphaned ("structure messed up"). The read view now shows the whole prompt — the question, each
  numbered option, and its description, in order — then tap to choose.

## 1.0.4 — 2026-06-28
- **Final-review polish:** double-tap leaves right away when the whole conversation already fits on
  screen (no needless scroll), and skips the prompt step on plain shell panes; the glasses no longer
  sleep while you're recording or typing; and a send error can't get clipped off the review screen.

## 1.0.3 — 2026-06-28
- **Fix (for real this time): double-tap brings you to the latest prompt from anywhere.** 1.0.2
  only worked if you'd scrolled *above* the prompt; while reading the *answer* (below the prompt)
  it still went to the bottom. Now double-tap puts the latest prompt at the top whenever you're not
  already on it — then the bottom, then back to the list.

## 1.0.2 — 2026-06-28
- **Fix: double-tap lands on the latest prompt.** When you'd scrolled up, double-tap jumped to the
  bottom instead of the recent prompt whenever that prompt was near the end of the conversation.
  Now it brings the prompt to the top first, then the bottom, then back to the list.

## 1.0.1 — 2026-06-28
- **Idle screen-sleep** — the glasses HUD blanks after a configurable idle time so there's no
  constant display in your view. Set the on-time in Setup (seconds; 0 = always on). It wakes on
  any gesture, and — if you leave the toggle on — when a session finishes or starts needing your
  input.
- **Tidier session view** — gesture hints and scroll position now sit on their own footer line, so
  the header just shows the session. When voice is off the header shows `tap=type`, and the list
  no longer spells out `◀◀=exit`.

## 1.0.0 — 2026-06-28
First public release.

- **See your whole fleet** — every Claude Code (and shell) session in your tmux panes,
  on your glasses, sorted by what needs you. Each tmux window is a **project tag** so you
  tell sessions apart at a glance. Swipe to scroll the list; ▶ marks the selected row.
- **Continue your work** — open a session to read its real prompts and replies (not raw
  terminal noise), reopened right where you left off, or jumped to a new question if one
  arrived while you were away. Double-tap walks you back to the live edge — latest prompt,
  then the bottom — and only then back to the list.
- **Approve safely** — when a session asks to run a command, you read the full command on the
  glasses first (swipe to scroll), then tap to choose Yes/No — so you never approve something
  you can't see.
- **Reply by voice — or type** — tap to talk, review the transcription (with its cost),
  send. No OpenAI key? Type the message on your phone instead. Approve interactive menu
  choices with a tap.
- **Start new sessions** — pick a project tag, speak or type a folder, and a Claude
  session opens there.
- **Private by design** — talks only to your own backend on your own machine, over
  Tailscale, behind a token you set. Nothing is sent to the app developer. The phone app
  opens straight to Setup; paste the config code `install.sh` prints and you're connected.
