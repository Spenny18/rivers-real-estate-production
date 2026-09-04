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
