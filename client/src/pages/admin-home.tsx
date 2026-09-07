/**
 * /admin/home — visual page builder for the public homepage.
 *
 * Three panes, Elementor-style:
 *   left    section list (drag to reorder, hide, duplicate, delete, add)
 *           plus the SEO panel and the revision history
 *   centre  a live preview of the real homepage in an iframe. The draft is
 *           pushed over postMessage on every keystroke, so what you see is
 *           the actual site rendering the unsaved content. Clicking a
 *           section in the preview selects it here.
 *   right   settings for the selected section, generated from the field
 *           definitions in shared/home-content.ts — add a field there and it
 *           appears here with no changes to this file.
 *
 * Nothing is published until Save; every save snapshots the previous version
 * so it can be restored from the History tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  GripVertical,
  History,
  Image as ImageIcon,
  Laptop,
  Layers,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Smartphone,
  Trash2,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ICONS } from "@/components/home-blocks";
import { ImageField } from "@/components/image-field";
import {
  BLOCK_TYPES,
  ICON_CHOICES,
  STYLE_FIELDS,
  blockTitle,
  getBlockType,
  newBlock,
  type BlockCategory,
  type FieldDef,
  type PageBlock,
  type PageContent,
} from "@shared/home-content";

const PAGE_SLUG = "home";
const STYLE_KEYS = new Set(STYLE_FIELDS.map((f) => f.key));

const DEVICES = [
  { id: "desktop", label: "Desktop", icon: Monitor, width: "100%" },
  { id: "tablet", label: "Tablet", icon: Laptop, width: "834px" },
  { id: "mobile", label: "Mobile", icon: Smartphone, width: "414px" },
] as const;
type DeviceId = (typeof DEVICES)[number]["id"];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Field inputs
// ---------------------------------------------------------------------------

function FieldLabel({ field }: { field: FieldDef }) {
  return (
    <Label className="text-[10px] font-display tracking-[0.18em] text-muted-foreground">
      {field.label.toUpperCase()}
    </Label>
  );
}

function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const Current = ICONS[value] ?? ICONS.Sparkles;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-10 w-full justify-start gap-2">
          <Current className="w-4 h-4" strokeWidth={1.6} />
          <span className="text-[12px]">{value || "Sparkles"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <div className="grid grid-cols-5 gap-1">
          {ICON_CHOICES.map((name) => {
            const Icon = ICONS[name];
            if (!Icon) return null;
            return (
              <button
                key={name}
                type="button"
                title={name}
                onClick={() => onChange(name)}
                className={`h-10 rounded-sm flex items-center justify-center hover:bg-muted transition-colors ${
                  value === name ? "bg-muted ring-1 ring-foreground/30" : ""
                }`}
              >
                <Icon className="w-4 h-4" strokeWidth={1.6} />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}


function ListEditor({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: any[];
  onChange: (v: any[]) => void;
}) {
  const items = Array.isArray(value) ? value : [];
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    onChange(next);
    setOpenIndex(to);
  };

  const addItem = () => {
    const blank =
      field.itemType === "text"
        ? ""
        : Object.fromEntries((field.itemFields ?? []).map((f) => [f.key, defaultFor(f)]));
    onChange([...items, blank]);
    setOpenIndex(items.length);
  };

  if (field.itemType === "text") {
    return (
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2">
            <Textarea
              rows={2}
              value={String(item ?? "")}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
              className="text-[13px] leading-relaxed"
            />
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => move(i, i - 1)}
              >
                <ArrowUp className="w-3.5 h-3.5" strokeWidth={1.6} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.6} />
              </Button>
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={addItem}>
          <Plus className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.8} />
          Add {field.itemLabel ?? "item"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const titleKey = field.itemTitleKey ?? field.itemFields?.[0]?.key ?? "";
        const title = String(item?.[titleKey] ?? "").trim() || `${field.itemLabel ?? "Item"} ${i + 1}`;
        const open = openIndex === i;
        return (
          <div key={i} className="border border-border rounded-sm">
            <div className="flex items-center gap-1 px-2 py-1.5 bg-muted/40">
              <button
                type="button"
                className="flex-1 text-left text-[12px] truncate py-1"
                onClick={() => setOpenIndex(open ? null : i)}
              >
                {title}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => move(i, i - 1)}
                title="Move up"
              >
                <ArrowUp className="w-3 h-3" strokeWidth={1.8} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => move(i, i + 1)}
                title="Move down"
              >
                <ArrowDown className="w-3 h-3" strokeWidth={1.8} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => {
                  onChange(items.filter((_, j) => j !== i));
                  setOpenIndex(null);
                }}
                title="Delete"
              >
                <Trash2 className="w-3 h-3" strokeWidth={1.8} />
              </Button>
            </div>
            {open ? (
              <div className="p-3 space-y-3">
                {(field.itemFields ?? []).map((f) => (
                  <div key={f.key}>
                    <FieldLabel field={f} />
                    <div className="mt-1">
                      <FieldInput
                        field={f}
                        value={item?.[f.key]}
                        onChange={(v) => {
                          const next = [...items];
                          next[i] = { ...(next[i] ?? {}), [f.key]: v };
                          onChange(next);
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={addItem}>
        <Plus className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.8} />
        Add {field.itemLabel ?? "item"}
      </Button>
    </div>
  );
}

function defaultFor(field: FieldDef): any {
  switch (field.type) {
    case "switch":
      return false;
    case "number":
      return field.min ?? 0;
    case "list":
    case "paragraphs":
      return [];
    case "select":
      return field.options?.[0]?.value ?? "";
    case "icon":
      return "Sparkles";
    default:
      return "";
  }
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: any;
  onChange: (v: any) => void;
}) {
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          rows={field.rows ?? 3}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="text-[13px] leading-relaxed"
        />
      );
    case "paragraphs":
      return (
        <Textarea
          rows={field.rows ?? 6}
          value={(Array.isArray(value) ? value : []).join("\n\n")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/\n\s*\n/)
                .map((p) => p.trim())
                .filter(Boolean),
            )
          }
          placeholder="One paragraph per blank line"
          className="text-[13px] leading-relaxed"
        />
      );
    case "image":
      return <ImageField value={String(value ?? "")} onChange={onChange} />;
    case "number":
      return (
        <Input
          type="number"
          min={field.min}
          max={field.max}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          className="h-10 text-[13px]"
        />
      );
    case "switch":
      return (
        <div className="h-10 flex items-center">
          <Switch checked={value === true} onCheckedChange={onChange} />
        </div>
      );
    case "select":
      return (
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger className="h-10 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "icon":
      return <IconPicker value={String(value ?? "Sparkles")} onChange={onChange} />;
    case "list":
      return <ListEditor field={field} value={value} onChange={onChange} />;
    default:
      return (
        <Input
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="h-10 text-[13px]"
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function BlockSettings({
  block,
  onChange,
}: {
  block: PageBlock;
  onChange: (data: Record<string, any>) => void;
}) {
  const def = getBlockType(block.type);
  const [tab, setTab] = useState<"content" | "style">("content");
  if (!def) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Unknown section type “{block.type}”.
      </div>
    );
  }
  const contentFields = def.fields.filter((f) => !STYLE_KEYS.has(f.key));
  const styleFields = def.fields.filter((f) => STYLE_KEYS.has(f.key));
  const fields = tab === "content" ? contentFields : styleFields;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-3 border-b border-border">
        <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">
          SECTION SETTINGS
        </div>
        <div className="mt-1.5 font-serif text-[18px] leading-tight">{def.label}</div>
        <p className="mt-1 text-[12px] text-muted-foreground leading-snug">
          {def.description}
        </p>
        {def.dataSource ? (
          <p className="mt-2 text-[11px] text-muted-foreground border-l-2 border-border pl-2 leading-snug">
            {def.dataSource}
          </p>
        ) : null}
        {styleFields.length > 0 ? (
          <div className="mt-3 flex gap-1 bg-muted/50 p-1 rounded-sm">
            {(["content", "style"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-1.5 rounded-sm font-display text-[10px] tracking-[0.18em] transition-colors ${
                  tab === t ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {fields.map((field) => (
          <div key={field.key}>
            <FieldLabel field={field} />
            <div className="mt-1.5">
              <FieldInput
                field={field}
                value={block.data[field.key]}
                onChange={(v) => onChange({ ...block.data, [field.key]: v })}
              />
            </div>
            {field.help ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug">
                {field.help}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function SeoPanel({
  seo,
  onChange,
}: {
  seo: PageContent["seo"];
  onChange: (patch: Partial<PageContent["seo"]>) => void;
}) {
  const titleLen = seo.title.length;
  const descLen = seo.description.length;
  const counter = (len: number, min: number, max: number) =>
    len === 0
      ? "text-muted-foreground"
      : len < min || len > max
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div className="p-4 space-y-5">
      <div>
        <div className="flex items-baseline justify-between">
          <Label className="text-[10px] font-display tracking-[0.18em] text-muted-foreground">
            TITLE TAG
          </Label>
          <span className={`text-[10px] tabular-nums ${counter(titleLen, 30, 60)}`}>
            {titleLen}/60
          </span>
        </div>
        <Textarea
          rows={2}
          value={seo.title}
          onChange={(e) => onChange({ title: e.target.value })}
          className="mt-1.5 text-[13px]"
        />
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <Label className="text-[10px] font-display tracking-[0.18em] text-muted-foreground">
            META DESCRIPTION
          </Label>
          <span className={`text-[10px] tabular-nums ${counter(descLen, 70, 160)}`}>
            {descLen}/160
          </span>
        </div>
        <Textarea
          rows={4}
          value={seo.description}
          onChange={(e) => onChange({ description: e.target.value })}
          className="mt-1.5 text-[13px]"
        />
      </div>

      {/* Search-result preview — the same strings crawlers get from the
          server-rendered <head>. */}
      <div className="border border-border rounded-sm p-3 bg-muted/30">
        <div className="font-display text-[9px] tracking-[0.2em] text-muted-foreground mb-2">
          SEARCH PREVIEW
        </div>
        <div className="text-[12px] text-muted-foreground truncate">
          riversrealestate.ca
        </div>
        <div className="text-[15px] text-[#1a0dab] dark:text-[#8ab4f8] leading-snug line-clamp-2">
          {seo.title || "Untitled page"}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground leading-snug line-clamp-3">
          {seo.description || "No description set."}
        </div>
      </div>

      <div>
        <Label className="text-[10px] font-display tracking-[0.18em] text-muted-foreground">
          SOCIAL SHARE IMAGE
        </Label>
        <div className="mt-1.5">
          <ImageField value={seo.ogImage} onChange={(v) => onChange({ ogImage: v })} />
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          1200×630 works best. Leave blank to use the brand card.
        </p>
      </div>

      <div>
        <Label className="text-[10px] font-display tracking-[0.18em] text-muted-foreground">
          CANONICAL URL
        </Label>
        <Input
          value={seo.canonical}
          onChange={(e) => onChange({ canonical: e.target.value })}
          placeholder="https://riversrealestate.ca/"
          className="mt-1.5 h-10 text-[13px]"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Leave blank to use the page's own URL.
        </p>
      </div>

      <div>
        <Label className="text-[10px] font-display tracking-[0.18em] text-muted-foreground">
          KEYWORDS (INTERNAL NOTE)
        </Label>
        <Input
          value={seo.keywords}
          onChange={(e) => onChange({ keywords: e.target.value })}
          placeholder="calgary luxury homes, springbank hill…"
          className="mt-1.5 h-10 text-[13px]"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Not emitted as a meta tag — search engines ignore those. Kept as a
          note for whoever writes the next revision.
        </p>
      </div>

      <div className="flex items-start gap-3 border border-border rounded-sm p-3">
        <Switch
          checked={seo.noindex}
          onCheckedChange={(v) => onChange({ noindex: v })}
          id="noindex"
        />
        <div>
          <Label htmlFor="noindex" className="text-[13px]">
            Hide from search engines
          </Label>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
            Adds noindex,nofollow. Only for a page you don't want indexed —
            this is the homepage, so leave it off.
          </p>
        </div>
      </div>
    </div>
  );
}

interface RevisionRow {
  id: number;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  blockCount: number;
}

function HistoryPanel({
  onRestore,
  restoring,
}: {
  onRestore: (id: number) => void;
  restoring: boolean;
}) {
  const { data, isLoading } = useQuery<RevisionRow[]>({
    queryKey: ["/api/admin/pages", PAGE_SLUG, "revisions"],
  });
  const rows = data ?? [];
  return (
    <div className="p-4">
      <p className="text-[12px] text-muted-foreground leading-snug">
        A snapshot is taken before every save. Restoring one puts that version
        back — and snapshots the current page first, so a restore is undoable
        too.
      </p>
      <div className="mt-4 space-y-2">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
        ) : rows.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">No saves yet.</div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="border border-border rounded-sm p-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-[12px]">
                  {new Date(r.createdAt).toLocaleString()}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {r.blockCount} sections{r.createdBy ? ` · ${r.createdBy}` : ""}
                  {r.label ? ` · ${r.label}` : ""}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={restoring}
                onClick={() => onRestore(r.id)}
              >
                <RotateCcw className="w-3 h-3 mr-1.5" strokeWidth={1.8} />
                Restore
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AddSectionDialog({
  open,
  onOpenChange,
  existingTypes,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingTypes: Set<string>;
  onAdd: (type: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const categories = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = BLOCK_TYPES.filter(
      (b) =>
        !q ||
        b.label.toLowerCase().includes(q) ||
        b.description.toLowerCase().includes(q),
    );
    const grouped = new Map<BlockCategory, typeof BLOCK_TYPES>();
    for (const b of matches) {
      const list = grouped.get(b.category) ?? [];
      list.push(b);
      grouped.set(b.category, list);
    }
    return Array.from(grouped.entries());
  }, [filter]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85dvh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">Add a section</DialogTitle>
          <DialogDescription>
            Sections drop in at the bottom of the page — drag them into place
            afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            strokeWidth={1.6}
          />
          <Input
            autoFocus
            placeholder="Search sections…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <div className="flex-1 overflow-y-auto -mx-6 px-6 pb-2">
          {categories.map(([category, blocks]) => (
            <div key={category} className="mt-5 first:mt-2">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground mb-2">
                {category.toUpperCase()}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {blocks.map((b) => {
                  const Icon = ICONS[b.icon] ?? Layers;
                  const disabled = Boolean(b.singleton && existingTypes.has(b.type));
                  return (
                    <button
                      key={b.type}
                      disabled={disabled}
                      onClick={() => {
                        onAdd(b.type);
                        onOpenChange(false);
                      }}
                      className={`text-left border border-border rounded-sm p-3 flex gap-3 transition-colors ${
                        disabled
                          ? "opacity-40 cursor-not-allowed"
                          : "hover:border-foreground/40 hover:bg-muted/40"
                      }`}
                      data-testid={`add-block-${b.type}`}
                    >
                      <span className="mt-0.5 w-8 h-8 shrink-0 rounded-sm border border-border flex items-center justify-center">
                        <Icon className="w-4 h-4" strokeWidth={1.6} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium">{b.label}</span>
                        <span className="block text-[11px] text-muted-foreground leading-snug">
                          {disabled ? "Already on the page (one per page)." : b.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {categories.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Nothing matches “{filter}”.
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminHomePage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewReady = useRef(false);

  const { data, isLoading } = useQuery<PageContent>({
    queryKey: ["/api/admin/pages", PAGE_SLUG],
  });

  const [draft, setDraft] = useState<PageContent | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"sections" | "seo" | "history">("sections");
  const [device, setDevice] = useState<DeviceId>("desktop");
  const [adding, setAdding] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Seed the draft once the page loads, and re-seed after a save/restore.
  useEffect(() => {
    if (!data) return;
    setDraft((prev) => (prev === null ? clone(data) : prev));
  }, [data]);

  const dirty = useMemo(
    () => Boolean(draft && data && JSON.stringify(draft) !== JSON.stringify(data)),
    [draft, data],
  );

  // Guard against losing unsaved work on a tab close / hard reload.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const pushToPreview = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || !draft || !previewReady.current) return;
    frame.postMessage(
      { source: "rivers-cms", type: "content", page: draft, selectedId },
      window.location.origin,
    );
  }, [draft, selectedId]);

  // The preview announces itself when it mounts; after that every draft
  // change is pushed straight in (no reload, so scroll position holds).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as { source?: string; type?: string; id?: string };
      if (msg?.source !== "rivers-cms-preview") return;
      if (msg.type === "ready") {
        previewReady.current = true;
        pushToPreview();
      } else if (msg.type === "select" && msg.id) {
        setSelectedId(msg.id);
        setTab("sections");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pushToPreview]);

  useEffect(() => {
    pushToPreview();
  }, [pushToPreview]);

  const blocks = draft?.blocks ?? [];
  const selected = blocks.find((b) => b.id === selectedId) ?? null;

  const setBlocks = (next: PageBlock[]) =>
    setDraft((d) => (d ? { ...d, blocks: next } : d));

  const updateBlock = (id: string, patch: Partial<PageBlock>) =>
    setBlocks(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const moveBlock = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const next = [...blocks];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setBlocks(next);
  };

  const addBlock = (type: string) => {
    const block = newBlock(type, uid());
    setBlocks([...blocks, block]);
    setSelectedId(block.id);
  };

  const duplicateBlock = (id: string) => {
    const i = blocks.findIndex((b) => b.id === id);
    if (i < 0) return;
    const def = getBlockType(blocks[i].type);
    if (def?.singleton) {
      toast({ title: `Only one ${def.label} section per page` });
      return;
    }
    const copy: PageBlock = { ...clone(blocks[i]), id: `${blocks[i].type}-${uid()}` };
    const next = [...blocks];
    next.splice(i + 1, 0, copy);
    setBlocks(next);
    setSelectedId(copy.id);
  };

  const removeBlock = (id: string) => {
    setBlocks(blocks.filter((b) => b.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Nothing to save");
      const res = await apiRequest("PUT", `/api/admin/pages/${PAGE_SLUG}`, {
        seo: draft.seo,
        blocks: draft.blocks,
      });
      return (await res.json()) as PageContent;
    },
    onSuccess: (saved) => {
      qc.setQueryData(["/api/admin/pages", PAGE_SLUG], saved);
      qc.invalidateQueries({ queryKey: ["/api/admin/pages", PAGE_SLUG, "revisions"] });
      setDraft(clone(saved));
      toast({ title: "Homepage published", description: "The live site is updated." });
    },
    onError: (e: any) =>
      toast({
        title: "Save failed",
        description: e?.message ?? "Try again",
        variant: "destructive",
      }),
  });

  const reset = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/pages/${PAGE_SLUG}/reset`, {});
      return (await res.json()) as PageContent;
    },
    onSuccess: (saved) => {
      qc.setQueryData(["/api/admin/pages", PAGE_SLUG], saved);
      qc.invalidateQueries({ queryKey: ["/api/admin/pages", PAGE_SLUG, "revisions"] });
      setDraft(clone(saved));
      setSelectedId(null);
      toast({ title: "Homepage reset to the original layout" });
    },
    onError: (e: any) =>
      toast({ title: "Reset failed", description: e?.message, variant: "destructive" }),
  });

  const restore = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/pages/${PAGE_SLUG}/revisions/${id}/restore`,
        {},
      );
      return (await res.json()) as PageContent;
    },
    onSuccess: (saved) => {
      qc.setQueryData(["/api/admin/pages", PAGE_SLUG], saved);
      qc.invalidateQueries({ queryKey: ["/api/admin/pages", PAGE_SLUG, "revisions"] });
      setDraft(clone(saved));
      setSelectedId(null);
      toast({ title: "Version restored" });
    },
    onError: (e: any) =>
      toast({ title: "Restore failed", description: e?.message, variant: "destructive" }),
  });

  const deviceWidth = DEVICES.find((d) => d.id === device)?.width ?? "100%";

  return (
    <AppShell
      pageTitle="Home page"
      pageActions={
        <div className="flex items-center gap-2">
          <span
            className={`font-display text-[10px] tracking-[0.18em] ${
              dirty ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {dirty ? "UNSAVED CHANGES" : "ALL CHANGES SAVED"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => data && setDraft(clone(data))}
          >
            Discard
          </Button>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
            data-testid="btn-save-home"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.6} />
            {save.isPending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr_340px] h-[calc(100dvh-64px)]">
        {/* ---- Left: sections / SEO / history ---- */}
        <aside className="border-r border-border flex flex-col bg-card min-h-0">
          <div className="flex gap-1 p-2 border-b border-border">
            {([
              ["sections", Layers, "Sections"],
              ["seo", Settings2, "SEO"],
              ["history", History, "History"],
            ] as const).map(([id, Icon, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-sm font-display text-[10px] tracking-[0.16em] transition-colors ${
                  tab === id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
                data-testid={`tab-${id}`}
              >
                <Icon className="w-3.5 h-3.5" strokeWidth={1.6} />
                {label.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {isLoading || !draft ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : tab === "sections" ? (
              <ul className="p-2 space-y-1">
                {blocks.map((block, i) => {
                  const def = getBlockType(block.type);
                  const Icon = ICONS[def?.icon ?? ""] ?? Layers;
                  const active = block.id === selectedId;
                  return (
                    <li
                      key={block.id}
                      draggable
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragIndex === null || dragIndex === i) return;
                        moveBlock(dragIndex, i);
                        setDragIndex(i);
                      }}
                      onDragEnd={() => setDragIndex(null)}
                      onClick={() => setSelectedId(block.id)}
                      className={`group flex items-center gap-2 px-2 py-2 rounded-sm cursor-pointer border transition-colors ${
                        active
                          ? "bg-muted border-foreground/25"
                          : "border-transparent hover:bg-muted/50"
                      } ${block.enabled ? "" : "opacity-50"}`}
                      data-testid={`block-row-${block.id}`}
                    >
                      <GripVertical
                        className="w-3.5 h-3.5 text-muted-foreground shrink-0 cursor-grab"
                        strokeWidth={1.6}
                      />
                      <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.6} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] truncate">{blockTitle(block)}</div>
                        <div className="font-display text-[9px] tracking-[0.16em] text-muted-foreground truncate">
                          {(def?.label ?? block.type).toUpperCase()}
                        </div>
                      </div>
                      <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          title={block.enabled ? "Hide section" : "Show section"}
                          onClick={(e) => {
                            e.stopPropagation();
                            updateBlock(block.id, { enabled: !block.enabled });
                          }}
                        >
                          {block.enabled ? (
                            <Eye className="w-3 h-3" strokeWidth={1.8} />
                          ) : (
                            <EyeOff className="w-3 h-3" strokeWidth={1.8} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          title="Duplicate"
                          onClick={(e) => {
                            e.stopPropagation();
                            duplicateBlock(block.id);
                          }}
                        >
                          <Copy className="w-3 h-3" strokeWidth={1.8} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeBlock(block.id);
                          }}
                        >
                          <Trash2 className="w-3 h-3" strokeWidth={1.8} />
                        </Button>
                      </div>
                      {!block.enabled ? (
                        <span className="font-display text-[8px] tracking-[0.16em] text-muted-foreground shrink-0">
                          HIDDEN
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : tab === "seo" ? (
              <SeoPanel
                seo={draft.seo}
                onChange={(patch) =>
                  setDraft((d) => (d ? { ...d, seo: { ...d.seo, ...patch } } : d))
                }
              />
            ) : (
              <HistoryPanel
                onRestore={(id) => restore.mutate(id)}
                restoring={restore.isPending}
              />
            )}
          </div>

          {tab === "sections" ? (
            <div className="p-2 border-t border-border space-y-1">
              <Button
                className="w-full"
                variant="outline"
                onClick={() => setAdding(true)}
                data-testid="btn-add-section"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.8} />
                Add section
              </Button>
              <Button
                className="w-full text-muted-foreground"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw className="w-3 h-3 mr-1.5" strokeWidth={1.8} />
                Reset to original layout
              </Button>
            </div>
          ) : null}
        </aside>

        {/* ---- Centre: live preview ---- */}
        <section className="flex flex-col min-h-0 bg-muted/30">
          <div className="h-12 border-b border-border flex items-center gap-2 px-3 bg-background">
            <div className="flex gap-1 bg-muted/60 p-1 rounded-sm">
              {DEVICES.map((d) => {
                const Icon = d.icon;
                return (
                  <button
                    key={d.id}
                    onClick={() => setDevice(d.id)}
                    title={d.label}
                    className={`px-2.5 py-1.5 rounded-sm transition-colors ${
                      device === d.id ? "bg-background shadow-sm" : "text-muted-foreground"
                    }`}
                    data-testid={`device-${d.id}`}
                  >
                    <Icon className="w-3.5 h-3.5" strokeWidth={1.6} />
                  </button>
                );
              })}
            </div>
            <div className="flex-1 text-center font-display text-[10px] tracking-[0.18em] text-muted-foreground">
              LIVE PREVIEW · CLICK A SECTION TO EDIT IT
            </div>
            <Button
              variant="ghost"
              size="icon"
              title="Reload preview"
              onClick={() => {
                previewReady.current = false;
                if (iframeRef.current) {
                  // eslint-disable-next-line no-self-assign
                  iframeRef.current.src = iframeRef.current.src;
                }
              }}
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.6} />
            </Button>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-muted transition-colors"
              title="Open the live homepage"
            >
              <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.6} />
            </a>
          </div>

          <div className="flex-1 overflow-auto p-4 flex justify-center">
            <div
              className="bg-background shadow-xl border border-border transition-[width] duration-200"
              style={{ width: deviceWidth, maxWidth: "100%", height: "100%" }}
            >
              <iframe
                ref={iframeRef}
                src="/?cmsPreview=1"
                title="Homepage preview"
                className="w-full h-full"
                onLoad={() => pushToPreview()}
              />
            </div>
          </div>
        </section>

        {/* ---- Right: settings for the selected section ---- */}
        <aside className="border-l border-border bg-card min-h-0 hidden xl:flex flex-col">
          {selected ? (
            <BlockSettings
              key={selected.id}
              block={selected}
              onChange={(data) => updateBlock(selected.id, { data })}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
              <ImageIcon className="w-6 h-6 text-muted-foreground" strokeWidth={1.4} />
              <div className="font-serif text-[18px]">Pick a section</div>
              <p className="text-[12px] text-muted-foreground leading-snug">
                Click one in the list on the left, or click it directly in the
                preview, and its settings open here.
              </p>
            </div>
          )}
        </aside>
      </div>

      <AddSectionDialog
        open={adding}
        onOpenChange={setAdding}
        existingTypes={new Set(blocks.map((b) => b.type))}
        onAdd={addBlock}
      />

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the homepage?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores the original section list and copy, and publishes it
              straight away. The current version is snapshotted first, so you can
              undo it from the History tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => reset.mutate()}>
              Reset homepage
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
