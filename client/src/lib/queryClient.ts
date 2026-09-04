import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/**
 * Prefix a relative API path with the production port-rewrite base.
 * Use this for any direct browser fetch (e.g. <img src>, <a href> for downloads)
 * that does NOT go through apiRequest. apiRequest handles this automatically.
 */
export function apiUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Bearer token. Persisted in localStorage so sessions survive page reloads
// on the Fly.io deploy. Falls back to a window-scoped variable if storage
// isn't available (private browsing, etc.).
const TOKEN_KEY = "rivers.auth.token";
let authToken: string | null = (() => {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
})();

export function setAuthToken(token: string | null) {
  authToken = token;
  try {
    if (typeof window !== "undefined") {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    }
  } catch {}
}

export function getAuthToken() {
  return authToken;
}

function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    credentials: "include",
    headers: buildHeaders(data !== undefined),
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      credentials: "include",
      headers: buildHeaders(false),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Pull the human-readable message out of an apiRequest rejection.
 *
 * apiRequest throws `Error("409: {\"message\":\"…\"}")` — the status plus the
 * raw response body. Callers that show the message to a user want just the
 * message; anything unparseable falls back to the raw text.
 */
export function apiErrorMessage(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = String((e as any)?.message ?? "");
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed?.message === "string" && parsed.message) return parsed.message;
    } catch {
      /* not JSON — fall through to the raw text */
    }
  }
  return raw || fallback;
}
