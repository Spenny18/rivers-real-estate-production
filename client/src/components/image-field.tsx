// Image field with an upload button — the one place the CMS puts a picture
// into a content row.
//
// This lived inside admin-home.tsx, so /admin/home was the only editor that
// could actually upload anything. Blog, neighbourhood and condo hero images
// were bare text inputs expecting a URL pasted from somewhere else, which in
// practice meant opening the homepage editor purely to use its upload button
// and copying the resulting path out. Same component, now shared.
//
// Uploads POST a base64 data URL to /api/admin/media, which writes the file to
// the persistent volume and returns its public /uploads/... path. Typing or
// pasting a URL by hand still works — an external https:// URL is a valid
// value and some rows legitimately use one.
import { useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export function ImageField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Max 10MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the file"));
        reader.readAsDataURL(file);
      });
      const res = await apiRequest("POST", "/api/admin/media", {
        dataUrl,
        name: file.name.replace(/\.[^.]+$/, ""),
      });
      const { url } = (await res.json()) as { url: string };
      onChange(url);
      toast({ title: "Image uploaded" });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <Input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… or /uploads/…"
          className="h-10 text-[13px]"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-10 w-10 shrink-0"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          title="Upload an image"
        >
          {uploading ? (
            <RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.6} />
          ) : (
            <Upload className="w-4 h-4" strokeWidth={1.6} />
          )}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      {value ? (
        <div className="mt-2 aspect-[16/9] rounded-sm overflow-hidden border border-border bg-secondary">
          <img
            src={value}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0.25")}
          />
        </div>
      ) : null}
    </div>
  );
}
