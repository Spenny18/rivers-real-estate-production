# Luxury Homes Calgary

The Rivers Real Estate / Luxury Homes Calgary platform. React + Vite client,
Express + SQLite (Drizzle) server, deployed on Fly.io.

## Stack

- **Frontend:** React 18, Vite, TypeScript, Tailwind, wouter, TanStack Query
- **Backend:** Express 5, SQLite via better-sqlite3 + Drizzle ORM
- **Hosting:** Fly.io with persistent volume mounted at `/data`
- **MLS feed:** Pillar 9 RETS
- **Email:** Resend (riversrealestate.ca verified)
- **Maps + POIs:** Leaflet + Overpass API + OSRM routing

## Local development

```sh
npm install
npm run dev
```

The app runs on http://localhost:5173 (client) with the Express server on
:3001 by default. Vite proxies `/api/*` through.

## Deploy

Pushes to `main` automatically deploy to Fly via the
`.github/workflows/fly-deploy.yml` Action. The Action calls
`flyctl deploy --remote-only` so the build runs on Fly's builders, not on
the GitHub runner.

To deploy from a feature branch, use `workflow_dispatch` from the Actions tab.

### Manual deploy (fallback)

```sh
fly deploy
```

### Required secrets (GitHub repo → Settings → Secrets → Actions)

| Secret           | What it's for                                |
|------------------|----------------------------------------------|
| `FLY_API_TOKEN`  | Generated via `fly tokens create deploy`     |

### Required Fly secrets (set with `fly secrets set KEY=val`)

| Secret                   | What it's for                  |
|--------------------------|--------------------------------|
| `RESEND_API_KEY`         | Transactional email            |
| `OPENAI_API_KEY`         | Condo hero image generation    |
| `PILLAR9_USER` / `_PASS` | RETS feed credentials          |
| `MAKE_WEBHOOK_URL`       | Social composer outbound hook  |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Calendar OAuth (bookings + free/busy) |
| `PUBLIC_ORIGIN`          | Absolute origin used in booking links, emails and OAuth redirect |

## Project layout

```
client/      Vite + React frontend
server/      Express + Drizzle backend
shared/      Drizzle schema (shared types)
script/      Standalone scripts (image generation, etc.)
fly.toml     Fly.io config
Dockerfile   Production build
```

## Home page CMS

The public homepage is content-managed at `/admin/home` — no code change is
needed to edit its copy, images, section order, or metadata.

- **Content model:** `shared/home-content.ts` defines every block type, the
  fields it exposes, and the factory defaults. The admin's settings panel is
  generated from those field definitions, so adding a field there is the only
  step needed to expose it in the CMS.
- **Rendering:** `client/src/components/home-blocks.tsx` maps a block type to
  its React section; `client/src/pages/home.tsx` renders the ordered list.
- **Storage:** the `pages` table (one row per page, blocks as JSON) plus
  `page_revisions`, which snapshots the page before every save so any version
  can be restored from the History tab. If no row exists yet, the factory
  page in `shared/home-content.ts` is served, so the site is never blank.
- **SEO:** the page's title/description/canonical/OG image feed
  `server/seo-inject.ts`, so crawlers get the edited metadata in the
  server-rendered `<head>`. An FAQ block also emits FAQPage schema.
- **Live preview:** the editor embeds the real homepage at `/?cmsPreview=1`
  and pushes the unsaved draft over `postMessage`. That URL is served as the
  CSR shell (see `server/ssr.ts`) because the preview wraps each section in a
  click-to-select container the server render doesn't produce.
- **Cache:** saving invalidates the SSR HTML cache for `/`, so edits appear on
  the live site immediately rather than after the render cache expires.

## Scheduling (the booking system)

A self-hosted Calendly equivalent. Public booking pages live at `/book`, the
agent's console at `/admin/scheduling`. No third-party scheduling service is
involved — bookings are rows in this app's own database, and Google Calendar
is used only to check the agent's real availability and to mirror the meeting
onto their calendar.

- **Meeting types** (`booking_event_types`) are the shareable links. Each one
  is `/book/<slug>` and owns its own duration, location, buffers, minimum
  notice, booking horizon, per-day cap, and an optional extra question. Three
  are seeded on first boot (buyer consultation, listing appointment, private
  showing) and every field is editable in the admin — no code change needed.
- **Availability** is weekly windows (`booking_availability`) plus one-off
  exceptions (`booking_date_overrides`). A row with a null `event_type_id`
  belongs to the default schedule every meeting type inherits; giving a type
  its own rows overrides the default for that type only.
- **The slot engine** is `server/booking.ts`. It walks each local day in
  slot-interval steps and drops anything too soon, too far out, or colliding
  with an existing booking, an existing tour, or a Google free/busy block —
  each collision widened by the type's before/after buffers. Instants are
  stored in UTC; availability is stored as minutes from local midnight in the
  meeting type's IANA zone, so "9:00 AM" stays 9:00 AM across a DST change.
  There is no timezone library: `Intl.DateTimeFormat` already knows every
  zone the runtime does.
- **The browser never decides anything.** Its slot list is a suggestion; the
  server recomputes and re-validates the exact start time at write time, so a
  stale page or a tampered payload gets a 409, not a booking.
- **Every booking is also a lead** — a row in `leads` and a push to Follow Up
  Boss, so bookings show up in `/admin/leads` alongside form inquiries.
- **Invitees manage their own booking** at `/book/manage/<uid>`, where the
  128-bit uid is the only credential. They can reschedule, cancel, or download
  an `.ics`. The same link is in their confirmation email.
- **Emails** (Resend) go out on booking, reschedule and cancellation, to both
  the invitee and the agent. See the `buildBooking*Html` builders in
  `server/email.ts`.

### Google Calendar

Optional but recommended — without it, bookings still work, they just can't
see events booked anywhere else. Connect it from the card at the top of
`/admin/scheduling`. Setup steps for the Google Cloud project are in the
header comment of `server/google-calendar.ts`.

The OAuth scopes are `calendar.events` (write the meeting) and
`calendar.freebusy` (read busy blocks). A connection made before the
`freebusy` scope existed keeps working but won't block slots against outside
events; the admin card flags this and one reconnect fixes it.

## CRM mirror (Follow Up Boss)

`/admin/crm` shows the Follow Up Boss account — people, deals, pipelines,
calls, texts, events and tasks — read from a **local mirror** refreshed hourly,
not from a live API call per page view. That keeps the page fast and keeps it
rendering when FUB is unreachable.

It is read-only by design. Edits still happen in Follow Up Boss and appear
here on the next sync; the only write path to FUB remains the existing
inquiry push in `server/follow-up-boss.ts`.

- **`server/fub-client.ts`** — the read client. HTTP Basic with the API key as
  username and an empty password (FUB's convention). Pages through
  collections, retries 429s honouring `Retry-After`, and treats 401/403 as
  terminal rather than retrying a permission problem.
- **`server/fub-sync.ts`** — maps payloads into the mirror and drives the
  hourly cron. Each resource syncs independently, so a resource the account's
  plan doesn't include can 403 without stopping the rest.
- **`server/crm-routes.ts`** — `/api/admin/crm/*`, all behind `requireAuth`.
- **Tables** — `crm_contacts`, `crm_deals`, `crm_pipelines`, `crm_stages`,
  `crm_activities` (one timeline for events/calls/texts/tasks/appointments)
  and `crm_sync_runs`.

### The field mapping is unverified

This was built without access to `docs.followupboss.com` or
`api.followupboss.com` — both are blocked by the build environment's egress
proxy — so the **field names in `fub-sync.ts` are informed guesses, not
verified against the real API.** The envelope handling and the mapping are
deliberately built to survive being wrong:

- `pick()` takes a list of candidate field names, so `created` vs `createdAt`
  both map.
- Every row stores the untouched payload in `raw`, so a column that mapped to
  the wrong name can be re-derived from data already synced — no re-pull.
- Every run records how often each column came out null (`nullRates`). A
  column reading 100% null is surfaced on the page as a mapping warning, so
  the mistake announces itself instead of looking like an empty CRM.

**To pin the mapping down:** hit `GET /api/admin/crm/probe` while signed in.
It fetches one page per resource and reports the real envelope keys, metadata
and field names (names only — never values). Correct the candidate lists in
`fub-sync.ts` from that, then run a Full re-sync.

### Setup

| Secret | What it's for |
|---|---|
| `FUB_API_KEY` | Follow Up Boss -> Admin -> API. Without it the page says so and the cron stays off. |
| `FUB_SYSTEM` | Optional `X-System` header. Defaults to `RiversRealEstate`. |
| `FUB_SYSTEM_KEY` | Optional `X-System-Key`, if the tenant enforces system identity. |

Deals are a Follow Up Boss add-on. If the plan doesn't include them, the Sync
tab shows a 403 against `deals` and everything else still works.
