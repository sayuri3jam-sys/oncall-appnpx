# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — ESLint (flat config, `eslint-config-next`)

No test framework is configured; there are no test scripts to run.

## Architecture

This is a single-page client app for staff at a residential care facility to manage on-call
handoffs for home-visit nursing (訪問看護). Nearly the entire app lives in one file:
[app/page.tsx](app/page.tsx) (~3000+ lines), a `'use client'` component with no sub-component
files. Sections are marked with `// ====` banner comments; use `Grep` for those banners or for
`currentView ===` to jump to a section rather than reading the file linearly.

**View switching**: a single `currentView` state (`'map' | 'doctor' | 'summary' | 'supply' |
'history'`) selects which section renders — room map, doctor's-order chart, emergency summary
sheet, supply management, visit history archive. There is no router-based navigation between
these.

**Data model**: `Patient` (one per occupied room) nests `EmergencySummary`, `SupplyItem[]`, and
`VisitRecord[]` (`visitHistory`). Most fields track not just a value but who last touched it
(`lastEditedBy`/`lastEditedAt`, or per-field `checkedBy`/`checkedAt`) — preserve this pairing
when adding fields.

**Persistence is entirely client-side** — there is no database or server-side data store:
- `patients` → `localStorage['oncall_patients_v2']` (versioned key; bump the suffix if the
  `Patient` shape changes incompatibly, so old malformed data doesn't get loaded — see the
  validity check around the restore effect)
- next visit date → `localStorage['oncall_next_visit_date']`
- auth session → `sessionStorage['oncall_auth']` / `['oncall_user']`

**Hydration rule**: any state seeded from `localStorage`/`sessionStorage` must initialize to the
same value on server and client (e.g. `false`/`''`) and only be read from storage inside a
mount-only `useEffect`. Reading storage during initial render causes hydration mismatches. Follow
this existing pattern for any new persisted state.

**Auth is not real security** — login (`jam`/`yuki123`) and a separate "master password"
(`master999`, gating destructive actions like vacating a room or resetting the visit cycle) are
hardcoded client-side checks, meant only as operator friction, not access control.

**Visit cycle reset** (`handleStartNextVisitCycle`): snapshots each patient's current-cycle data
into a `VisitRecord` prepended to `visitHistory`, then clears cycle-scoped fields (vitals, doctor
memo/order, order status/periods, observation checklist, supply usage counts) while preserving
longer-lived fields (care directives like DNR/gtube/cvport, `emergencySummary`, supply
definitions). When touching the `Patient` shape, decide which bucket a new field belongs to.

**Suggestion engines**: `INSTRUCTION_SUGGESTION_RULES` and `OBSERVATION_SUGGESTION_RULES` are
keyword→suggestion tables matched against the doctor's memo/order text (Japanese clinical terms).
Extend behavior by adding rule entries, not new logic.

**Server-side code**: [app/api/summarize-report/route.ts](app/api/summarize-report/route.ts) is
the only route handler. It calls the Anthropic Messages API directly (server-side fetch, not the
SDK) using `ANTHROPIC_API_KEY` from `.env.local` (gitignored, not committed) to turn a visit's
notes into a short timeline summary. This is the only place an env var or external API call is
used.

Styling is Tailwind CSS v4 (`@tailwindcss/postcss`) with no component library. UI text and domain
terms are in Japanese medical/care vocabulary (バイタル, 頓用薬, 褥瘡, 往診, etc.) — keep new
strings consistent with that terminology rather than translating.
