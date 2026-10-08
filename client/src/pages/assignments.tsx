// Assignment sales landing page (/assignments). Targets buyers and sellers of
// pre-construction condo assignment contracts in Calgary, with the current
// roster of available assignments (data-driven, edit ASSIGNMENT_UNITS below).
// SEO: FAQ + breadcrumb schema via SeoHead; server-side meta lives in
// server/seo-inject.ts and the sitemap entry in server/routes.ts — keep both
// in sync when the title/description here changes.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "wouter";
import {
  ArrowRight,
  ArrowRightLeft,
  Building2,
  Check,
  Clock,
  FileText,
  KeyRound,
  LineChart,
  Mail,
  MapPin,
  Phone,
  Scale,
  Send,
  ShieldCheck,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { SeoHead } from "@/components/seo-head";
import { FaqAccordion } from "@/components/faq-accordion";
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
import {
  SPENCER_PHONE,
  SPENCER_PHONE_HREF,
  SPENCER_EMAIL,
  SPENCER_EMAIL_HREF,
} from "@/lib/format";
import { PrivacyNote } from "@/components/privacy-link";


const SITE_ORIGIN = "https://riversrealestate.ca";

// --- Available assignments -------------------------------------------
// Public-safe details only: no original contract prices, no assignor names.
// Pricing is provided on inquiry.
interface AssignmentUnit {
  id: string;
  building: string;
  developer: string;
  location: string; // "Neighbourhood · address/intersection"
  headline: string;
  image: string;
  imageAlt: string;
  specs: Array<{ label: string; value: string }>;
  highlights: string[];
  links: Array<{ label: string; href: string }>;
}

const ASSIGNMENT_UNITS: AssignmentUnit[] = [
  {
    id: "lincoln",
    building: "The Lincoln",
    developer: "Truman",
    location: "Beltline · 301 11 Avenue SW",
    headline: "11th-floor 'Greta' plan in Truman's 36-storey Beltline tower.",
    image: "/img/assignments/lincoln-exterior.jpg",
    imageAlt:
      "Rendering of The Lincoln by Truman — 36-storey tower at 301 11 Avenue SW in Calgary's Beltline",
    specs: [
      { label: "Floor plan", value: "“Greta”" },
      { label: "Floor", value: "11th" },
      { label: "Est. occupancy", value: "2027 – 2029" },
      { label: "Est. condo fee", value: "$276/mo" },
    ],
    highlights: [
      "36 months of condo fees credited at closing under the original contract terms",
      "Concrete construction with air-conditioned suites and approx. 9-ft ceilings",
      "Fisher & Paykel appliance package with gas range and quartz counters",
      "21,000+ sq.ft. of amenities on two floors — indoor pool, fitness centre, spin and dance studios",
      "Front-desk concierge with complimentary house-car service",
      "Walk Score 98 — 11th Avenue and 2nd Street SW, steps to 17th Avenue",
    ],
    links: [
      { label: "About the Lincoln building", href: "/condos/lincoln" },
      { label: "Explore the Beltline", href: "/neighbourhoods/beltline" },
    ],
  },
  {
    id: "sovereign",
    building: "Sovereign",
    developer: "Homes by Avi Urban",
    location: "Mission · 210 18 Avenue SW",
    headline: "Two-bedroom Plan D on 18th Avenue at the edge of Mission.",
    image: "/img/assignments/sovereign-exterior.jpg",
    imageAlt:
      "Rendering of Sovereign by Homes by Avi Urban — 12-storey building at 210 18 Avenue SW in Calgary's Mission district",
    specs: [
      { label: "Plan", value: "D — 2 Bed | 2 Bath" },
      { label: "Size", value: "973 sq.ft. builder area" },
      { label: "Est. occupancy", value: "2026 – 2027" },
      { label: "Est. condo fee", value: "$451/mo" },
    ],
    highlights: [
      "Primary suite with walk-through closet and tiled-shower ensuite, plus a full second bath",
      "98 sq.ft. balcony with a gas line for the BBQ",
      "Kitchen with quartz counters, soft-close cabinetry, and island",
      "Dedicated laundry room with full-size front-load washer and dryer",
      "Whirlpool appliance package including French-door refrigerator",
      "18th Avenue and 1st Street SW — Mission's restaurants and the river pathway minutes away",
    ],
    links: [
      { label: "Explore Mission", href: "/neighbourhoods/mission" },
      { label: "Luxury condos in Calgary", href: "/condos" },
    ],
  },
];

// --- SEO copy ---------------------------------------------------------
const SEO_TITLE =
  "Calgary Condo Assignment Sales | Buy or Sell a Pre-Construction Assignment | Spencer Rivers";
const SEO_DESCRIPTION =
  "Buy or sell a pre-construction condo assignment in Calgary with Spencer Rivers. Current assignments at the Lincoln (Beltline) and Sovereign (Mission), plus developer consent, deposits, and GST handled properly.";

const FAQ_ITEMS = [
  {
    q: "What is an assignment sale?",
    a: "An assignment sale transfers a pre-construction purchase contract from the original buyer (the assignor) to a new buyer (the assignee) before the building completes and title transfers. The new buyer steps into the original contract with the developer, takes over the deposits already paid, and completes the purchase with the developer on the original terms when the unit is ready.",
  },
  {
    q: "Are assignment sales legal in Alberta?",
    a: "Yes. Assignments are legal in Alberta and are governed by the terms of the original purchase contract, which typically requires the developer's written consent and may include an assignment fee. Alberta's Condominium Property Act also protects deposits held in trust through the process.",
  },
  {
    q: "Why would I buy an assignment instead of buying from the developer?",
    a: "Two reasons: selection and timing. An assignment can put you into a floor plan, floor level, or contract terms that sold out years ago — often with a shorter wait until occupancy because much of the construction timeline has already run. Every assignment is evaluated against what the developer is currently selling, so you see the comparison before you commit.",
  },
  {
    q: "Why would I sell my pre-construction contract as an assignment?",
    a: "Life changes faster than construction schedules. A new city, a new relationship, a different financial picture — an assignment lets you exit the contract before completion rather than closing on a home you no longer need. Done properly, you recover your deposits and any gain in the contract's value, without carrying the unit to closing.",
  },
  {
    q: "Who pays the GST on an assignment?",
    a: "It depends on how the assignment is structured and on the assignor's tax situation — GST can apply to the assignment amount, and the new-home GST treatment carries specific rules. This is one of the areas where Spencer insists both sides get professional tax and legal advice before signing, and the answer is documented in the assignment agreement rather than assumed.",
  },
  {
    q: "Does the developer have to approve the assignment?",
    a: "Almost always, yes. Most Calgary pre-construction contracts — including Truman's and Homes by Avi's — require the developer's written consent and may charge an administration or assignment fee. Spencer coordinates the consent process with the developer's sales team so the assignment is valid, documented, and doesn't put the underlying contract at risk.",
  },
  {
    q: "Can I get a mortgage on an assignment purchase?",
    a: "Yes — you finance the purchase the same way you would a new unit from the developer, with the mortgage funding at final closing. The difference is the cash required earlier: you typically reimburse the assignor's deposits when the assignment is signed. A lender or broker who has handled assignments before matters here, and Spencer can point you to several.",
  },
  {
    q: "What does it cost to sell my assignment through a REALTOR®?",
    a: "Commission on an assignment sale is negotiated up front, in writing, just like a resale listing — and it's typically paid from the assignment proceeds. Spencer also walks through the developer's assignment fee and any tax implications first, so the net number is on paper before the contract is marketed. No one pays full price for a stale donut, and no one should sell without knowing their net.",
  },
];

// --- Inquiry form -----------------------------------------------------
const inquirySchema = z.object({
  name: z.string().min(2, "Please enter your name"),
  email: z.string().email("Please enter a valid email"),
  phone: z.string().optional(),
  interest: z.string(),
  message: z.string().min(1, "Please add a short note"),
});

type InquiryForm = z.infer<typeof inquirySchema>;

const INTEREST_OPTIONS = [
  { value: "lincoln", label: "The Lincoln — Beltline assignment" },
  { value: "sovereign", label: "Sovereign — Mission assignment" },
  { value: "buying", label: "Buying an assignment (general)" },
  { value: "selling", label: "Selling my pre-construction contract" },
];

function AssignmentInquiryForm() {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<InquiryForm>({
    resolver: zodResolver(inquirySchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      interest: "buying",
      message: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: InquiryForm) => {
      const interestLabel = INTEREST_OPTIONS.find(
        (o) => o.value === data.interest,
      )?.label;
      const r = await apiRequest("POST", "/api/inquiry", {
        name: data.name,
        email: data.email,
        phone: data.phone || undefined,
        message: [`Interest: ${interestLabel}`, "", data.message].join("\n"),
        source: `Assignments page · ${data.interest}`,
      });
      return r.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      toast({
        title: "Inquiry sent",
        description: "Spencer will reach out within the day.",
      });
      form.reset();
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't send",
        description: err?.message ?? "Please try again or call directly.",
        variant: "destructive",
      });
    },
  });

  if (submitted) {
    return (
      <div
        className="border border-border rounded-sm p-10 text-center"
        data-testid="text-assignment-inquiry-success"
      >
        <Check className="w-8 h-8 mx-auto text-foreground" strokeWidth={1.4} />
        <h3 className="mt-4 font-serif text-2xl">Inquiry received.</h3>
        <p className="mt-2 text-muted-foreground text-[14px]">
          Spencer will reach out within the day with pricing and full details.
        </p>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((d) => mutation.mutate(d))}
        className="space-y-5"
        data-testid="form-assignment-inquiry"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                  NAME
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder="Your name"
                    className="rounded-sm h-11"
                    data-testid="input-assignment-name"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                  EMAIL
                </FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    className="rounded-sm h-11"
                    data-testid="input-assignment-email"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                  PHONE (OPTIONAL)
                </FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    placeholder="(403) 555-0123"
                    className="rounded-sm h-11"
                    data-testid="input-assignment-phone"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="interest"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                  I'M INTERESTED IN
                </FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger
                      className="rounded-sm h-11"
                      data-testid="select-assignment-interest"
                    >
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {INTEREST_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
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
          name="message"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                MESSAGE
              </FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Timeline, budget range, questions — whatever is useful."
                  className="rounded-sm min-h-[120px]"
                  data-testid="input-assignment-message"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          disabled={mutation.isPending}
          className="h-12 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2 px-8"
          data-testid="button-assignment-submit"
        >
          <Send className="w-3.5 h-3.5" strokeWidth={1.8} />
          {mutation.isPending ? "SENDING…" : "REQUEST DETAILS & PRICING"}
        </Button>
        <PrivacyNote />
      </form>
    </Form>
  );
}

// --- Page -------------------------------------------------------------
export default function AssignmentsPage() {
  const canonical = `${SITE_ORIGIN}/assignments`;

  return (
    <PublicLayout>
      {/* Schema (breadcrumbs) is server-emitted by metaForPath — this only
          keeps title/meta current on SPA nav. */}
      <SeoHead
        title={SEO_TITLE}
        description={SEO_DESCRIPTION}
        canonical={canonical}
        ogImage={`${SITE_ORIGIN}${ASSIGNMENT_UNITS[0].image}`}
      />

      {/* Hero */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pt-12 lg:pt-16 pb-16 lg:pb-20">
        <div className="max-w-[860px]">
          <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
            ASSIGNMENT SALES — CALGARY
          </div>
          <h1 className="mt-5 font-serif text-[40px] lg:text-[68px] leading-[1.02] tracking-tight">
            Pre-construction contracts,
            <br />
            <em className="not-italic font-normal">bought and sold properly.</em>
          </h1>
          <p className="mt-8 max-w-[680px] text-[17px] lg:text-[18px] leading-[1.7] text-foreground/85">
            An assignment sale moves a pre-construction condo contract from its
            original buyer to a new one before the building completes — a legal,
            developer-consented transfer that trades quietly, off the MLS's main
            stage. Spencer Rivers handles both sides in Calgary: buyers stepping
            into sold-out floor plans at the Lincoln in the Beltline or Sovereign
            in Mission, and contract holders whose plans changed before the
            building finished.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="#available-assignments">
              <Button
                className="h-12 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2 px-6"
                data-testid="button-assignments-hero-view"
              >
                VIEW AVAILABLE ASSIGNMENTS
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
              </Button>
            </a>
            <a href={SPENCER_PHONE_HREF}>
              <Button
                variant="outline"
                className="h-12 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2 px-6"
                data-testid="button-assignments-hero-call"
              >
                <Phone className="w-3.5 h-3.5" strokeWidth={1.8} />
                CALL OR TEXT SPENCER
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Available assignments */}
      <section
        id="available-assignments"
        className="bg-secondary/30 border-y border-border py-16 lg:py-24 scroll-mt-24"
      >
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10">
          <div className="max-w-2xl mb-12">
            <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
              CURRENTLY AVAILABLE
            </div>
            <h2 className="font-serif text-[30px] lg:text-[44px] leading-[1.05] tracking-tight">
              Assignments available now.
            </h2>
            <p className="mt-5 text-[15px] text-muted-foreground leading-relaxed">
              Two contracts, two of the inner city's strongest addresses.
              Assignment pricing and full contract terms are provided on
              inquiry, subject to developer consent.
            </p>
          </div>

          <div className="space-y-10">
            {ASSIGNMENT_UNITS.map((unit, idx) => (
              <article
                key={unit.id}
                className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-border rounded-sm overflow-hidden bg-card"
                data-testid={`card-assignment-${unit.id}`}
              >
                <div
                  className={`lg:col-span-5 ${idx % 2 === 1 ? "lg:order-2" : ""}`}
                >
                  <div className="h-64 lg:h-full min-h-[280px]">
                    <img
                      src={unit.image}
                      alt={unit.imageAlt}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                </div>

                <div className="lg:col-span-7 p-8 lg:p-12">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <div className="font-display text-[10px] tracking-[0.28em] text-muted-foreground">
                        {unit.developer.toUpperCase()}
                      </div>
                      <h3 className="mt-2 font-serif text-[28px] lg:text-[36px] leading-tight">
                        {unit.building}
                      </h3>
                      <div className="mt-2 inline-flex items-center gap-2 text-[13px] text-muted-foreground">
                        <MapPin className="w-3.5 h-3.5" strokeWidth={1.6} />
                        {unit.location}
                      </div>
                    </div>
                    <div className="font-serif italic text-[18px] text-muted-foreground">
                      Pricing on inquiry
                    </div>
                  </div>

                  <p className="mt-5 text-[15px] leading-relaxed text-foreground/85">
                    {unit.headline}
                  </p>

                  <dl className="mt-7 grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border">
                    {unit.specs.map((s) => (
                      <div key={s.label} className="bg-card p-4">
                        <dt className="font-display text-[9px] tracking-[0.22em] text-muted-foreground">
                          {s.label.toUpperCase()}
                        </dt>
                        <dd className="mt-1.5 font-serif text-[15px] leading-snug">
                          {s.value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <ul className="mt-7 space-y-2.5">
                    {unit.highlights.map((h) => (
                      <li
                        key={h}
                        className="flex gap-3 text-[13.5px] text-muted-foreground leading-relaxed"
                      >
                        <Check
                          className="w-4 h-4 mt-0.5 shrink-0 text-foreground"
                          strokeWidth={1.6}
                        />
                        {h}
                      </li>
                    ))}
                  </ul>

                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <a href="#inquire">
                      <Button
                        className="h-11 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2 px-6"
                        data-testid={`button-assignment-inquire-${unit.id}`}
                      >
                        INQUIRE ABOUT THIS ASSIGNMENT
                        <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
                      </Button>
                    </a>
                    {unit.links.map((l) => (
                      <Link key={l.href} href={l.href} className="inline-flex items-center gap-2 font-display text-[10px] tracking-[0.22em] text-muted-foreground hover:text-foreground transition-colors"
                          data-testid={`link-assignment-${unit.id}-${l.href.replace(/[^a-z0-9]+/g, "-")}`}>
                          {l.label.toUpperCase()}
                          <ArrowRight className="w-3 h-3" strokeWidth={1.8} />
                        
                      </Link>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <p className="mt-8 text-[12px] text-muted-foreground leading-relaxed max-w-[820px]">
            Details are drawn from the original purchase contracts and builder
            specifications and are subject to change by the developer.
            Renderings courtesy of Truman and Homes by Avi.
            Occupancy windows and condo fees are developer estimates. Every
            assignment completes subject to the developer's written consent and
            the terms of the underlying contract.
          </p>
        </div>
      </section>

      {/* How an assignment works */}
      <section className="max-w-[1100px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
          HOW IT WORKS
        </div>
        <h2 className="font-serif text-[30px] lg:text-[44px] leading-[1.05] tracking-tight mb-6">
          One contract changes hands.
          <br />
          Three things have to go right.
        </h2>
        <p className="max-w-[680px] text-[15px] text-muted-foreground leading-relaxed mb-12">
          The unit doesn't close twice — the new buyer steps into the original
          contract and completes with the developer when the building is ready.
          What changes hands is the contract itself, and that transfer has to be
          priced, papered, and consented to correctly.
        </p>
        <div className="space-y-10">
          {[
            {
              title: "Price the contract, not just the unit",
              body: "An assignment's value is the unit's current market value measured against the original contract price, deposits paid, remaining deposit schedule, and any credits that transfer — like condo-fee credits at closing. Spencer runs that math against what the developer is selling today and recent comparable sales, so both sides negotiate from evidence.",
            },
            {
              title: "Developer consent and clean paper",
              body: "The developer's written consent, the assignment agreement, the deposit reimbursement, and the original contract's terms all have to line up — with lawyers on both sides who have done this before. Spencer coordinates the developer's sales team, both law firms, and the paperwork through to a consented, enforceable assignment.",
            },
            {
              title: "Complete with the developer at occupancy",
              body: "After the assignment, the new buyer finishes exactly as the original buyer would have: financing at final closing, walkthrough, possession, and warranty coverage under Alberta's New Home Buyer Protection Act. Spencer stays on the file through possession day, not just signing day.",
            },
          ].map((step, i) => (
            <div
              key={step.title}
              className="grid grid-cols-[64px_1fr] lg:grid-cols-[96px_1fr] gap-5 lg:gap-8 items-start border-t border-border pt-8"
            >
              <div className="font-serif italic text-[40px] lg:text-[56px] leading-none text-muted-foreground/60">
                {i + 1}
              </div>
              <div>
                <h3 className="font-serif text-[22px] lg:text-[26px] leading-tight">
                  {step.title}
                </h3>
                <p className="mt-3 max-w-[640px] text-[15px] text-muted-foreground leading-relaxed">
                  {step.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Buyers / Sellers value props */}
      <section className="bg-secondary/30 border-y border-border py-16 lg:py-24">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16">
            {/* Buyers */}
            <div>
              <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
                FOR BUYERS
              </div>
              <h2 className="font-serif text-[26px] lg:text-[34px] leading-[1.1] tracking-tight mb-8">
                Into a sold-out building, on yesterday's contract.
              </h2>
              <div className="space-y-6">
                {[
                  {
                    icon: KeyRound,
                    title: "Plans you can't buy anymore",
                    body: "The best floor plans and floor levels in a tower sell first — often years before completion. An assignment is frequently the only way into a specific plan, view, or price point the developer sold out long ago.",
                  },
                  {
                    icon: Clock,
                    title: "A shorter runway to keys",
                    body: "Buying an assignment mid-construction means most of the waiting is already done. Occupancy windows at the Lincoln and Sovereign are measured in months-to-a-couple-of-years, not the four-plus years a new pre-construction purchase can run.",
                  },
                  {
                    icon: LineChart,
                    title: "Priced against today's evidence",
                    body: "Spencer values every assignment against the developer's current pricing and recent resale comparables before you offer — so you know exactly what the contract is worth now, not what it was worth at launch.",
                  },
                ].map(({ icon: Icon, title, body }) => (
                  <div key={title} className="flex gap-5">
                    <div className="w-11 h-11 shrink-0 border border-border rounded-sm flex items-center justify-center bg-card">
                      <Icon className="w-5 h-5" strokeWidth={1.4} />
                    </div>
                    <div>
                      <h3 className="font-serif text-[19px] leading-tight">
                        {title}
                      </h3>
                      <p className="mt-2 text-[13.5px] text-muted-foreground leading-relaxed">
                        {body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Sellers */}
            <div>
              <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
                FOR CONTRACT HOLDERS
              </div>
              <h2 className="font-serif text-[26px] lg:text-[34px] leading-[1.1] tracking-tight mb-8">
                Plans changed? Exit the contract, keep the equity.
              </h2>
              <div className="space-y-6">
                {[
                  {
                    icon: ArrowRightLeft,
                    title: "An exit before closing",
                    body: "A move, a marriage, a market shift — if the unit no longer fits your life, an assignment lets you transfer the contract before completion instead of closing on a home you don't need and selling it after.",
                  },
                  {
                    icon: ShieldCheck,
                    title: "Deposits recovered, consent secured",
                    body: "Done properly, the buyer reimburses your deposits and the developer consents in writing. Done casually, an off-side assignment can put your deposits and the contract itself at risk. Spencer runs the process by the book.",
                  },
                  {
                    icon: Scale,
                    title: "Marketed discreetly, negotiated hard",
                    body: "Assignments trade through networks, pre-construction investors, and buyers already hunting these buildings. Spencer markets the contract to the right audience, with the net-proceeds math — developer fees, commission, tax questions flagged — on paper before it's listed.",
                  },
                ].map(({ icon: Icon, title, body }) => (
                  <div key={title} className="flex gap-5">
                    <div className="w-11 h-11 shrink-0 border border-border rounded-sm flex items-center justify-center bg-card">
                      <Icon className="w-5 h-5" strokeWidth={1.4} />
                    </div>
                    <div>
                      <h3 className="font-serif text-[19px] leading-tight">
                        {title}
                      </h3>
                      <p className="mt-2 text-[13.5px] text-muted-foreground leading-relaxed">
                        {body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why Spencer */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6">
          {[
            {
              icon: Building2,
              title: "Certified Condo Specialist",
              body: "Spencer reads the disclosure documents, proposed budgets, and contract terms behind every assignment — the building's paperwork gets the same scrutiny as the deal itself.",
            },
            {
              icon: FileText,
              title: "Contract-level diligence",
              body: "Deposit schedules, occupancy ranges, credits, assignment clauses, developer fees — every material term is pulled from the original contract and put in front of you before you sign anything.",
            },
            {
              icon: Scale,
              title: "Certified Negotiation Expert",
              body: "Assignment pricing has more moving parts than a resale — deposits, credits, GST treatment, and the developer's current pricing all factor in. Spencer negotiates from that full picture.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="border border-border rounded-sm bg-card p-7 lg:p-8"
            >
              <Icon className="w-6 h-6 text-foreground" strokeWidth={1.4} />
              <h3 className="mt-5 font-serif text-[20px] leading-tight">
                {title}
              </h3>
              <p className="mt-3 text-[13.5px] text-muted-foreground leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <FaqAccordion
        items={FAQ_ITEMS}
        heading="Assignment sales, answered"
        eyebrow="ASSIGNMENT FAQ"
      />

      {/* Inquiry form */}
      <section
        id="inquire"
        className="bg-secondary/30 border-y border-border py-16 lg:py-24 scroll-mt-24"
      >
        <div className="max-w-[1100px] mx-auto px-6 lg:px-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
            <div className="lg:col-span-5">
              <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
                REQUEST DETAILS
              </div>
              <h2 className="font-serif text-[30px] lg:text-[40px] leading-[1.08] tracking-tight">
                Pricing, floor plans, and contract terms — on request.
              </h2>
              <p className="mt-5 text-[15px] text-muted-foreground leading-relaxed">
                Assignment details are shared directly rather than published.
                Tell Spencer which opportunity interests you — or that you have
                a contract to sell — and he'll reply personally within the day.
              </p>
              <div className="mt-8 space-y-3">
                <a
                  href={SPENCER_PHONE_HREF}
                  className="flex items-center gap-3 text-[14px] hover:text-muted-foreground transition-colors"
                  data-testid="link-assignments-phone"
                >
                  <Phone className="w-4 h-4" strokeWidth={1.6} />
                  {SPENCER_PHONE}
                </a>
                <a
                  href={SPENCER_EMAIL_HREF}
                  className="flex items-center gap-3 text-[14px] hover:text-muted-foreground transition-colors"
                  data-testid="link-assignments-email"
                >
                  <Mail className="w-4 h-4" strokeWidth={1.6} />
                  {SPENCER_EMAIL}
                </a>
              </div>
            </div>
            <div className="lg:col-span-7">
              <AssignmentInquiryForm />
            </div>
          </div>
        </div>
      </section>

      {/* Related links */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6">
          {[
            {
              title: "Luxury condos & penthouses",
              desc: "Calgary's premier buildings, building by building.",
              href: "/condos",
            },
            {
              title: "Urban buyers' guide",
              desc: "How Spencer works with condo and inner-city buyers.",
              href: "/work-with/urban-properties",
            },
            {
              title: "Search every MLS listing",
              desc: "Completed condos for sale across Calgary today.",
              href: "/mls",
            },
          ].map((l) => (
            <Link key={l.href} href={l.href} className="group block border border-border rounded-sm p-7 hover:border-foreground/40 transition-colors"
                data-testid={`link-assignments-related-${l.href.replace(/[^a-z0-9]+/g, "-")}`}>
                <h3 className="font-serif text-[19px] leading-tight">
                  {l.title}
                </h3>
                <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
                  {l.desc}
                </p>
                <div className="mt-5 inline-flex items-center gap-2 font-display text-[10px] tracking-[0.22em] text-foreground group-hover:gap-3 transition-all">
                  EXPLORE
                  <ArrowRight className="w-3 h-3" strokeWidth={1.8} />
                </div>
              
            </Link>
          ))}
        </div>
      </section>
    </PublicLayout>
  );
}
