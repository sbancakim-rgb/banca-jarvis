# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

**Banca Jarvis** (방카슈랑스 영업 보조 어시스턴트) is a single-page, installable
web app (PWA) that helps a bancassurance sales rep voice-record branch visit
notes and look up branch info hands-free, in Korean. There is no build step,
no framework, and no package manager — it's one static HTML file plus a PWA
manifest and two icons.

The app is a **thin client**: all data persistence and parsing logic live in
a separate Google Apps Script Web App (not part of this repo) that the client
talks to via JSONP. The URL of that backend is entered by the user at runtime
and stored in `localStorage` — it is not hardcoded anywhere in this repo.

## Repository layout

```
index.html      Entire application: markup, CSS, and JS in one file (~1150 lines)
manifest.json   PWA manifest (name, icons, theme colors, standalone display)
icon-192.png    PWA icon
icon-512.png    PWA icon
```

There is no `src/`, no build config, no tests, no linter, and no
`package.json`. Everything ships as-is; opening `index.html` in a browser
(or installing it as a PWA) is the entire deployment.

## Architecture

### Client (this repo)
- Plain HTML/CSS/JS, no dependencies, no bundler. All code is inline in
  `index.html` inside a single `<style>` block and a single `<script>` block.
- UI is in Korean throughout (labels, status messages, spoken prompts).
- State is mostly DOM-driven; there's a small `appState` string
  (`idle | recording | querying`) that gates the always-on wake-word listener.

### Backend (external, not in this repo)
- A Google Apps Script Web App, addressed by a user-supplied URL stored in
  `localStorage` under `webAppUrl` (see the "연결 설정" / Settings
  `<details>` at the bottom of the page).
- All communication is **JSONP** via `jsonpRequest()` (`index.html:367`) —
  not `fetch`/XHR — because Apps Script's `doGet` JSONP responses are the
  simplest way to call it cross-origin without CORS config. Requests have a
  20s timeout and report `{ error: ... }` on failure.
- Backend actions invoked by the client (all as `action=` query params):
  `record`, `reparse`, `commit`, `query`, `calendarDay`, `listProposals`,
  `updateProposal`, `dashboard`, `dashboardBank`.
- The backend presumably reads/writes a Google Sheet ("판매자정보" sheet,
  column K = 영업대상/sales target flag, referenced in the dashboard hint).

### Core interaction flows

1. **Voice-driven "always listening" mode** (`resumeWakeListener`,
   `index.html:389`): a continuous `SpeechRecognition` instance listens for
   wake phrases ("기록"/"시작" → start recording, "지점"/"조회"/"브리핑" →
   start branch query) so the rep never has to touch the screen while
   driving/walking between branches. It pauses itself whenever a recording
   or query is active and resumes afterward.

2. **Visit recording** (record → confirm → commit):
   - `createToggleRecorder` (`index.html:628`) captures speech until a stop
     phrase ("완료"/"여기까지") or cancel phrase ("취소").
   - The raw transcript is sent to the backend (`action=record`), which
     returns structured `parsed` data (bank/branch/seller fields, visit
     history, proposal request, etc.).
   - `confirmLoop` (`index.html:834`) speaks a summary back via
     `speechSynthesis` and listens for "맞아/저장" (confirm → commit),
     "수정/정정/다시" (correction → `action=reparse`, loop again), or
     "취소" (abort). This is a fully voice-driven confirm/edit cycle.
   - There's also a manual fallback: a visible edit form
     (`renderEditForm`/`buildField`) with text areas, auto-saving after 5
     minutes of inactivity (`startEditAutoFlow`, `index.html:474`).

3. **Branch query / briefing**: similar toggle-recorder flow, sends
   `action=query`, then speaks the returned `summary` aloud
   (`speakSummary`, `index.html:589`) while listening for "오케이"/"여기까지"
   to interrupt playback.

4. **Visit calendar**: a hand-rolled month calendar
   (`renderCalendar`/`selectCalendarDate`) that fetches `action=calendarDay`
   per selected date and lists that day's visits.

5. **Proposal tracker** (`loadProposals`/`buildProposalCard`): lists
   "제안서 요청" (proposal request) rows, lets the rep edit fields inline and
   toggle 대기(pending)/완료(done) status, saved via `action=updateProposal`.

6. **Dashboard**: per-bank visit progress bars (모수/당월방문/미방문 = target
   count / visited this month / not yet visited), expandable per-bank branch
   chips (`action=dashboard`, `action=dashboardBank`).

### Notable conventions in the code
- All field/label keys are **Korean string literals** used as object keys
  (e.g. `은행명`, `지점명`, `판매자명`, `방문이력`) — these are the literal
  contract with the backend/spreadsheet columns, not just UI labels. Keep
  them exact when touching anything that builds/reads these objects.
- `stripSymbols()` (`index.html:338`) strips markdown-ish symbols before
  displaying or speaking any backend-provided text — apply it to any new
  text surfaces fed by `speechSynthesis` or shown in a status box.
- Voice command phrase lists (`START_RECORD_PHRASES`, `STOP_PHRASES`,
  `CONFIRM_PHRASES`, etc.) are simple substring matches against Korean
  speech-to-text output, not exact matches — keep new phrases short and
  distinct to avoid false triggers.
- `appState` must be set to `'idle'` and `resumeWakeListener()` called at
  every exit point of a flow (commit, discard, cancel, error), or the
  always-listening wake word stops working until reload.

## Development workflow

- **No build/install step.** Edit `index.html` directly and open it in a
  browser (or serve it with any static file server) to test.
- **No automated tests.** Validate changes manually in a Chromium-based
  browser (Web Speech API — `SpeechRecognition`/`speechSynthesis` — is most
  reliable there; it's largely unsupported in Firefox).
- **Testing the voice flows** requires microphone access and a real browser
  session; you cannot meaningfully exercise `SpeechRecognition` from a
  headless test runner. When asked to verify changes, say so explicitly
  rather than claiming the voice flow was tested.
- **Backend changes** (Apps Script) are out of scope for this repo — if a
  task implies changing backend behavior (sheet columns, new `action=`
  endpoints), call that out explicitly since it can't be done here.
- This repo's git history is just a sequence of "Add files via upload" /
  "Update index.html" commits (no PR workflow visible); there is no CI.

## Conventions for AI assistants

- Keep everything in `index.html` unless there's a strong reason to split
  files — this project is intentionally a single static file with no
  bundler, so splitting into modules would require introducing a build step.
- Preserve the Korean-language UI and voice phrases; don't translate labels
  or status text to English.
- When adding new backend-bound actions, follow the existing
  `jsonpRequest(url, { action: '...', ... }, callback)` pattern rather than
  introducing `fetch`.
- When adding new voice prompts/status text, run it through `stripSymbols()`
  before display/speech, matching existing call sites.
- Don't add dependencies, frameworks, or a package manager — that would
  contradict the project's whole premise of being a zero-build, drop-in PWA.
