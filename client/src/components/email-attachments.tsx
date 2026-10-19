// Attachments for an email being written (server/email-attachments.ts).
// Each file uploads as soon as it's picked or dropped; the send then passes
// the ids. Used by the Inbox composer and the CRM contact drawer.

import { useRef, useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { apiUrl, getAuthToken } from "@/lib/queryClient";

const MAX_TOTAL = 25 * 1024 * 1024;

export interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  id: string | null;
  error: string | null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function upload(file: File): Promise<string> {
  const token = getAuthToken();
  const res = await fetch(apiUrl("/api/admin/email-attachments"), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
      "X-File-Type": file.type || "application/octet-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: file,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) throw new Error(data?.message ?? (res.status === 413 ? "Too big for Gmail (25 MB)." : "Upload failed."));
  return data.id;
}

export function useAttachments() {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const total = files.reduce((n, f) => n + (f.error ? 0 : f.size), 0);

  const add = (list: FileList | File[] | null) => {
    let running = total;
    for (const file of Array.from(list ?? [])) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      running += file.size;
      const tooBig = running > MAX_TOTAL ? "Over Gmail's 25 MB total." : null;
      setFiles((xs) => [...xs, { key, name: file.name, size: file.size, id: null, error: tooBig }]);
      if (tooBig) {
        running -= file.size;
        continue;
      }
      upload(file).then(
        (id) => setFiles((xs) => xs.map((x) => (x.key === key ? { ...x, id } : x))),
        (e) => setFiles((xs) => xs.map((x) => (x.key === key ? { ...x, error: String(e?.message ?? e) } : x))),
      );
    }
  };

  const remove = (key: string) => {
    const f = files.find((x) => x.key === key);
    if (f?.id) {
      const token = getAuthToken();
      void fetch(apiUrl(`/api/admin/email-attachments/${f.id}`), {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      }).catch(() => {});
    }
    setFiles((xs) => xs.filter((x) => x.key !== key));
  };

  return {
    files,
    add,
    remove,
    clear: () => setFiles([]),
    /** Ids of the uploaded ones, for the send. */
    ids: files.filter((f) => f.id && !f.error).map((f) => f.id!),
    uploading: files.some((f) => !f.id && !f.error),
    hasErrors: files.some((f) => f.error),
  };
}

export function AttachButton({ onFiles, disabled }: { onFiles: (f: FileList | null) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="px-2.5 py-1 rounded-sm text-[11.5px] flex items-center gap-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-50"
        data-testid="email-attach"
      >
        <Paperclip className="h-3 w-3" /> Attach
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function AttachmentChips({ files, onRemove }: { files: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="email-attachments">
      {files.map((f) => (
        <span
          key={f.key}
          className={`inline-flex items-center gap-1.5 max-w-[260px] rounded-sm border px-2 py-0.5 text-[11.5px] ${
            f.error ? "border-destructive/50 text-destructive" : "border-border"
          }`}
          title={f.error ?? f.name}
        >
          {!f.id && !f.error ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <Paperclip className="h-3 w-3 shrink-0" />}
          <span className="truncate">{f.name}</span>
          <span className="text-muted-foreground shrink-0">{f.error ? f.error : formatBytes(f.size)}</span>
          <button type="button" onClick={() => onRemove(f.key)} aria-label={`Remove ${f.name}`} className="shrink-0 hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
