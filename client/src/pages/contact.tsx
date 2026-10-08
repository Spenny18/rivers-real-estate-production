import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Phone,
  Mail,
  MapPin,
  Send,
  Clock,
  Check,
  ArrowRight,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
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
import { PrivacyLink } from "@/components/privacy-link";


const inquirySchema = z.object({
  name: z.string().min(2, "Please share your name"),
  email: z.string().email("Please share a valid email"),
  phone: z.string().optional(),
  intent: z.enum(["buying", "selling", "valuation", "general"]),
  neighbourhood: z.string().optional(),
  message: z.string().min(10, "Tell me a little about what you're looking for"),
});

type InquiryForm = z.infer<typeof inquirySchema>;

const INTENTS: { value: InquiryForm["intent"]; label: string }[] = [
  { value: "buying", label: "I'm thinking about buying" },
  { value: "selling", label: "I'm thinking about selling" },
  { value: "valuation", label: "I'd like a property valuation" },
  { value: "general", label: "Something else" },
];

const NEIGHBOURHOODS = [
  "Springbank Hill",
  "Aspen Woods",
  "Upper Mount Royal",
  "Elbow Park",
  "Britannia",
  "Bel-Aire",
  "Other / not sure yet",
];

export default function ContactPage() {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<InquiryForm>({
    resolver: zodResolver(inquirySchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      intent: "general",
      neighbourhood: "",
      message: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: InquiryForm) => {
      const intentLabel = INTENTS.find((i) => i.value === data.intent)?.label;
      const composedMessage = [
        `Intent: ${intentLabel}`,
        data.neighbourhood ? `Neighbourhood: ${data.neighbourhood}` : "",
        "",
        data.message,
      ]
        .filter(Boolean)
        .join("\n");

      const r = await apiRequest("POST", "/api/inquiry", {
        name: data.name,
        email: data.email,
        phone: data.phone || undefined,
        message: composedMessage,
        source: `Contact page · ${data.intent}`,
      });
      return r.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      toast({
        title: "Note sent",
        description: "Spencer will reach out within the day.",
      });
      form.reset();
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't send",
        description:
          err?.message ?? "Please try again or call directly.",
        variant: "destructive",
      });
    },
  });

  return (
    <PublicLayout>
      {/* Header */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pt-12 lg:pt-20 pb-12">
        <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
          GET IN TOUCH
        </div>
        <h1 className="mt-5 font-serif text-[44px] lg:text-[80px] leading-[1.0]">
          The first conversation is
          <br />
          where every good move starts.
        </h1>
        <p className="mt-6 max-w-2xl text-[16px] lg:text-[17px] leading-relaxed text-muted-foreground">
          Whether you're a year out from selling, six months out from buying,
          or just want to know what your home is worth — call, text, or send a
          note. Every inquiry gets a personal reply within the day.
        </p>
      </section>

      {/* Contact methods */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ContactMethod
            icon={Phone}
            label="Call or text"
            primary={SPENCER_PHONE}
            href={SPENCER_PHONE_HREF}
            blurb="Fastest reply · 7 days a week"
            testId="contact-phone"
          />
          <ContactMethod
            icon={Mail}
            label="Email Spencer"
            primary={SPENCER_EMAIL}
            href={SPENCER_EMAIL_HREF}
            blurb="Replies within 24 hours"
            testId="contact-email"
          />
          <ContactMethod
            icon={MapPin}
            label="Office"
            primary="Synterra Realty"
            href="https://www.google.com/maps/search/?api=1&query=Synterra+Realty+Calgary"
            blurb="Calgary, Alberta · By appointment"
            testId="contact-office"
          />
        </div>
      </section>

      {/* Form + side rail */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-10 lg:gap-16">
          {/* Form */}
          <div className="border border-border rounded-sm p-6 lg:p-10 bg-card">
            {submitted ? (
              <div className="py-6">
                <div className="w-12 h-12 rounded-full bg-foreground text-background flex items-center justify-center">
                  <Check className="w-6 h-6" strokeWidth={2} />
                </div>
                <h2 className="mt-6 font-serif text-3xl lg:text-4xl leading-[1.1]">
                  Note received.
                </h2>
                <p className="mt-4 max-w-md text-foreground/80 leading-relaxed">
                  Spencer will be in touch within the day. If it's urgent or
                  you'd rather talk now, ring direct.
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <a
                    href={SPENCER_PHONE_HREF}
                    className="inline-flex items-center gap-2 px-5 py-3 border border-border rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-secondary transition-colors"
                  >
                    <Phone className="w-3.5 h-3.5" strokeWidth={1.8} />
                    {SPENCER_PHONE}
                  </a>
                  <Button
                    variant="outline"
                    onClick={() => setSubmitted(false)}
                    className="font-display text-[11px] tracking-[0.22em]"
                    data-testid="button-send-another"
                  >
                    SEND ANOTHER NOTE
                  </Button>
                </div>
              </div>
            ) : (
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit((d) => mutation.mutate(d))}
                  className="space-y-5"
                  data-testid="form-contact"
                >
                  <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                    SEND A NOTE
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                            YOUR NAME
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              className="h-11"
                              placeholder="Full name"
                              data-testid="input-contact-name"
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
                              {...field}
                              type="email"
                              className="h-11"
                              placeholder="you@example.com"
                              data-testid="input-contact-email"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

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
                            {...field}
                            className="h-11"
                            placeholder="(403) ..."
                            data-testid="input-contact-phone"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="intent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                          I'M REACHING OUT BECAUSE…
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger
                              className="h-11"
                              data-testid="select-contact-intent"
                            >
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {INTENTS.map((i) => (
                              <SelectItem key={i.value} value={i.value}>
                                {i.label}
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
                    name="neighbourhood"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                          NEIGHBOURHOOD (OPTIONAL)
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || ""}
                        >
                          <FormControl>
                            <SelectTrigger
                              className="h-11"
                              data-testid="select-contact-neighbourhood"
                            >
                              <SelectValue placeholder="Pick one (optional)" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {NEIGHBOURHOODS.map((n) => (
                              <SelectItem key={n} value={n}>
                                {n}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="message"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-display text-[10px] tracking-[0.22em]">
                          A FEW WORDS
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            rows={5}
                            placeholder="Tell me what you're working on. Timeline, budget, style — whatever's on your mind."
                            data-testid="textarea-contact-message"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button
                    type="submit"
                    className="w-full h-12 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2"
                    disabled={mutation.isPending}
                    data-testid="button-submit-contact"
                  >
                    <Send className="w-4 h-4" strokeWidth={1.8} />
                    {mutation.isPending ? "SENDING…" : "SEND THE NOTE"}
                    {!mutation.isPending && (
                      <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
                    )}
                  </Button>

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    By sending, you agree Spencer can reach out by phone or
                    email about your inquiry. No spam, no list-sharing — ever.{" "}
                    <PrivacyLink />.
                  </p>
                </form>
              </Form>
            )}
          </div>

          {/* Side rail */}
          <aside className="space-y-8">
            <div>
              <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                HOURS
              </div>
              <div className="mt-3 space-y-2 text-[14px]">
                <Row label="Mon – Fri" value="8:00 AM – 8:00 PM" />
                <Row label="Saturday" value="9:00 AM – 6:00 PM" />
                <Row label="Sunday" value="10:00 AM – 5:00 PM" />
              </div>
              <p className="mt-4 text-[12px] text-muted-foreground inline-flex items-start gap-2">
                <Clock
                  className="w-3 h-3 mt-1 shrink-0"
                  strokeWidth={1.8}
                />
                Texts go through after hours and on showings days — Spencer
                replies as soon as he's between meetings.
              </p>
            </div>

            <div>
              <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                SERVICE AREA
              </div>
              <ul className="mt-3 space-y-1.5 text-[14px]">
                {NEIGHBOURHOODS.slice(0, 6).map((n) => (
                  <li key={n} className="text-foreground">
                    {n}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-muted-foreground">
                Spencer also represents clients in adjacent inner-city
                communities for the right fit.
              </p>
            </div>

            <div className="border-t border-border pt-6">
              <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                BROKERAGE
              </div>
              <div className="mt-3 text-[14px] leading-relaxed">
                <div className="font-medium">Synterra Realty</div>
                <div className="text-muted-foreground">
                  Calgary, Alberta
                  <br />
                  REALTOR® | CLHMS, CNE, CIPS, CCS, LLS
                  <br />
                  Million Dollar Guild
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </PublicLayout>
  );
}

function ContactMethod({
  icon: Icon,
  label,
  primary,
  href,
  blurb,
  testId,
}: {
  icon: any;
  label: string;
  primary: string;
  href: string;
  blurb: string;
  testId: string;
}) {
  return (
    <a
      href={href}
      target={href.startsWith("http") ? "_blank" : undefined}
      rel={href.startsWith("http") ? "noreferrer" : undefined}
      className="group block border border-border rounded-sm p-6 bg-card hover:border-foreground/30 transition-colors"
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <div className="w-10 h-10 rounded-full border border-border flex items-center justify-center">
          <Icon className="w-4 h-4" strokeWidth={1.6} />
        </div>
        <ArrowRight
          className="w-4 h-4 opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
          strokeWidth={1.6}
        />
      </div>
      <div className="mt-5 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
        {label.toUpperCase()}
      </div>
      <div className="mt-1.5 font-serif text-xl">{primary}</div>
      <div className="mt-2 text-[12px] text-muted-foreground">{blurb}</div>
    </a>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline border-b border-border/60 pb-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
