// Push notifications in the browser (server/push.ts): the admin's own Home
// Screen app identity, the service worker, and subscribing this device.
//
// On an iPhone, push only works in the admin added to the Home Screen from
// Safari's Share menu (iOS 16.4+), and turning it on must come from a tap
// inside that installed app.

const ADMIN_MANIFEST = "/admin.webmanifest";
const SW_URL = "/admin-sw.js";

/**
 * While an admin page is showing: point the page at the admin's manifest, so
 * "Add to Home Screen" makes a Rivers Admin app that opens the dashboard
 * (not the public site), and register the service worker. Returns an undo.
 */
export function applyAdminAppIdentity(): () => void {
  if (typeof document === "undefined") return () => {};
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  const title = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  const prev = { href: link?.getAttribute("href"), title: title?.getAttribute("content") };
  link?.setAttribute("href", ADMIN_MANIFEST);
  title?.setAttribute("content", "Rivers Admin");
  let capable = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-capable"]');
  const addedCapable = !capable;
  if (!capable) {
    capable = document.createElement("meta");
    capable.name = "apple-mobile-web-app-capable";
    capable.content = "yes";
    document.head.appendChild(capable);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(SW_URL, { scope: "/admin" }).catch(() => {});
  }
  return () => {
    if (prev.href) link?.setAttribute("href", prev.href);
    if (prev.title) title?.setAttribute("content", prev.title);
    if (addedCapable) capable?.remove();
  };
}

export const isIOS = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Running as an installed Home Screen app, not a browser tab. */
export const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true);

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export type PushState =
  | "install-first" // iPhone in Safari: add to Home Screen and open from there
  | "unsupported" // this browser can't
  | "blocked" // permission denied
  | "off" // can be turned on
  | "on"; // subscribed

export async function currentPushState(): Promise<{ state: PushState; endpoint: string | null }> {
  if (isIOS() && !isStandalone()) return { state: "install-first", endpoint: null };
  if (!pushSupported()) return { state: "unsupported", endpoint: null };
  if (Notification.permission === "denied") return { state: "blocked", endpoint: null };
  const reg = await navigator.serviceWorker.getRegistration("/admin");
  const sub = await reg?.pushManager.getSubscription();
  return sub ? { state: "on", endpoint: sub.endpoint } : { state: "off", endpoint: null };
}

function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Ask permission (must run from a tap) and subscribe this device. */
export async function subscribeThisDevice(publicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications were blocked." : "Notifications weren't allowed.");
  const reg = (await navigator.serviceWorker.getRegistration("/admin")) ?? (await navigator.serviceWorker.register(SW_URL, { scope: "/admin" }));
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  return sub.toJSON();
}

export async function unsubscribeThisDevice(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration("/admin");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

/** A name for this device in the list, e.g. "iPhone" or "Mac · Chrome". */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  const browser = isStandalone() ? "Home Screen app" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${device} · ${browser}`;
}
