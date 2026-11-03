// Push notifications to Spencer's phone (and any browser he turns them on in),
// through the admin installed as a Home Screen web app.
//
// iPhones get Web Push from iOS 16.4 for a site added to the Home Screen from
// Safari's Share menu; the admin has its own manifest for that
// (client/public/admin.webmanifest) and a service worker
// (client/public/admin-sw.js) that shows each notification and opens its
// link when tapped. Turning notifications on has to be a tap inside the
// installed app; that registers a subscription here.
//
// The VAPID key pair that signs pushes is made once and kept in app_secrets,
// like the session secret, so there's nothing to configure. web-push does
// the payload encryption.
//
// What notifies, each with its own switch:
//   lead       a new lead (lead-alerts.ts, alongside the text alert)
//   text       a text to the business line (sms.ts)
//   email      a new email from a contact in the Inbox (gmail-inbox.ts)
//   call       a missed call or a voicemail (twilio-routes.ts)
//   task       a task coming due (checked every few minutes here)
//
// Dead subscriptions (the push service answers 404 or 410: the app was
// removed or notifications turned off) are dropped on the next send.

import webpush from "web-push";
import { sqlite } from "./storage";
import { AGENT } from "./brand";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    last_ok_at TEXT,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS push_settings (
    kind TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_task_sent (
    uid TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL
  );
`);

export const PUSH_KINDS = {
  lead: "New leads",
  text: "Texts to the business line",
  email: "New emails from contacts",
  call: "Missed calls and voicemails",
  task: "Tasks coming due",
} as const;
export type PushKind = keyof typeof PUSH_KINDS;

// ---- Keys --------------------------------------------------------------------------------

let keys: { publicKey: string; privateKey: string } | null = null;

export function vapidKeys(): { publicKey: string; privateKey: string } {
  if (keys) return keys;
  const get = (k: string) => (sqlite.prepare(`SELECT value FROM app_secrets WHERE key = ?`).get(k) as { value: string } | undefined)?.value;
  let pub = get("vapid_public_key");
  let priv = get("vapid_private_key");
  if (!pub || !priv) {
    const made = webpush.generateVAPIDKeys();
    const now = new Date().toISOString();
    const put = sqlite.prepare(`INSERT OR REPLACE INTO app_secrets (key, value, created_at) VALUES (?, ?, ?)`);
    sqlite.transaction(() => {
      put.run("vapid_public_key", made.publicKey, now);
      put.run("vapid_private_key", made.privateKey, now);
    })();
    pub = made.publicKey;
    priv = made.privateKey;
  }
  keys = { publicKey: pub, privateKey: priv };
  return keys;
}

// ---- Settings and devices ------------------------------------------------------------------

export function pushSettings(): Record<PushKind, boolean> {
  const rows = sqlite.prepare(`SELECT kind, enabled FROM push_settings`).all() as Array<{ kind: string; enabled: number }>;
  const out = Object.fromEntries(Object.keys(PUSH_KINDS).map((k) => [k, true])) as Record<PushKind, boolean>;
  for (const r of rows) if (r.kind in out) out[r.kind as PushKind] = !!r.enabled;
  return out;
}

export function savePushSettings(patch: Partial<Record<PushKind, boolean>>) {
  const set = sqlite.prepare(`INSERT INTO push_settings (kind, enabled) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET enabled = excluded.enabled`);
  for (const [k, v] of Object.entries(patch)) if (k in PUSH_KINDS && typeof v === "boolean") set.run(k, v ? 1 : 0);
  return pushSettings();
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(sub: PushSubscriptionInput, label: string | null) {
  sqlite
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = COALESCE(excluded.label, push_subscriptions.label), last_error = NULL`,
    )
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, label?.slice(0, 80) ?? null, new Date().toISOString());
}

export function removeSubscription(endpoint: string): boolean {
  return sqlite.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint).changes > 0;
}

export function listDevices() {
  return (
    sqlite.prepare(`SELECT endpoint, label, created_at AS createdAt, last_ok_at AS lastOkAt, last_error AS lastError FROM push_subscriptions ORDER BY created_at`).all() as Array<{
      endpoint: string;
      label: string | null;
      createdAt: string;
      lastOkAt: string | null;
      lastError: string | null;
    }>
  ).map((d) => ({ ...d, service: serviceOf(d.endpoint) }));
}

/** Which push service a subscription uses, for telling devices apart. */
function serviceOf(endpoint: string): string {
  try {
    const h = new URL(endpoint).hostname;
    if (h.endsWith("push.apple.com")) return "Apple (iPhone, iPad or Mac)";
    if (h.includes("googleapis") || h.includes("google")) return "Chrome";
    if (h.includes("mozilla")) return "Firefox";
    if (h.includes("windows")) return "Edge";
    return h;
  } catch {
    return "Unknown";
  }
}

// ---- Sending ----------------------------------------------------------------------------------

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping it goes, a path in the admin. */
  url?: string;
  /** Notifications with the same tag replace each other (one per conversation). */
  tag?: string;
}

/** Send to every device, for one kind if it's switched on. Never throws. */
export async function notify(kind: PushKind | "test", msg: PushMessage): Promise<{ sent: number; failed: number }> {
  try {
    if (kind !== "test" && !pushSettings()[kind]) return { sent: 0, failed: 0 };
    const subs = sqlite.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`).all() as Array<{ endpoint: string; p256dh: string; auth: string }>;
    if (subs.length === 0) return { sent: 0, failed: 0 };
    const k = vapidKeys();
    const payload = JSON.stringify({
      title: msg.title.slice(0, 120),
      body: msg.body.slice(0, 400),
      url: msg.url ?? "/admin",
      tag: msg.tag ?? kind,
    });
    let sent = 0;
    let failed = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            vapidDetails: { subject: `mailto:${AGENT.email}`, publicKey: k.publicKey, privateKey: k.privateKey },
            TTL: 24 * 3600,
            urgency: kind === "task" ? "normal" : "high",
          });
          sqlite.prepare(`UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE endpoint = ?`).run(new Date().toISOString(), s.endpoint);
          sent++;
        } catch (e: any) {
          failed++;
          const code = e?.statusCode;
          if (code === 404 || code === 410) removeSubscription(s.endpoint);
          else sqlite.prepare(`UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?`).run(String(e?.body || e?.message || e).slice(0, 300), s.endpoint);
        }
      }),
    );
    return { sent, failed };
  } catch (e: any) {
    console.warn("[push] notify failed:", e?.message ?? e);
    return { sent: 0, failed: 0 };
  }
}

/** Fire and forget, for hooks in request paths. */
export function notifyLater(kind: PushKind, msg: PushMessage) {
  notify(kind, msg).catch(() => {});
}

// ---- Tasks coming due -------------------------------------------------------------------------

/** Tasks due in the last few minutes (or the next minute) that haven't been pushed. */
export async function pushDueTasks(now = new Date()): Promise<number> {
  if (!pushSettings().task) return 0;
  const rows = sqlite
    .prepare(
      `SELECT a.uid, a.title, a.contact_fub_id AS contactId, c.name AS contactName FROM crm_activities a
       LEFT JOIN crm_contacts c ON c.fub_id = a.contact_fub_id
       WHERE a.kind = 'task' AND a.completed = 0 AND a.due_at > ? AND a.due_at <= ?
         AND a.uid NOT IN (SELECT uid FROM push_task_sent)
       ORDER BY a.due_at LIMIT 10`,
    )
    .all(new Date(now.getTime() - 30 * 60_000).toISOString(), new Date(now.getTime() + 60_000).toISOString()) as Array<{
    uid: string;
    title: string | null;
    contactId: string | null;
    contactName: string | null;
  }>;
  const mark = sqlite.prepare(`INSERT OR IGNORE INTO push_task_sent (uid, sent_at) VALUES (?, ?)`);
  for (const t of rows) {
    mark.run(t.uid, now.toISOString());
    await notify("task", {
      title: `Task due${t.contactName ? `: ${t.contactName}` : ""}`,
      body: t.title ?? "A task is due",
      url: t.contactId ? `/admin/crm?contact=${encodeURIComponent(t.contactId)}` : "/admin/crm?tab=tasks",
      tag: `task:${t.uid}`,
    });
  }
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;
export function startPushCron() {
  if (timer) return;
  timer = setInterval(() => {
    pushDueTasks().catch((e) => console.warn("[push] due tasks:", e?.message ?? e));
  }, 5 * 60_000);
  timer.unref?.();
}
