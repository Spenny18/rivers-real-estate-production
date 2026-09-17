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
| `RESEND_API_KEY`         | Transactional email and the monthly newsletter (`RESEND_FROM_EMAIL` is the sender) |
| `RESEND_WEBHOOK_SECRET`  | Optional. Signing secret of a Resend webhook pointed at `/api/newsletter/webhooks/resend` (events: `email.bounced`, `email.complained`), so bounces and spam reports take people off the newsletter list |
| `OPENAI_API_KEY`         | Condo hero image generation    |
| `PILLAR9_USER` / `_PASS` | RETS feed credentials          |
| `MAKE_WEBHOOK_URL`       | Social composer outbound hook  |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Calendar OAuth (bookings + free/busy) |
| `PUBLIC_ORIGIN`          | Absolute origin used in booking links, signing links, emails and OAuth redirect |
| `BACKUP_*`               | Offsite backup of the database and signed contracts — see *Deals & e-signature* below |

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
  server-rendered `<head>`. An FAQ block also emits FAQPage schema, and a
  Video block emits a VideoObject (`server/schema/video.ts`) for its YouTube
  embed. Google needs the upload date to list the page in video results, so
  the block carries *Published on YouTube*, *Video length* and a search-only
  description alongside the video ID — fill them from YouTube Studio, and
  update them whenever the video ID changes. Nothing is fetched from YouTube
  at request time (its pages answer server IPs with a bot check).
- **Blog videos:** a YouTube link in a post's body (`[title](https://www.youtube.com/watch?v=…)`)
  renders as a click-to-play player where it first appears, and the post's
  schema gains a VideoObject for it. The post's *Video published on YouTube*
  and *Video length* fields in `/admin/blog` feed that markup (blank = the
  post date, no length). `shared/youtube.ts` is the one parser both the
  page and the schema use to decide which video a post shows.
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

## Deals & e-signature

The transaction file and the in-house replacement for Authentisign — and,
with form templates, for the day-to-day of CREA WEBForms. Deals live at
`/admin/deals`; each one holds the PDFs for a transaction, who signs them,
and the evidence of what happened. A document is produced from a form
template with the deal's data filled in (*New from form*), or arrives as a
PDF exported from WEBForms (uploaded or emailed to the deal's address).
Nothing is subscribed to.

- **Documents** (`deal_documents`) are stored under `DOCUMENTS_ROOT`
  (`/data/documents` in production, `data/documents` locally), which is
  deliberately *not* under the public `/uploads` mount: every download goes
  through an authenticated admin route or the signer's token. The uploaded
  original is never modified; its SHA-256 is recorded at upload.
- **Signers** (`deal_signers`) each get a 256-bit token that is the only
  credential in their emailed link, `/sign/<token>`. One token per signer per
  document.
- **Boxes** (`deal_fields`) — signature, initials, date, time, text,
  checkbox — are placed on the pages in the admin
  (`/admin/deals/:id/documents/:docId`, rendered with pdf.js) and stored as
  fractions of the page, so the same layout survives any render size or DPI.
  Date and time boxes are automatic: the server fills them with the moment
  the signature was recorded (Calgary time), in a format chosen per box to
  fit the form's blank — `shared/esign-format.ts` has the list, including
  "September 16" for AREA's ", 20__" lines and "3:45 p" for its ". m." lines.
  Each stamped signature also carries a small caption with the date, time
  and document id. Signing order is "everyone at once" or "one at a time, in
  order".
- **The signer's page** asks for consent to sign electronically before
  anything is recorded (Alberta's *Electronic Transactions Act* turns on
  attribution, consent and an unaltered record), then collects the boxes and a
  drawn or typed signature — both become a PNG. They can decline with a
  reason. After everyone signs, the same link serves the completed copy.
- **Completion** (`server/signing.ts`) stamps every box onto a copy of the
  original with pdf-lib and appends a *Signature Certificate*: the deal, the
  original's SHA-256, each party's consent time, signed time, IP, device and
  signature image, and the full audit trail (`deal_events`). The SHA-256 of
  the final file is stored on the row and shown on the document page and in
  the emails, so any copy can be checked against what was signed. Everyone
  is emailed the signed copy (attached when under 5 MB, linked always).
- **Emails** (Resend): the signing request, reminders, the signed copy, and
  notices to the agent on each signature, decline and completion. See the
  `buildSign*Html` builders in `server/email.ts`. Signing links are never
  CC'd to the agent.
- **Records are kept.** A sent or completed document cannot be deleted, only
  voided (not completed ones), and a deal with such documents can be archived
  but not deleted.

### Form templates (filling AREA forms here instead of in WEBForms)

`/admin/forms` holds blank AREA forms with their boxes drawn on once. A form
template (`form_templates`, blank stored at `templates/<id>/blank.pdf` under
`DOCUMENTS_ROOT`) carries two kinds of box, placed in the same editor as
signature boxes (`/admin/forms/:id`):

- **Fill boxes** print a value into a blank. Each is bound to a key from the
  catalogue in `shared/form-bindings.ts` — property address, MLS® number,
  list price, first/second buyer and seller (name, email, phone, address),
  purchase price, deposits, completion and condition days, additional terms,
  listing brokerage, the agent's own details, today's date — or to a custom
  blank typed each time. The same key on several boxes prints the same value
  in each (the address at the top of every page). Dollar amounts print as
  `$650,000.00`, dates as `October 15, 2026`, paragraphs wrap and shrink to
  fit the box.
- **Sign boxes** are keyed by signer slot (first buyer, second buyer, first
  seller, agent…) and become the document's signature / initials / date
  boxes, with the date format chosen per box.

*New from form* on a deal opens the review screen
(`/admin/deals/:id/forms/:templateId`). The server pre-fills what it knows
(`prefillForDeal` in `server/form-templates.ts`): the deal and its listing in
the Pillar 9 mirror (matched by MLS® number), the linked Follow Up Boss
person or website lead as the first buyer (first seller on a listing deal),
the agent's details, and — for the counter-offer or the amendment — every
answer typed on the previous form for this deal, with live data refreshed on
top. The agent checks the parties, fills the rest against a live preview and
creates the document: the blank is printed with pdf-lib, stored as the
document's original (source `template`, the values kept in
`deal_documents.form_values`), each party with a name and email becomes a
signer, and the sign boxes land on the document. From there it is the
ordinary flow: send, sign, certificate. Sign boxes whose party was left blank
(no second buyer) are dropped and reported. Deleting a form leaves the
documents made from it untouched.

**Recognised AREA forms arrive with their boxes already drawn.** On upload
the server reads the footer code (`AREA©158CLDA_JAN2026`) from the PDF's
text layer (`server/pdf-text.ts`, pdf.js in Node) and, for a form it knows,
places the layout measured from that form (`server/area-layouts.ts`):

| Code | Form | Boxes |
|------|------|-------|
| 158 | Residential Purchase Contract (6 pages) | parties, property, legal description, goods, price, completion day, deposits, dower, conditions, brokerages, conveyancing; signature/date/initials for two buyers and two sellers |
| 160 | Amendment | header, delete/insert paragraphs, four signature blocks |
| 159 | Addendum | header, terms, four signature blocks |
| 163 | Notice (waiver / satisfaction of conditions) | header, party, conditions, two signature blocks (buyer slots; switch to seller in the editor when the seller waives) |
| 123 | Exclusive Buyer Representation Agreement (4 pages) | buyer and brokerage details, term dates, signatures and initials for two buyers and the agent |

Blanks WEBForms pre-prints on the export (the 11:59 p.m. condition times,
"seller's" in 3.1(m), the payment-method choices, the agent's standard 9.2
clauses) are left alone. A newer revision of a form keeps its number, so
the layout still applies and the template's description says which
revision it was measured on. Forms without a layout get a typed box on
every underscored blank, labelled from the text beside it, to bind or
delete. Several PDFs can be uploaded at once; password-protected WEBForms
exports are decrypted like any other upload.

The blank PDFs are AREA members' material and are not in this repository:
only the box coordinates are. Export each blank once from WEBForms (open a
transaction with nothing filled in, *Save as PDF*) and upload it under
Forms.

### Getting forms in from WEBForms

Every deal has its own address, shown on the deal page:

```
spencer+deal-3f9a1c2b7d@riversrealestate.ca
```

Gmail ignores everything after the `+`, so mail to it lands in Spencer's
ordinary inbox. In WEBForms, email the finished forms to that address (or put
`[deal-3f9a1c2b7d]` in the subject) and `server/deal-inbox.ts` imports each
PDF attachment as a draft document within five minutes — or at once with
*Check now* on the deal page. It reads the mailbox through the Google
connection already used for Calendar, with the `gmail.readonly` scope added:
**reconnect Google once from `/admin/scheduling`** and the deal page stops
saying the connection predates the inbox. Read-only: nothing is labelled,
moved or deleted; what has been looked at is recorded in
`deal_inbound_messages` so nothing imports twice.

| Env                          | What it's for |
|------------------------------|---------------|
| `DEAL_INBOX_MAILBOX`         | The mailbox the Google connection reads, default `spencer@riversrealestate.ca` |
| `DEAL_INBOX_ALLOWED_SENDERS` | Optional, comma-separated addresses or `@domains`; mail from anyone else is recorded as rejected. Unset = accept any sender (the address itself is unguessable) |

### Saved layouts

Boxes are placed once per form and saved as a layout, keyed by signer slot
(first buyer, second buyer, first seller…). Applying a layout to the next copy
of that form maps the slots onto its signers; slots with no matching signer
are skipped and reported. Saving under an existing name replaces it.

### Client portal

`/account/documents` lists every document whose signer email matches the
portal user's address (drafts never appear): the private signing link, who
else is signing, and the signed copy once complete. The dashboard card counts
what is waiting on them.

### Follow Up Boss

A deal can be linked to a FUB person (searched in the CRM mirror) and one of
their FUB deals, and to a website lead. This is the one place the app writes
to FUB on its own: when a document completes or a party declines, a note is
posted on the linked person (`server/deal-fub.ts`), so the CRM timeline shows
it without anyone retyping. Needs `FUB_API_KEY`; silently skipped otherwise.

### Offsite backup (required before contracts go in)

Signed contracts are legal records the brokerage must be able to produce for
years, and the SQLite database and every document live on one Fly volume.
`server/backup.ts` copies both to an S3-compatible bucket (Cloudflare R2,
Backblaze B2 or AWS S3) every night at 03:15 Calgary time and whenever a
document completes, encrypted with AES-256-GCM before upload. The status and
a *Back up now* button are at the top of `/admin/deals`; the page shouts if
it is not configured.

| Fly secret               | What it's for |
|--------------------------|---------------|
| `BACKUP_S3_ENDPOINT`     | e.g. `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET`       | bucket name |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | a key scoped to that bucket |
| `BACKUP_S3_REGION`       | `auto` for R2 (default), else the bucket's region |
| `BACKUP_S3_PREFIX`       | key prefix, default `rivers` |
| `BACKUP_ENCRYPTION_KEY`  | 64 hex chars from `openssl rand -hex 32`. **Keep a copy somewhere other than Fly** — without it the backups are unreadable |
| `BACKUP_KEEP_DAYS`       | database snapshots older than this are pruned (default 90; the newest three are always kept) |

Restore on a laptop with the same variables in a local `.env`:

```sh
npx tsx script/restore-backup.ts list
npx tsx script/restore-backup.ts db <object-key> ./rivers.sqlite     # then copy to DB_PATH with the app stopped
npx tsx script/restore-backup.ts documents ./documents               # rebuilds DOCUMENTS_ROOT
```

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
