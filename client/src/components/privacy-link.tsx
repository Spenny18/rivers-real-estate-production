// The link every form that collects contact details carries to
// /privacy-policy. One component so the wording and target stay identical
// across the site.

import { cn } from "@/lib/utils";

/** "Privacy policy", linked. Appended to a form's existing consent sentence. */
export function PrivacyLink() {
  return (
    <a href="/privacy-policy" className="underline underline-offset-2 hover:text-foreground">
      Privacy policy
    </a>
  );
}

/** A standalone line for forms that have no consent wording of their own. */
export function PrivacyNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] text-muted-foreground leading-relaxed", className)}>
      How your details are used: <PrivacyLink />.
    </p>
  );
}
