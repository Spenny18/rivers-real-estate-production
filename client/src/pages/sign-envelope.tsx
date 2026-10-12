// /sign/e/:token — one person's envelope: every document they've been sent
// together, signed in one sitting. They agree to sign electronically once,
// adopt a signature once, go through each document's boxes, and finish them
// all with one click. Each document is still recorded and certified on its
// own (server/deal-routes.ts, "Envelopes").

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Download, FileText, Loader2, PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PdfPages } from "@/components/pdf-pages";
import { SignaturePad, type SignatureResult } from "@/components/signature-pad";
import { Notice, Shell, SignerFieldBox, initialsOf } from "@/components/signing-parts";
import { apiErrorMessage, apiRequest, apiUrl } from "@/lib/queryClient";
import { fmtDateTime, isAutoField, signerColour, type EnvelopeSignerPage, type SignerPage } from "@/lib/esign-types";
import { SeoHead } from "@/components/seo-head";

type DocState = "sign" | "waiting" | "signed" | "completed" | "closed";

function stateOf(d: SignerPage): DocState {
  if (d.document.status === "completed") return "completed";
  if (d.document.status !== "sent") return "closed";
  if (d.signer.status === "signed") return "signed";
  if (d.canSign) return "sign";
  return "waiting";
}

const STATE_LABEL: Record<DocState, string> = {
  sign: "To sign",
  waiting: "Waiting",
  signed: "Signed",
  completed: "Complete",
  closed: "Closed",
};

export default function SignEnvelopePage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";
  const base = `/api/sign/e/${token}`;
  const qc = useQueryClient();
  const key = [base];
  const { data, isLoading, isError } = useQuery<EnvelopeSignerPage>({ queryKey: key, enabled: !!token });

  // Values per document: { [documentId]: { [fieldId]: value } }.
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [signature, setSignature] = useState<SignatureResult | null>(null);
  const [initials, setInitials] = useState<SignatureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [signOpen, setSignOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const update = () => setWidth(Math.min(760, Math.max(320, window.innerWidth - 32)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const docs = data?.documents ?? [];
  const toSign = docs.filter((d) => stateOf(d) === "sign");
  // Open on the first document that needs them, else the first one.
  useEffect(() => {
    if (!data || (activeId && docs.some((d) => d.document.id === activeId))) return;
    setActiveId((toSign[0] ?? docs[0])?.document.id ?? null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const onResult = (d: EnvelopeSignerPage) => {
    qc.setQueryData(key, d);
    setError(null);
  };
  const consent = useMutation({
    mutationFn: async () => (await apiRequest("POST", `${base}/consent`, {})).json() as Promise<EnvelopeSignerPage>,
    onSuccess: onResult,
    onError: (e) => setError(apiErrorMessage(e)),
  });
  const complete = useMutation({
    mutationFn: async () => {
      if (!signature) throw new Error("Please add your signature.");
      const res = await apiRequest("POST", `${base}/complete`, {
        documents: values,
        signature: { kind: signature.kind, png: signature.png },
        initials: initials ? { png: initials.png } : undefined,
      });
      return (await res.json()) as EnvelopeSignerPage;
    },
    onSuccess: (d) => {
      onResult(d);
      setSignOpen(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  const decline = useMutation({
    mutationFn: async () => (await apiRequest("POST", `${base}/decline`, { reason: declineReason })).json() as Promise<EnvelopeSignerPage>,
    onSuccess: (d) => {
      onResult(d);
      setDeclining(false);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const mineIn = (d: SignerPage) => d.fields.filter((f) => f.mine);
  const needsInitials = toSign.some((d) => mineIn(d).some((f) => f.type === "initials"));
  const missingIn = (d: SignerPage) =>
    mineIn(d).filter((f) => f.required && f.type === "text" && !(values[String(d.document.id)]?.[String(f.id)] ?? "").trim());
  const totalMissing = toSign.reduce((n, d) => n + missingIn(d).length, 0);
  const ready = !!signature && (!needsInitials || !!initials) && totalMissing === 0;

  const colourFor = useCallback((d: SignerPage, signerId: number) => {
    const all = [d.signer.id, ...d.others.map((o) => o.id)].sort((a, b) => a - b);
    return signerColour(Math.max(0, all.indexOf(signerId)));
  }, []);

  const active = useMemo(() => docs.find((d) => d.document.id === activeId) ?? null, [docs, activeId]);

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-24 text-[14px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening your documents…
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

  const { envelope, recipient, deal, agent } = data;
  const consented = !!recipient.consentAt || toSign.every((d) => !!d.signer.consentAt);
  const canFill = envelope.status === "sent" && consented && toSign.length > 0;
  const waiting = docs.filter((d) => stateOf(d) === "waiting");
  const allMineSigned = docs.length > 0 && docs.every((d) => ["signed", "completed"].includes(stateOf(d)));

  // ---- Banner ----
  let banner: React.ReactNode;
  if (envelope.status === "completed") {
    banner = (
      <Notice tone="good" icon={<CheckCircle2 className="h-5 w-5" />} title="All parties have signed.">
        Completed {fmtDateTime(envelope.completedAt)} — download each signed copy below; every one includes its signature certificate.
        <div className="mt-3 flex flex-wrap gap-2">
          {docs.map((d) => (
            <a key={d.document.id} href={apiUrl(`${base}/doc/${d.document.id}/file?which=signed&download=1`)}>
              <Button size="sm" variant="outline">
                <Download className="h-4 w-4 mr-1" /> {d.document.title}
              </Button>
            </a>
          ))}
        </div>
      </Notice>
    );
  } else if (envelope.status === "voided") {
    banner = <Notice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title="These documents were withdrawn.">Spencer has voided them. If new versions are needed you will receive a fresh link.</Notice>;
  } else if (envelope.status === "declined") {
    banner = (
      <Notice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={recipient.status === "declined" ? "You declined to sign." : "Another party declined to sign."}>
        Nothing further is needed from you. Spencer has been notified.
      </Notice>
    );
  } else if (allMineSigned) {
    banner = (
      <Notice tone="good" icon={<CheckCircle2 className="h-5 w-5" />} title="Thank you — your signatures are recorded.">
        You'll get every completed copy by email once all parties have signed.
      </Notice>
    );
  } else if (toSign.length === 0) {
    banner = (
      <Notice tone="info" icon={<Clock className="h-5 w-5" />} title="Not ready for your signature yet.">
        {waiting[0]?.waitingOn ? `Waiting on ${waiting[0].waitingOn} to sign first. ` : ""}We'll email you when it's your turn.
      </Notice>
    );
  } else if (!consented) {
    banner = (
      <Notice tone="info" icon={<ShieldCheck className="h-5 w-5" />} title="Before you begin">
        <p>
          By continuing you agree to review and sign {toSign.length === 1 ? "this document" : `these ${toSign.length} documents`} electronically, and that your
          electronic signature has the same effect as a handwritten one. You can download copies at any time from this link. If you'd rather sign on
          paper, contact {agent.name} at {agent.phone}.
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
    const items = toSign.reduce((n, d) => n + mineIn(d).filter((f) => !isAutoField(f.type)).length, 0);
    banner = (
      <Notice tone="info" icon={<PenLine className="h-5 w-5" />} title={`${toSign.length} document${toSign.length === 1 ? "" : "s"} · ${items} item${items === 1 ? "" : "s"} to complete`}>
        Go through each document below and fill in the highlighted boxes. You sign once, and your signature is placed in every box that's yours.
        Dates and times are stamped automatically. {waiting.length ? `${waiting.length} more will open once others have signed.` : ""}
      </Notice>
    );
  }

  const activeIndex = active ? toSign.findIndex((d) => d.document.id === active.document.id) : -1;
  const nextToSign = activeIndex >= 0 ? toSign[activeIndex + 1] : undefined;
  const activeState = active ? stateOf(active) : null;

  return (
    <Shell>
      <SeoHead title={`Sign: ${envelope.title}`} description="" noindex />
      <header className="max-w-[760px] mx-auto px-4 pt-8 pb-4">
        <div className="font-display text-[11px] tracking-[0.24em] text-[#B8893D]">RIVERS REAL ESTATE · E-SIGNATURE</div>
        <h1 className="font-serif text-[26px] sm:text-[30px] leading-tight mt-1">{envelope.title}</h1>
        <div className="text-[13px] text-muted-foreground mt-1">
          {deal.title}
          {deal.address ? ` · ${deal.address}` : ""} · for {recipient.name}
        </div>
        {envelope.message ? <div className="mt-3 text-[14px] leading-relaxed border-l-2 border-[#D4AF37] pl-3 whitespace-pre-wrap">{envelope.message}</div> : null}
      </header>

      <div className="max-w-[760px] mx-auto px-4 space-y-4 pb-4">
        {banner}
        {error ? <div className="text-[13px] text-destructive">{error}</div> : null}

        {/* The documents */}
        <div className="rounded-sm border border-border bg-background divide-y divide-border" data-testid="envelope-documents">
          {docs.map((d, i) => {
            const st = stateOf(d);
            const isActive = d.document.id === activeId;
            const missing = st === "sign" ? missingIn(d).length : 0;
            return (
              <button
                key={d.document.id}
                onClick={() => setActiveId(d.document.id)}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 ${isActive ? "bg-[#D4AF37]/10" : "hover:bg-secondary/50"}`}
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">
                    {i + 1}. {d.document.title}
                  </div>
                  <div className="text-[12px] text-muted-foreground">
                    {st === "waiting" && d.waitingOn ? `Waiting on ${d.waitingOn}` : STATE_LABEL[st]}
                    {missing ? ` · ${missing} box${missing === 1 ? "" : "es"} to fill` : ""}
                  </div>
                </div>
                {st === "signed" || st === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                ) : st === "sign" ? (
                  <ChevronRight className="h-4 w-4 text-[#B8893D] shrink-0" />
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {active && envelope.status !== "completed" ? (
        <div className="px-4 pb-10">
          <div className="max-w-[760px] mx-auto mb-2 flex items-center justify-between gap-3">
            <div className="font-serif text-[18px] truncate">{active.document.title}</div>
            {canFill && nextToSign ? (
              <Button size="sm" variant="outline" onClick={() => setActiveId(nextToSign.document.id)}>
                Next document <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : null}
          </div>
          <PdfPages
            url={apiUrl(`${base}/doc/${active.document.id}/file?which=original&v=${active.document.status}`)}
            pageSizes={active.document.pageSizes}
            width={width}
            overlay={(page) =>
              active.fields
                .filter((f) => f.page === page)
                .map((f) => {
                  const editable = canFill && activeState === "sign" && f.mine;
                  const docKey = String(active.document.id);
                  return (
                    <SignerFieldBox
                      key={f.id}
                      signatureUrl={(signerId, kind) => apiUrl(`${base}/doc/${active.document.id}/signature/${signerId}?kind=${kind}`)}
                      field={f}
                      colour={f.mine ? colourFor(active, active.signer.id) : "#9ca3af"}
                      editable={editable}
                      value={f.mine ? values[docKey]?.[String(f.id)] ?? f.value ?? "" : f.value ?? ""}
                      preview={f.mine && activeState === "sign" ? (f.type === "signature" ? signature?.png ?? null : f.type === "initials" ? initials?.png ?? null : null) : null}
                      signedByMe={activeState !== "sign" && active.signer.status === "signed" && f.mine}
                      onChange={(v) => setValues({ ...values, [docKey]: { ...(values[docKey] ?? {}), [String(f.id)]: v } })}
                      onSign={() => setSignOpen(true)}
                    />
                  );
                })
            }
          />
        </div>
      ) : null}

      {canFill ? (
        <div className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur px-4 py-3">
          <div className="max-w-[760px] mx-auto flex flex-wrap items-center gap-3 justify-between">
            <div className="text-[12px] text-muted-foreground">
              {signature ? <span className="text-emerald-700">Signature added.</span> : "Add your signature to finish."}
              {totalMissing ? ` ${totalMissing} required box${totalMissing === 1 ? "" : "es"} still empty.` : ""}
              {toSign.length > 1 ? ` Finishing signs all ${toSign.length} documents.` : ""}
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
                <Button size="sm" disabled={!ready || complete.isPending} onClick={() => complete.mutate()} data-testid="envelope-finish">
                  {complete.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                  {toSign.length > 1 ? `Finish signing all ${toSign.length}` : "Finish signing"}
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <footer className="max-w-[760px] mx-auto px-4 py-8 text-[11px] text-muted-foreground leading-relaxed">
        Sent by {agent.name}, {agent.brokerage}. Envelope ID RRE-ENV-{envelope.id}.{" "}
        {docs.map((d) => `RRE-${d.document.id} ${d.document.title}`).join(" · ")}. Each document carries its own signature certificate and fingerprint.
      </footer>

      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent className="max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Your signature</DialogTitle>
            <DialogDescription>
              Draw it or type it. It will be placed in every signature box that is yours{toSign.length > 1 ? `, across all ${toSign.length} documents` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <SignaturePad label="Signature" defaultTyped={recipient.name} onChange={setSignature} />
            {needsInitials ? <SignaturePad label="Initials" defaultTyped={initialsOf(recipient.name)} onChange={setInitials} compact /> : null}
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

      <Dialog open={declining} onOpenChange={setDeclining}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline to sign?</DialogTitle>
            <DialogDescription>
              {docs.length > 1 ? "This declines every document sent with it. " : ""}
              {agent.name} will be notified. You can add a reason so the documents can be corrected.
            </DialogDescription>
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
