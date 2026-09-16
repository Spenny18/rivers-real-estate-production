// /sign/:token — the signer's page.
//
// The token in the URL is the only credential (see server/deal-routes.ts).
// Flow: read the note → agree to sign electronically → fill the boxes that
// are theirs (signature, initials, dates, text, checkboxes), signing once at
// the bottom → done. After everyone has signed the same link shows the
// completed document and the download.
//
// Deliberately plain: no site chrome, no marketing — a person is signing a
// contract on their phone.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, Loader2, PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PdfPages } from "@/components/pdf-pages";
import { SignaturePad, type SignatureResult } from "@/components/signature-pad";
import { apiErrorMessage, apiRequest, apiUrl } from "@/lib/queryClient";
import { fmtDateTime, signerColour, type FieldView, type SignerPage } from "@/lib/esign-types";
import { SeoHead } from "@/components/seo-head";

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 4);
}

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", year: "numeric", month: "long", day: "numeric" }).format(new Date());
}

export default function SignPage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";
  const qc = useQueryClient();
  const key = [`/api/sign/${token}`];
  const { data, isLoading, isError } = useQuery<SignerPage>({ queryKey: key, enabled: !!token });

  const [values, setValues] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<SignatureResult | null>(null);
  const [initials, setInitials] = useState<SignatureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [signOpen, setSignOpen] = useState(false);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const update = () => setWidth(Math.min(760, Math.max(320, window.innerWidth - 32)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Dates default to today; the signer can change them.
  useEffect(() => {
    if (!data) return;
    setValues((v) => {
      const next = { ...v };
      for (const f of data.fields) {
        if (f.mine && f.type === "date" && next[String(f.id)] === undefined) next[String(f.id)] = todayLocal();
      }
      return next;
    });
  }, [data]);

  const consent = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/sign/${token}/consent`, {})).json() as Promise<SignerPage>,
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const complete = useMutation({
    mutationFn: async () => {
      if (!signature) throw new Error("Please add your signature.");
      const res = await apiRequest("POST", `/api/sign/${token}/complete`, {
        values,
        signature: { kind: signature.kind, png: signature.png },
        initials: initials ? { png: initials.png } : undefined,
      });
      return (await res.json()) as SignerPage;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setSignOpen(false);
      setError(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const decline = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/sign/${token}/decline`, { reason: declineReason })).json() as Promise<SignerPage>,
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setDeclining(false);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const mine = useMemo(() => (data?.fields ?? []).filter((f) => f.mine), [data]);
  const needsInitials = mine.some((f) => f.type === "initials");
  const signerIndex = useCallback(
    (signerId: number) => {
      if (!data) return 0;
      const all = [data.signer.id, ...data.others.map((o) => o.id)].sort((a, b) => a - b);
      return Math.max(0, all.indexOf(signerId));
    },
    [data],
  );

  const missing = mine.filter((f) => f.required && (f.type === "text" || f.type === "date") && !(values[String(f.id)] ?? "").trim());
  const ready = !!signature && (!needsInitials || !!initials) && missing.length === 0;

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-24 text-[14px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening your document…
        </div>
      </Shell>
    );
  }
  if (isError || !data) {
    return (
      <Shell>
        <div className="max-w-md mx-auto py-24 text-center">
          <AlertTriangle className="h-8 w-8 mx-auto text-muted-foreground mb-3" strokeWidth={1.4} />
          <h1 className="font-serif text-[26px] mb-2">This link isn't valid.</h1>
          <p className="text-[14px] text-muted-foreground">It may have been replaced by a newer one. Check your latest email from Spencer Rivers, or call (403) 966-9237.</p>
        </div>
      </Shell>
    );
  }

  const { document: doc, signer, deal, agent } = data;
  const done = signer.status === "signed";
  const completed = doc.status === "completed";
  const pdfUrl = apiUrl(`/api/sign/${token}/file?which=${completed && doc.signedSha256 ? "signed" : "original"}&v=${doc.completedAt ?? doc.status}`);
  const pageSizes = completed && doc.signedSha256 ? [...doc.pageSizes, { w: 612, h: 792 }, { w: 612, h: 792 }] : doc.pageSizes;

  // ---- Banner ----
  let banner: React.ReactNode = null;
  if (completed) {
    banner = (
      <Notice tone="good" icon={<CheckCircle2 className="h-5 w-5" />} title="All parties have signed.">
        Completed {fmtDateTime(doc.completedAt)}. Your copy below includes the signature certificate.
        <div className="mt-3">
          <a href={apiUrl(`/api/sign/${token}/file?which=signed&download=1`)}>
            <Button size="sm">
              <Download className="h-4 w-4 mr-1" /> Download signed PDF
            </Button>
          </a>
        </div>
      </Notice>
    );
  } else if (doc.status === "voided") {
    banner = <Notice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title="This document was withdrawn.">Spencer has voided it. If a new version is needed you will receive a fresh link.</Notice>;
  } else if (doc.status === "declined") {
    banner = (
      <Notice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={signer.status === "declined" ? "You declined to sign." : "Another party declined to sign."}>
        Nothing further is needed from you. Spencer has been notified.
      </Notice>
    );
  } else if (done) {
    banner = (
      <Notice tone="good" icon={<CheckCircle2 className="h-5 w-5" />} title="Thank you — your signature is recorded.">
        Signed {fmtDateTime(signer.signedAt)}. You'll get the completed copy by email once everyone has signed.
      </Notice>
    );
  } else if (!data.canSign) {
    banner = (
      <Notice tone="info" icon={<Loader2 className="h-5 w-5 animate-spin" />} title={data.waitingOn ? `Waiting on ${data.waitingOn} to sign first.` : "Not ready for your signature yet."}>
        We'll email you when it's your turn.
      </Notice>
    );
  } else if (!signer.consentAt) {
    banner = (
      <Notice tone="info" icon={<ShieldCheck className="h-5 w-5" />} title="Before you begin">
        <p>
          By continuing you agree to review and sign this document electronically, and that your electronic signature has the same effect as a
          handwritten one. You can download a copy at any time from this link. If you'd rather sign on paper, contact {agent.name} at {agent.phone}.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => consent.mutate()} disabled={consent.isPending}>
            {consent.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} I agree — continue
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
      </Notice>
    );
  } else {
    banner = (
      <Notice tone="info" icon={<PenLine className="h-5 w-5" />} title={`${mine.length} item${mine.length === 1 ? "" : "s"} for you to complete.`}>
        Fill in the highlighted boxes, then sign at the bottom. Boxes belonging to other parties are shown in grey.
      </Notice>
    );
  }

  const canFill = data.canSign && !!signer.consentAt && !done;

  return (
    <Shell>
      <SeoHead title={`Sign: ${doc.title}`} description="" noindex />
      <header className="max-w-[760px] mx-auto px-4 pt-8 pb-4">
        <div className="font-display text-[11px] tracking-[0.24em] text-[#B8893D]">RIVERS REAL ESTATE · E-SIGNATURE</div>
        <h1 className="font-serif text-[26px] sm:text-[30px] leading-tight mt-1">{doc.title}</h1>
        <div className="text-[13px] text-muted-foreground mt-1">
          {deal.title}
          {deal.address ? ` · ${deal.address}` : ""} · for {signer.name}
        </div>
        {doc.message ? <div className="mt-3 text-[14px] leading-relaxed border-l-2 border-[#D4AF37] pl-3 whitespace-pre-wrap">{doc.message}</div> : null}
      </header>

      <div className="max-w-[760px] mx-auto px-4 space-y-4 pb-6">
        {banner}
        {error ? <div className="text-[13px] text-destructive">{error}</div> : null}
      </div>

      <div className="px-4 pb-10">
        <PdfPages
          url={pdfUrl}
          pageSizes={pageSizes}
          width={width}
          overlay={(page) =>
            completed && doc.signedSha256
              ? null
              : data.fields
                  .filter((f) => f.page === page)
                  .map((f) => (
                    <SignerFieldBox
                      key={f.id}
                      token={token}
                      field={f}
                      colour={f.mine ? signerColour(signerIndex(signer.id)) : "#9ca3af"}
                      editable={canFill && f.mine}
                      value={f.mine ? values[String(f.id)] ?? "" : f.value ?? ""}
                      preview={f.mine ? (f.type === "signature" ? signature?.png ?? null : f.type === "initials" ? initials?.png ?? null : null) : null}
                      signedByMe={done && f.mine}
                      onChange={(v) => setValues({ ...values, [String(f.id)]: v })}
                      onSign={() => setSignOpen(true)}
                    />
                  ))
          }
        />
      </div>

      {canFill ? (
        <div className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur px-4 py-3">
          <div className="max-w-[760px] mx-auto flex flex-wrap items-center gap-3 justify-between">
            <div className="text-[12px] text-muted-foreground">
              {signature ? (
                <span className="text-emerald-700">Signature added.</span>
              ) : (
                "Add your signature to finish."
              )}
              {missing.length ? ` ${missing.length} required box${missing.length === 1 ? "" : "es"} still empty.` : ""}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeclining(true)}>
                Decline
              </Button>
              {!signature ? (
                <Button size="sm" onClick={() => setSignOpen(true)}>
                  <PenLine className="h-4 w-4 mr-1" /> Sign
                </Button>
              ) : (
                <Button size="sm" disabled={!ready || complete.isPending} onClick={() => complete.mutate()}>
                  {complete.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />} Finish signing
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <footer className="max-w-[760px] mx-auto px-4 py-8 text-[11px] text-muted-foreground leading-relaxed">
        Sent by {agent.name}, {agent.brokerage}. Document ID RRE-{doc.id}. Original file SHA-256{" "}
        <span className="font-mono break-all">{doc.originalSha256}</span>.
        {doc.signedSha256 ? (
          <>
            {" "}
            Signed file SHA-256 <span className="font-mono break-all">{doc.signedSha256}</span>.
          </>
        ) : null}
      </footer>

      {/* Signature dialog */}
      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent className="max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Your signature</DialogTitle>
            <DialogDescription>Draw it or type it. It will be placed in every signature box that is yours.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <SignaturePad label="Signature" defaultTyped={signer.name} onChange={setSignature} />
            {needsInitials ? <SignaturePad label="Initials" defaultTyped={initialsOf(signer.name)} onChange={setInitials} compact /> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!signature || (needsInitials && !initials)} onClick={() => setSignOpen(false)}>
              Use this signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline dialog */}
      <Dialog open={declining} onOpenChange={setDeclining}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline to sign?</DialogTitle>
            <DialogDescription>{agent.name} will be notified. You can add a reason so the document can be corrected.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Optional" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclining(false)}>
              Back
            </Button>
            <Button variant="destructive" onClick={() => decline.mutate()} disabled={decline.isPending}>
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-secondary/30 text-foreground">{children}</div>;
}

function Notice({ tone, icon, title, children }: { tone: "info" | "good" | "warn"; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const styles = {
    info: "border-[#D4AF37] bg-[#D4AF37]/10 text-foreground",
    good: "border-emerald-500 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50",
    warn: "border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-50",
  }[tone];
  return (
    <div className={`border-l-4 rounded-sm px-4 py-3 text-[14px] leading-relaxed flex gap-3 ${styles}`}>
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="mt-0.5">{children}</div>
      </div>
    </div>
  );
}

function SignerFieldBox({
  token,
  field,
  colour,
  editable,
  value,
  preview,
  signedByMe,
  onChange,
  onSign,
}: {
  token: string;
  field: FieldView & { mine: boolean };
  colour: string;
  editable: boolean;
  value: string;
  preview: string | null;
  signedByMe: boolean;
  onChange: (v: string) => void;
  onSign: () => void;
}) {
  const style: React.CSSProperties = {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.w * 100}%`,
    height: `${field.h * 100}%`,
  };
  const isImage = field.type === "signature" || field.type === "initials";
  const otherSigned = !field.mine && field.value === "signed";
  const imgSrc = isImage
    ? field.mine
      ? preview ?? (signedByMe ? apiUrl(`/api/sign/${token}/signature/${field.signerId}?kind=${field.type}`) : null)
      : otherSigned
        ? apiUrl(`/api/sign/${token}/signature/${field.signerId}?kind=${field.type}`)
        : null
    : null;

  if (isImage) {
    return (
      <div
        className={`absolute flex items-end justify-center ${editable ? "cursor-pointer" : ""}`}
        style={{ ...style, background: imgSrc ? "transparent" : `${colour}22`, border: imgSrc ? "none" : `1.5px dashed ${colour}` }}
        onClick={editable ? onSign : undefined}
        title={field.mine ? (editable ? "Click to sign" : "") : `${field.type === "initials" ? "Initials" : "Signature"} of another party`}
      >
        {imgSrc ? (
          <img src={imgSrc} alt="" className="max-w-[92%] max-h-[92%] object-contain pointer-events-none" />
        ) : (
          <span className="text-[10px] leading-none pb-1" style={{ color: colour }}>
            {field.mine ? (field.type === "initials" ? "Initial here" : "Sign here") : ""}
          </span>
        )}
      </div>
    );
  }

  if (field.type === "checkbox") {
    return (
      <div className="absolute flex items-center justify-center" style={{ ...style, background: editable ? `${colour}22` : "transparent", border: editable ? `1.5px dashed ${colour}` : "none" }}>
        {editable ? (
          <Checkbox checked={value === "true"} onCheckedChange={(v) => onChange(v ? "true" : "false")} className="h-full w-full max-h-4 max-w-4 bg-white" />
        ) : value === "true" ? (
          <span className="text-[12px] leading-none">✓</span>
        ) : null}
      </div>
    );
  }

  // text / date
  if (!editable) {
    return (
      <div className="absolute flex items-center px-0.5 overflow-hidden" style={style}>
        <span className="text-[10px] leading-none truncate">{value}</span>
      </div>
    );
  }
  return (
    <div className="absolute" style={style}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.label || (field.type === "date" ? "Date" : "Type here")}
        className="h-full w-full rounded-none px-1 text-[11px] leading-none"
        style={{ background: `${colour}18`, borderColor: colour, minHeight: 0 }}
      />
    </div>
  );
}
