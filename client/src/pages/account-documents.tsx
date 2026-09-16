// /account/documents — everything the signed-in person has been asked to
// sign, with their private signing link and the completed copies.
//
// Matched by email: a document lists here when one of its signers has the
// portal user's address. Drafts never appear; nothing is visible until the
// agent has sent it.

import { Link } from "wouter";
import { ChevronLeft, CheckCircle2, Clock, Download, FileSignature, PenLine, XCircle } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
import { useAccount, usePortalDocuments } from "@/lib/account";
import { fmtDateTime, ROLE_LABELS, type PortalDocument } from "@/lib/esign-types";

function StatusLine({ d }: { d: PortalDocument }) {
  if (d.status === "completed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-700">
        <CheckCircle2 className="h-4 w-4" /> Completed {fmtDateTime(d.completedAt)}
      </span>
    );
  }
  if (d.status === "voided" || d.status === "declined") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <XCircle className="h-4 w-4" /> {d.status === "voided" ? "Withdrawn" : d.signerStatus === "declined" ? "You declined" : "Declined by another party"}
      </span>
    );
  }
  if (d.signerStatus === "signed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Clock className="h-4 w-4" /> You signed {fmtDateTime(d.signedAt)} · waiting on {d.others.filter((o) => o.status !== "signed").map((o) => o.name).join(", ") || "others"}
      </span>
    );
  }
  if (d.canSignNow) {
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-700">
        <PenLine className="h-4 w-4" /> Waiting for your signature
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Clock className="h-4 w-4" /> Not your turn yet
    </span>
  );
}

export default function AccountDocumentsPage() {
  const { data: me, isLoading: meLoading } = useAccount();
  const { data: docs, isLoading } = usePortalDocuments();

  if (meLoading || isLoading) {
    return (
      <PublicLayout>
        <div className="max-w-4xl mx-auto px-6 py-32 text-center text-muted-foreground">Loading…</div>
      </PublicLayout>
    );
  }
  if (!me) {
    if (typeof window !== "undefined") window.location.href = "/account/login";
    return null;
  }

  const list = docs ?? [];
  const toSign = list.filter((d) => d.status === "sent" && d.signerStatus !== "signed");
  const rest = list.filter((d) => !toSign.includes(d));

  return (
    <PublicLayout>
      <section className="max-w-4xl mx-auto px-6 lg:px-10 pt-16 pb-24">
        <Link href="/account/dashboard" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Portal
        </Link>
        <div className="mt-6 font-display text-[11px] tracking-[0.32em] text-muted-foreground">DOCUMENTS</div>
        <h1 className="mt-3 font-serif text-[40px] lg:text-[52px] leading-[1.05]">Your documents.</h1>
        <p className="mt-3 text-muted-foreground text-[15px] max-w-xl">
          Contracts Spencer has sent you to sign, and the completed copies. Each signing link is private to you.
        </p>

        {list.length === 0 ? (
          <div className="mt-12 rounded-sm border border-border p-10 text-center">
            <FileSignature className="h-8 w-8 mx-auto text-muted-foreground mb-3" strokeWidth={1.4} />
            <div className="font-serif text-xl">Nothing to sign right now</div>
            <p className="mt-2 text-sm text-muted-foreground">When Spencer sends you a document it will appear here, and you'll also get an email.</p>
          </div>
        ) : null}

        {toSign.length ? (
          <>
            <div className="mt-12 font-display text-[10px] tracking-[0.22em] text-muted-foreground">NEEDS YOUR SIGNATURE</div>
            <div className="mt-3 grid gap-3">
              {toSign.map((d) => (
                <DocCard key={d.id} d={d} />
              ))}
            </div>
          </>
        ) : null}
        {rest.length ? (
          <>
            <div className="mt-12 font-display text-[10px] tracking-[0.22em] text-muted-foreground">EVERYTHING ELSE</div>
            <div className="mt-3 grid gap-3">
              {rest.map((d) => (
                <DocCard key={d.id} d={d} />
              ))}
            </div>
          </>
        ) : null}
      </section>
    </PublicLayout>
  );
}

function DocCard({ d }: { d: PortalDocument }) {
  return (
    <div className="rounded-sm border border-border p-5 flex flex-wrap items-center gap-4" data-testid={`portal-doc-${d.id}`}>
      <div className="flex-1 min-w-[240px]">
        <div className="font-serif text-[20px] leading-tight">{d.title}</div>
        <div className="text-[13px] text-muted-foreground mt-1">
          {d.dealTitle}
          {d.address ? ` · ${d.address}` : ""}
        </div>
        <div className="text-[13px] mt-2">
          <StatusLine d={d} />
        </div>
        {d.others.length ? (
          <div className="text-[12px] text-muted-foreground mt-1">
            Also signing: {d.others.map((o) => `${o.name} (${ROLE_LABELS[o.role]})`).join(", ")}
          </div>
        ) : null}
      </div>
      <div className="flex gap-2">
        {d.status === "completed" && d.downloadUrl ? (
          <a href={d.downloadUrl}>
            <Button size="sm">
              <Download className="h-4 w-4 mr-1" /> Signed copy
            </Button>
          </a>
        ) : null}
        <a href={d.signUrl}>
          <Button size="sm" variant={d.canSignNow && d.signerStatus !== "signed" ? "default" : "outline"}>
            {d.canSignNow && d.signerStatus !== "signed" ? (
              <>
                <PenLine className="h-4 w-4 mr-1" /> Review & sign
              </>
            ) : (
              "Open"
            )}
          </Button>
        </a>
      </div>
    </div>
  );
}
