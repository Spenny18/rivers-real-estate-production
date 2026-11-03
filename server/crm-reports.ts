// CRM reports: how leads arrive and how fast they're answered, the app's
// version of Follow Up Boss's Reporting.
//
// For a period (the last N days):
//   summary         new leads, how many were contacted, median time to first
//                   contact, calls / texts / emails each way
//   speed to lead   leads by how soon they were first contacted
//   sources         per lead source: leads, contacted, median response, and
//                   how many are now active clients or further along
//   weeks           new leads and outbound contact, week by week
//   stages          every contact by current stage (the whole database)
//   waiting         recent leads nobody has contacted yet, oldest first
//
// Everything is counted from crm_activities, the one history both systems
// write to: Follow Up Boss's mirrored calls, texts and emails, plus the app's
// own business-line texts and calls and emails sent from the app (each logged
// onto the contact as it happens). Emails the app sends can also come back
// through FUB's own Gmail sync, so emails are counted once per contact,
// direction and 10-minute window.
//
// A "lead" is a contact created in the period. "Contacted" means a call, text
// or email went out to them after they arrived; automated texts and emails
// from automations count, since that's contact they received. Where a lead
// "is now" is their stage today: stage history isn't kept, so this is where
// each source's leads stand, not a conversion rate over time.

import { sqlite } from "./storage";

const DAY = 86400_000;

/** Stages that mean a lead turned into business, matched ignoring case. */
const WON = ["active client", "active", "under contract", "pending", "closed", "past client"];

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Monday 00:00 UTC of the week holding `d`, as YYYY-MM-DD. */
function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

interface LeadRow {
  id: string;
  name: string | null;
  source: string | null;
  stage: string | null;
  created: string;
  firstOut: string | null;
}

export interface Report {
  period: { days: number; from: string; to: string };
  summary: {
    newLeads: number;
    contacted: number;
    medianResponseMinutes: number | null;
    calls: { out: number; in: number };
    texts: { out: number; in: number };
    emails: { out: number; in: number };
    tasksOpen: number;
    tasksOverdue: number;
  };
  speed: Array<{ label: string; count: number }>;
  sources: Array<{ source: string; leads: number; contacted: number; medianResponseMinutes: number | null; nowActive: number }>;
  weeks: Array<{ week: string; newLeads: number; calls: number; texts: number; emails: number }>;
  stages: Array<{ stage: string; count: number }>;
  waiting: Array<{ id: string; name: string | null; source: string | null; created: string }>;
}

export function buildReport(days: number, now = new Date()): Report {
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * DAY).toISOString();

  // Leads in the period, with their first outbound contact after arriving
  // (a minute's grace: an auto-reply can be stamped a moment before the contact).
  const leads = sqlite
    .prepare(
      `SELECT c.fub_id AS id, c.name, c.source, c.stage, c.fub_created_at AS created,
              (SELECT MIN(a.occurred_at) FROM crm_activities a
                WHERE a.contact_fub_id = c.fub_id AND a.kind IN ('call','text','email') AND a.direction = 'outbound'
                  AND a.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', c.fub_created_at, '-1 minute')) AS firstOut
       FROM crm_contacts c
       WHERE c.fub_created_at >= ? AND c.fub_created_at <= ?`,
    )
    .all(from, to) as LeadRow[];

  const responseMins = (l: LeadRow) => (l.firstOut ? Math.max(0, (Date.parse(l.firstOut) - Date.parse(l.created)) / 60_000) : null);
  const responded = leads.map(responseMins).filter((m): m is number => m !== null);

  // Activity in the period. Emails once per contact, direction and 10 minutes.
  const counts = sqlite
    .prepare(
      `SELECT kind, direction, COUNT(*) AS n FROM (
         SELECT kind, direction, uid FROM crm_activities
          WHERE kind IN ('call','text') AND occurred_at >= ? AND occurred_at <= ?
         UNION ALL
         SELECT 'email', direction, MIN(uid) FROM crm_activities
          WHERE kind = 'email' AND occurred_at >= ? AND occurred_at <= ?
          GROUP BY contact_fub_id, direction, substr(occurred_at, 1, 15)
       ) GROUP BY kind, direction`,
    )
    .all(from, to, from, to) as Array<{ kind: string; direction: string | null; n: number }>;
  const c = (kind: string, dir: string) => counts.filter((r) => r.kind === kind && r.direction === dir).reduce((s, r) => s + r.n, 0);

  const tasks = sqlite
    .prepare(
      `SELECT SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN completed = 0 AND due_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM crm_activities WHERE kind = 'task'`,
    )
    .get(to) as { open: number | null; overdue: number | null };

  // Speed to lead.
  const buckets = [
    { label: "Within 5 minutes", max: 5 },
    { label: "5 to 60 minutes", max: 60 },
    { label: "1 to 24 hours", max: 1440 },
    { label: "Over a day", max: Infinity },
  ];
  const speed = buckets.map((b, i) => ({
    label: b.label,
    count: leads.filter((l) => {
      const m = responseMins(l);
      return m !== null && m <= b.max && (i === 0 || m > buckets[i - 1].max);
    }).length,
  }));
  speed.push({ label: "Not contacted yet", count: leads.filter((l) => !l.firstOut).length });

  // By source: the 12 biggest, the rest as "Other".
  const bySource = new Map<string, LeadRow[]>();
  for (const l of leads) {
    const s = l.source?.trim() || "Unknown";
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s)!.push(l);
  }
  let sourceRows: Array<[string, LeadRow[]]> = Array.from(bySource.entries()).sort((a, b) => b[1].length - a[1].length);
  if (sourceRows.length > 12) {
    const rest = sourceRows.slice(11).flatMap(([, ls]) => ls);
    sourceRows = [...sourceRows.slice(0, 11), ["Other", rest]];
  }
  const sources = sourceRows.map(([source, ls]) => ({
    source,
    leads: ls.length,
    contacted: ls.filter((l) => l.firstOut).length,
    medianResponseMinutes: median(ls.map(responseMins).filter((m): m is number => m !== null)),
    nowActive: ls.filter((l) => WON.includes((l.stage ?? "").toLowerCase())).length,
  }));

  // Week by week (outbound contact only: what Spencer did).
  const weekMap = new Map<string, { newLeads: number; calls: number; texts: number; emails: number }>();
  for (let t = new Date(from).getTime(); t <= now.getTime() + 7 * DAY; t += 7 * DAY) {
    const w = weekOf(new Date(t).toISOString());
    if (w <= to.slice(0, 10)) weekMap.set(w, { newLeads: 0, calls: 0, texts: 0, emails: 0 });
  }
  for (const l of leads) weekMap.get(weekOf(l.created)) && weekMap.get(weekOf(l.created))!.newLeads++;
  const outbound = sqlite
    .prepare(
      `SELECT kind, occurred_at AS at FROM crm_activities
        WHERE kind IN ('call','text') AND direction = 'outbound' AND occurred_at >= ? AND occurred_at <= ?
       UNION ALL
       SELECT 'email', MIN(occurred_at) FROM crm_activities
        WHERE kind = 'email' AND direction = 'outbound' AND occurred_at >= ? AND occurred_at <= ?
        GROUP BY contact_fub_id, substr(occurred_at, 1, 15)`,
    )
    .all(from, to, from, to) as Array<{ kind: string; at: string }>;
  for (const a of outbound) {
    const w = weekMap.get(weekOf(a.at));
    if (!w) continue;
    if (a.kind === "call") w.calls++;
    else if (a.kind === "text") w.texts++;
    else w.emails++;
  }
  const weeks = Array.from(weekMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([week, v]) => ({ week, ...v }));

  const stages = sqlite
    .prepare(`SELECT COALESCE(NULLIF(trim(stage), ''), 'No stage') AS stage, COUNT(*) AS count FROM crm_contacts GROUP BY lower(COALESCE(NULLIF(trim(stage), ''), 'No stage')) ORDER BY count DESC`)
    .all() as Array<{ stage: string; count: number }>;

  const waiting = leads
    .filter((l) => !l.firstOut && (l.stage ?? "").toLowerCase() !== "trash")
    .sort((a, b) => a.created.localeCompare(b.created))
    .slice(0, 15)
    .map((l) => ({ id: l.id, name: l.name, source: l.source, created: l.created }));

  return {
    period: { days, from, to },
    summary: {
      newLeads: leads.length,
      contacted: leads.filter((l) => l.firstOut).length,
      medianResponseMinutes: median(responded),
      calls: { out: c("call", "outbound"), in: c("call", "inbound") },
      texts: { out: c("text", "outbound"), in: c("text", "inbound") },
      emails: { out: c("email", "outbound"), in: c("email", "inbound") },
      tasksOpen: tasks.open ?? 0,
      tasksOverdue: tasks.overdue ?? 0,
    },
    speed,
    sources,
    weeks,
    stages,
    waiting,
  };
}
