import { useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";

/** An admin-only image (or PDF) as an object URL: <img src> can't send the bearer token. */
export function useAuthedImage(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    if (!path) {
      setUrl(null);
      return;
    }
    setLoading(true);
    setError(null);
    apiRequest("GET", path)
      .then((r) => r.blob())
      .then((b) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(b);
        setUrl(revoked);
      })
      .catch((e) => !cancelled && setError(apiErrorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [path]);
  return { url, loading, error };
}

/** Fetch an admin-only file and hand it to the browser as a download. */
export async function downloadAuthed(path: string, filename: string): Promise<void> {
  const blob = await (await apiRequest("GET", path)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
