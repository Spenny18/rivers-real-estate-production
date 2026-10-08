import { useState } from "react";
import { useLocation } from "wouter";
import { PublicLayout } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRequestMagicLink, useAccount } from "@/lib/account";
import { useEffect } from "react";
import { PrivacyLink } from "@/components/privacy-link";


const ERROR_LABELS: Record<string, string> = {
  missing_token: "That sign-in link was incomplete. Try requesting a new one.",
  invalid_token: "That sign-in link isn't valid. Request a new one below.",
  token_used: "That sign-in link was already used. Request a new one below.",
  token_expired: "That sign-in link expired. Request a new one below.",
  google_oauth_not_configured:
    "Google sign-in isn't set up yet — use the email option for now.",
};

export default function AccountLoginPage() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const requestLink = useRequestMagicLink();
  const { data: me } = useAccount();

  // Already signed in? Bounce to dashboard.
  useEffect(() => {
    if (me) setLocation("/account/dashboard");
  }, [me, setLocation]);

  // Pull ?error= from the URL (set by the magic-callback redirect on failure).
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const errorKey = params.get("error");
  const errorMessage = errorKey ? ERROR_LABELS[errorKey] ?? null : null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    requestLink.mutate(email.trim(), {
      onSuccess: () => setSent(true),
    });
  }

  return (
    <PublicLayout>
      <section className="max-w-md mx-auto px-6 lg:px-10 pt-20 pb-32">
        <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
          YOUR ACCOUNT
        </div>
        <h1 className="mt-5 font-serif text-[44px] lg:text-[56px] leading-[1.05]">
          Sign in to your portal.
        </h1>
        <p className="mt-5 text-muted-foreground text-[15px] leading-relaxed">
          Save searches, favourite listings, request tours, and track market
          activity in your saved neighbourhoods. Everything lives here.
        </p>

        {errorMessage && (
          <div className="mt-8 border border-destructive/30 bg-destructive/5 text-destructive text-sm rounded-sm px-4 py-3">
            {errorMessage}
          </div>
        )}

        {sent ? (
          <div className="mt-10 border border-border rounded-sm px-5 py-6">
            <div className="font-serif text-2xl">Check your inbox.</div>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              We sent a sign-in link to <strong>{email}</strong>. It expires in
              15 minutes. If you don't see it within a minute, check your spam
              folder.
            </p>
            <button
              className="mt-4 text-sm underline text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSent(false);
                setEmail("");
              }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-10 space-y-5">
            <div>
              <label
                htmlFor="account-email"
                className="block font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-2"
              >
                EMAIL ADDRESS
              </label>
              <Input
                id="account-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11"
                data-testid="input-account-email"
              />
            </div>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={requestLink.isPending}
              data-testid="btn-send-magic-link"
            >
              {requestLink.isPending ? "Sending link…" : "Email me a sign-in link"}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="flex-1 border-t border-border" />
              <span>or</span>
              <div className="flex-1 border-t border-border" />
            </div>
            <a
              href="/api/account/auth/google"
              className="inline-flex w-full items-center justify-center rounded-sm border border-border h-11 text-sm font-medium hover:bg-muted/50 transition-colors"
              data-testid="btn-google-signin"
            >
              Continue with Google
            </a>
            <p className="text-xs text-muted-foreground leading-relaxed">
              By signing in you agree that Spencer may follow up by phone or
              email about your inquiries. No spam — unsubscribe anytime.{" "}
              <PrivacyLink />.
            </p>
          </form>
        )}
      </section>
    </PublicLayout>
  );
}
