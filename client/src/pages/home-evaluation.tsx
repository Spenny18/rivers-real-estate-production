// /home-evaluation — dedicated landing page that replaces the old WordPress
// /home-valuation page. Marketing materials (signage, email signatures,
// follow-up campaigns) point at /home-evaluation, so when the new SSR site
// shipped without it that URL was throwing 500s. This page restores the
// destination + funnels submissions into the inquiry pipeline (so they land
// in /admin/leads, get emailed to Spencer via Resend, and pushed to Follow
// Up Boss).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowRight,
  CheckCircle2,
  Home,
  TrendingUp,
  Map,
  ShieldCheck,
  Send,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { SeoHead } from "@/components/seo-head";
import { HomeValuationWidget } from "@/components/home-valuation-widget";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { SPENCER_PHONE, SPENCER_PHONE_HREF } from "@/lib/format";
import { PrivacyLink } from "@/components/privacy-link";


const HERO_IMAGE =
  "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=2400&h=1400&fit=crop";

const evaluationSchema = z.object({
  name: z.string().min(2, "Please share your name"),
  email: z.string().email("Please share a valid email"),
  phone: z.string().min(7, "Phone helps Spencer follow up quickly").optional().or(z.literal("")),
  address: z.string().min(6, "Property address is required"),
  beds: z.string().optional(),
  timeframe: z.string().optional(),
  notes: z.string().optional(),
});

type EvaluationForm = z.infer<typeof evaluationSchema>;

const TIMEFRAMES = [
  { value: "asap", label: "As soon as possible" },
  { value: "3m", label: "Within 3 months" },
  { value: "6m", label: "Within 6 months" },
  { value: "12m", label: "Within a year" },
  { value: "curious", label: "Just curious for now" },
];

export default function HomeEvaluationPage() {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<EvaluationForm>({
    resolver: zodResolver(evaluationSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      address: "",
      beds: "",
      timeframe: "",
      notes: "",
    },
  });

  const submit = useMutation({
    mutationFn: async (data: EvaluationForm) => {
      // Compose a message Spencer can act on directly when the lead lands
      // in his inbox / FUB. Structured fields go inline in the body so he
      // doesn't need to flip back to the admin UI to see them.
      const messageLines = [
        `Property address: ${data.address}`,
        data.beds ? `Bedrooms: ${data.beds}` : "",
        data.timeframe ? `Timeframe: ${data.timeframe}` : "",
        data.notes ? `\nNotes:\n${data.notes}` : "",
      ].filter(Boolean);

      const res = await apiRequest("POST", "/api/inquiry", {
        name: data.name,
        email: data.email,
        phone: data.phone || undefined,
        message: messageLines.join("\n"),
        source: "Home evaluation",
      });
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      form.reset();
      toast({
        title: "Request received",
        description:
          "Spencer typically responds within an hour during business hours.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't send",
        description: err?.message ?? "Please try again or call Spencer directly.",
        variant: "destructive",
      });
    },
  });

  return (
    <PublicLayout transparentHeader>
      <SeoHead
        title="What's your Calgary home worth? | Rivers Real Estate"
        description="Free instant home valuation for Calgary properties — powered by Gnowise AVM with property-detail refinement — plus a hand-prepared market analysis from Spencer Rivers."
        canonical="https://riversrealestate.ca/home-evaluation"
      />
      {/* Hero with form ------------------------------------------------- */}
      <section className="relative min-h-[88dvh] lg:min-h-[100dvh] flex flex-col">
        <div className="absolute inset-0">
          <img
            src={HERO_IMAGE}
            alt=""
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-black/85" />
        </div>

        <div className="relative flex-1 flex flex-col justify-center max-w-[1400px] w-full mx-auto px-6 lg:px-10 pt-24 lg:pt-32 pb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-center">
            {/* Copy column */}
            <div className="lg:col-span-6 text-white">
              <div className="font-display text-[11px] tracking-[0.32em] text-white/80 mb-5">
                CALGARY · HOME EVALUATION
              </div>
              <h1
                className="font-serif text-[44px] sm:text-[56px] lg:text-[72px] leading-[0.98] tracking-tight"
                data-testid="hero-headline"
              >
                What's your Calgary home actually worth?
              </h1>
              <p className="mt-8 max-w-2xl text-white/85 text-[16px] lg:text-[17px] leading-relaxed">
                Spencer Rivers prepares a comprehensive market analysis on
                every home — not a Zestimate, not an auto-generated PDF. Real
                comps, neighbourhood-specific positioning, and an honest read
                on where your price should land in today's Calgary market.
              </p>

              <ul className="mt-10 space-y-3 text-white/85 text-[15px]">
                {[
                  "Hand-picked comparable sales in the last 60 days",
                  "Neighbourhood-specific demand and absorption rate",
                  "Pricing strategy for the listing window you're targeting",
                  "No-obligation, no auto-emails, no funnel sequence",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-3">
                    <CheckCircle2
                      className="w-4 h-4 mt-1 shrink-0 text-white"
                      strokeWidth={2}
                    />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-10 pt-6 border-t border-white/20 flex flex-wrap items-center gap-x-6 gap-y-2 text-white/80 text-[13px]">
                <span>Prefer to call?</span>
                <a
                  href={SPENCER_PHONE_HREF}
                  className="font-display tracking-[0.18em] text-white hover:underline"
                  data-testid="link-phone"
                >
                  {SPENCER_PHONE}
                </a>
              </div>
            </div>

            {/* Form column */}
            <div className="lg:col-span-6" id="manual-evaluation">
              <div className="bg-background/95 backdrop-blur-sm rounded-sm shadow-2xl border border-white/20 p-7 lg:p-9">
                {submitted ? (
                  <div className="py-6 text-center" data-testid="thank-you">
                    <CheckCircle2
                      className="w-10 h-10 mx-auto text-foreground"
                      strokeWidth={1.5}
                    />
                    <h2 className="mt-4 font-serif text-2xl lg:text-3xl">
                      Request received.
                    </h2>
                    <p className="mt-3 text-muted-foreground max-w-md mx-auto text-[14.5px] leading-relaxed">
                      Spencer will personally reach out within one business hour
                      during business hours. He puts together each market
                      analysis by hand — usually back to you within 24 hours.
                    </p>
                    <Button
                      onClick={() => setSubmitted(false)}
                      variant="outline"
                      className="mt-7"
                    >
                      Request another evaluation
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-2">
                      START HERE
                    </div>
                    <h2 className="font-serif text-2xl lg:text-3xl mb-6 leading-tight">
                      Request your no-obligation market analysis
                    </h2>
                    <Form {...form}>
                      <form
                        onSubmit={form.handleSubmit((d) => submit.mutate(d))}
                        className="space-y-4"
                        data-testid="evaluation-form"
                      >
                        <FormField
                          control={form.control}
                          name="address"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Property address</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="123 Aspen Summit Circle SW"
                                  {...field}
                                  data-testid="input-address"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <FormField
                            control={form.control}
                            name="beds"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Bedrooms (optional)</FormLabel>
                                <Select
                                  value={field.value}
                                  onValueChange={field.onChange}
                                >
                                  <FormControl>
                                    <SelectTrigger data-testid="select-beds">
                                      <SelectValue placeholder="Any" />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {["2", "3", "4", "5", "6+"].map((b) => (
                                      <SelectItem key={b} value={b}>
                                        {b} {b === "6+" ? "or more" : ""}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="timeframe"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Selling timeframe</FormLabel>
                                <Select
                                  value={field.value}
                                  onValueChange={field.onChange}
                                >
                                  <FormControl>
                                    <SelectTrigger data-testid="select-timeframe">
                                      <SelectValue placeholder="When?" />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {TIMEFRAMES.map((t) => (
                                      <SelectItem key={t.value} value={t.value}>
                                        {t.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>

                        <FormField
                          control={form.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Your name</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="First and last name"
                                  {...field}
                                  data-testid="input-name"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <FormField
                            control={form.control}
                            name="email"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Email</FormLabel>
                                <FormControl>
                                  <Input
                                    type="email"
                                    placeholder="you@example.com"
                                    {...field}
                                    data-testid="input-email"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="phone"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Phone (optional)</FormLabel>
                                <FormControl>
                                  <Input
                                    type="tel"
                                    placeholder="(403) 555-1234"
                                    {...field}
                                    data-testid="input-phone"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>

                        <FormField
                          control={form.control}
                          name="notes"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Anything else (optional)</FormLabel>
                              <FormControl>
                                <Textarea
                                  rows={3}
                                  placeholder="Recent renovations, what prompted you to consider selling, etc."
                                  {...field}
                                  data-testid="input-notes"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <Button
                          type="submit"
                          disabled={submit.isPending}
                          className="w-full h-12 font-display text-[11px] tracking-[0.22em]"
                          data-testid="button-submit"
                        >
                          {submit.isPending ? (
                            "SENDING…"
                          ) : (
                            <>
                              REQUEST EVALUATION
                              <Send className="w-3.5 h-3.5 ml-2" strokeWidth={1.8} />
                            </>
                          )}
                        </Button>

                        <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                          Spencer reviews every request personally. No bots, no
                          auto-sequence, no spam. Reply to opt-out anytime.{" "}
                          <PrivacyLink />.
                        </p>
                      </form>
                    </Form>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Instant valuation widget (Gnowise proxy) ------------------------ */}
      <HomeValuationWidget
        onSeedManualForm={(addr, unit) => {
          // When the user clicks "request the hand-prepared analysis" we
          // prefill the manual form's address field with whatever they just
          // ran through the instant estimate.
          const combined = unit ? `${addr} (Unit ${unit})` : addr;
          form.setValue("address", combined);
        }}
      />

      {/* What you'll receive ---------------------------------------------- */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground">
          WHAT YOU'LL RECEIVE
        </div>
        <h2 className="mt-4 font-serif text-3xl lg:text-5xl leading-[1.05] max-w-3xl">
          A comprehensive market analysis — built by hand, in Calgary, by Spencer.
        </h2>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {[
            {
              icon: Home,
              eyebrow: "01",
              title: "Comparable sales",
              body: "Hand-picked comps from the last 60 days at the right price tier in your neighbourhood — not the algorithm's best guess.",
            },
            {
              icon: TrendingUp,
              eyebrow: "02",
              title: "Market position",
              body: "Where your home sits in today's absorption rate, days-on-market, and pricing band. What's actually selling, and what isn't.",
            },
            {
              icon: Map,
              eyebrow: "03",
              title: "Neighbourhood read",
              body: "Block-level demand, school catchment effects, and how recent renovations or features add or subtract from your number.",
            },
            {
              icon: ShieldCheck,
              eyebrow: "04",
              title: "Honest recommendation",
              body: "Whether to list now, wait, or invest in a specific improvement first. Sometimes the answer is 'don't sell yet' — and that's fine.",
            },
          ].map((card) => (
            <div key={card.title} className="border-t border-foreground pt-6">
              <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                {card.eyebrow}
              </div>
              <card.icon className="w-6 h-6 mt-4 text-foreground" strokeWidth={1.5} />
              <h3 className="mt-4 font-serif text-2xl leading-[1.15]">
                {card.title}
              </h3>
              <p className="mt-3 text-[14.5px] leading-[1.7] text-foreground/80">
                {card.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Why Spencer ------------------------------------------------------ */}
      <section className="bg-secondary/40 border-y border-border">
        <div className="max-w-[1100px] mx-auto px-6 lg:px-10 py-20 lg:py-28">
          <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground">
            WHY SPENCER
          </div>
          <h2 className="mt-4 font-serif text-3xl lg:text-4xl leading-[1.15]">
            Calgary luxury market specialist. Six communities. One agent who
            knows them block-by-block.
          </h2>
          <p className="mt-6 max-w-3xl text-[15px] leading-[1.7] text-foreground/80">
            Spencer Rivers works the inner-city and west-side luxury markets
            full-time: Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow
            Park, Britannia, and Bel-Aire. CLHMS, CIPS, CNE, CCS, LLS. Million
            Dollar Guild member. The market analysis you'll receive reflects
            real, current Calgary data — not a national algorithm.
          </p>

          <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
            {[
              { stat: "8", label: "Calgary communities tracked weekly" },
              { stat: "60d", label: "Recent comparable sales reviewed per analysis" },
              { stat: "<1h", label: "Typical response time during business hours" },
            ].map((s) => (
              <div
                key={s.label}
                className="border border-border bg-background rounded-sm py-8 px-4"
              >
                <div className="font-serif text-4xl tabular-nums">{s.stat}</div>
                <div className="mt-3 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                  {s.label.toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA -------------------------------------------------------- */}
      <section className="max-w-[1100px] mx-auto px-6 lg:px-10 py-20 lg:py-28 text-center">
        <h2
          className="font-serif text-3xl lg:text-5xl leading-[1.05]"
          style={{ letterSpacing: "-0.005em" }}
        >
          Ready to see your number?
        </h2>
        <p className="mt-5 max-w-xl mx-auto text-muted-foreground text-[15px] leading-relaxed">
          Scroll back up and fill in your address — or call Spencer directly
          for a same-day conversation.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <Button className="h-12 px-8 rounded-sm font-display text-[11px] tracking-[0.22em]">
              REQUEST EVALUATION
              <ArrowRight className="w-3.5 h-3.5 ml-2" strokeWidth={1.8} />
            </Button>
          </a>
          <a
            href={SPENCER_PHONE_HREF}
            className="inline-flex items-center gap-2 px-5 py-3 border border-border rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-secondary transition-colors"
            data-testid="link-phone-bottom"
          >
            CALL {SPENCER_PHONE}
          </a>
        </div>
      </section>
    </PublicLayout>
  );
}
