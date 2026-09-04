// /book/:slug — the booking page for a single meeting type.
//
// Three steps in one view: pick a time, fill in who you are, done. The
// confirmed state doubles as the receipt (add-to-calendar links + the manage
// link the confirmation email also carries).

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  Clock,
  Loader2,
  MapPin,
  Phone,
  Video,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { apiErrorMessage, apiRequest, apiUrl } from "@/lib/queryClient";
import {
  BookingPicker,
  browserTimeZone,
  formatLongDateTime,
  zoneLabel,
} from "@/components/booking-picker";
import { SPENCER_PHONE, SPENCER_PHONE_HREF } from "@/lib/format";

interface PublicEventType {
  id: number;
  slug: string;
  name: string;
  description: string;
  durationMinutes: number;
  locationType: string;
  locationLabel: string;
  color: string;
  timezone: string;
  requirePhone: boolean;
  customQuestion: string | null;
  confirmationMessage: string | null;
}

interface BookingResult {
  uid: string;
  name: string;
  email: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  eventType: PublicEventType;
}

function LocationIcon({ type, className }: { type: string; className?: string }) {
  if (type === "video") return <Video className={className} />;
  if (type === "in_person") return <MapPin className={className} />;
  return <Phone className={className} />;
}

/** Google Calendar's "add event" URL — the same one Calendly hands out. */
function googleCalendarUrl(b: BookingResult): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.eventType.name} — Spencer Rivers`,
    dates: `${stamp(b.startsAt)}/${stamp(b.endsAt)}`,
    details: `${b.eventType.description}\n\nManage this booking: ${window.location.origin}/book/manage/${b.uid}`,
    location: b.eventType.locationLabel,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export default function BookEventPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";

  const [timezone, setTimezone] = useState(browserTimeZone);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "", answer: "" });
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<BookingResult | null>(null);

  const {
    data: eventType,
    isLoading,
    isError,
  } = useQuery<PublicEventType>({
    queryKey: [`/api/booking/event-types/${slug}`],
    enabled: !!slug,
  });

  // A listing page can deep-link here with ?listing=A2305467 so the booking
  // records which property prompted it.
  const listingId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("listing") ?? "";
  }, []);

  useEffect(() => {
    if (confirmed) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [confirmed]);

  const book = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/booking/event-types/${slug}/book`, {
        ...form,
        phone: form.phone || undefined,
        notes: form.notes || undefined,
        answer: form.answer || undefined,
        startsAt: selected,
        timezone,
        listingId: listingId || undefined,
      });
      return (await res.json()) as BookingResult;
    },
    onSuccess: (b) => {
      setError(null);
      setConfirmed(b);
    },
    // A 409 here means the slot went while the form was being filled in —
    // the message names that so they know to pick again.
    onError: (e) => setError(apiErrorMessage(e)),
  });

  if (isLoading) {
    return (
      <PublicLayout>
        <div className="max-w-5xl mx-auto px-6 py-32 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </PublicLayout>
    );
  }

  if (isError || !eventType) {
    return (
      <PublicLayout>
        <div className="max-w-5xl mx-auto px-6 py-32">
          <h1 className="font-serif text-[32px] mb-4">That meeting type isn't available.</h1>
          <p className="text-[15px] text-muted-foreground mb-6">
            It may have been renamed or taken offline.
          </p>
          <Link
            href="/book"
            className="font-display text-[11px] tracking-[0.18em] underline underline-offset-4"
          >
            SEE WHAT'S BOOKABLE
          </Link>
        </div>
      </PublicLayout>
    );
  }

  // ---- Confirmed ----------------------------------------------------------
  if (confirmed) {
    return (
      <PublicLayout>
        <section className="max-w-2xl mx-auto px-6 md:px-10 py-20" data-testid="booking-confirmed">
          <div
            className="h-12 w-12 rounded-full grid place-items-center mb-7"
            style={{ background: eventType.color }}
          >
            <Check className="h-6 w-6 text-white" />
          </div>
          <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
            YOU'RE BOOKED
          </div>
          <h1 className="font-serif text-[34px] md:text-[42px] leading-[1.08] tracking-[-0.02em] mb-5">
            {confirmed.eventType.name} confirmed.
          </h1>
          <p className="text-[15px] text-muted-foreground leading-relaxed mb-8">
            {eventType.confirmationMessage ||
              `A confirmation is on its way to ${confirmed.email}. Add it to your calendar below so you get a reminder.`}
          </p>

          <div className="border border-border rounded-sm divide-y divide-border">
            <div className="p-5">
              <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1.5">
                WHEN
              </div>
              <div className="text-[15px]">{formatLongDateTime(confirmed.startsAt, timezone)}</div>
              <div className="text-[12px] text-muted-foreground mt-1">
                {confirmed.eventType.durationMinutes} minutes · {zoneLabel(timezone)}
              </div>
            </div>
            <div className="p-5">
              <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1.5">
                WHERE
              </div>
              <div className="text-[15px]">{confirmed.eventType.locationLabel}</div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={googleCalendarUrl(confirmed)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-google-calendar"
              className="inline-flex items-center gap-2 border border-border rounded-sm px-4 py-2.5 text-[12px] font-display tracking-[0.14em] hover:bg-secondary/60 transition-colors"
            >
              <CalendarPlus className="h-3.5 w-3.5" /> GOOGLE CALENDAR
            </a>
            <a
              href={apiUrl(`/api/booking/bookings/${confirmed.uid}/ics`)}
              data-testid="link-ics"
              className="inline-flex items-center gap-2 border border-border rounded-sm px-4 py-2.5 text-[12px] font-display tracking-[0.14em] hover:bg-secondary/60 transition-colors"
            >
              <CalendarPlus className="h-3.5 w-3.5" /> APPLE / OUTLOOK
            </a>
          </div>

          <p className="mt-8 text-[13px] text-muted-foreground leading-relaxed">
            Need to change it?{" "}
            <Link
              href={`/book/manage/${confirmed.uid}`}
              data-testid="link-manage"
              className="text-foreground underline underline-offset-4"
            >
              Reschedule or cancel
            </Link>{" "}
            any time — that link is in your confirmation email too.
          </p>
        </section>
      </PublicLayout>
    );
  }

  // ---- Picker + form ------------------------------------------------------
  const canSubmit =
    !!selected &&
    form.name.trim().length >= 2 &&
    /.+@.+\..+/.test(form.email) &&
    (!eventType.requirePhone || form.phone.trim().length >= 7) &&
    !book.isPending;

  return (
    <PublicLayout>
      <section className="max-w-5xl mx-auto px-6 md:px-10 py-14">
        <Link
          href="/book"
          className="inline-flex items-center gap-2 font-display text-[10px] tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-3 w-3" /> ALL MEETING TYPES
        </Link>

        <div className="grid md:grid-cols-[280px_1fr] gap-10 md:gap-14">
          {/* ---- Meeting summary rail ---- */}
          <aside className="md:border-r md:border-border md:pr-10">
            <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-3">
              SPENCER RIVERS
            </div>
            <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em] mb-5">
              {eventType.name}
            </h1>
            <div className="space-y-2.5 text-[13px] text-muted-foreground">
              <div className="flex items-center gap-2.5">
                <Clock className="h-4 w-4 shrink-0" />
                {eventType.durationMinutes} minutes
              </div>
              <div className="flex items-start gap-2.5">
                <LocationIcon type={eventType.locationType} className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{eventType.locationLabel}</span>
              </div>
            </div>
            <p className="mt-6 text-[14px] text-muted-foreground leading-relaxed">
              {eventType.description}
            </p>
            {selected && (
              <div
                className="mt-6 border-l-2 pl-4 py-1"
                style={{ borderColor: eventType.color }}
                data-testid="selected-summary"
              >
                <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1">
                  SELECTED
                </div>
                <div className="text-[14px] text-foreground leading-snug">
                  {formatLongDateTime(selected, timezone)}
                </div>
              </div>
            )}
          </aside>

          {/* ---- Picker, then form ---- */}
          <div>
            <BookingPicker
              slug={slug}
              timezone={timezone}
              onTimezoneChange={setTimezone}
              selected={selected}
              onSelect={(iso) => {
                setSelected(iso);
                setError(null);
              }}
            />

            {selected && (
              <form
                className="mt-10 pt-10 border-t border-border space-y-5"
                data-testid="booking-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmit) book.mutate();
                }}
              >
                <h2 className="font-serif text-[22px] tracking-[-0.01em]">
                  Who am I meeting?
                </h2>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="bk-name" className="text-[12px]">
                      Name <span className="text-muted-foreground">*</span>
                    </Label>
                    <Input
                      id="bk-name"
                      data-testid="input-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      required
                      autoComplete="name"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bk-email" className="text-[12px]">
                      Email <span className="text-muted-foreground">*</span>
                    </Label>
                    <Input
                      id="bk-email"
                      data-testid="input-email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      required
                      autoComplete="email"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bk-phone" className="text-[12px]">
                    Phone{" "}
                    {eventType.requirePhone ? (
                      <span className="text-muted-foreground">*</span>
                    ) : (
                      <span className="text-muted-foreground">(optional)</span>
                    )}
                  </Label>
                  <Input
                    id="bk-phone"
                    data-testid="input-phone"
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    required={eventType.requirePhone}
                    autoComplete="tel"
                  />
                </div>

                {eventType.customQuestion && (
                  <div className="space-y-1.5">
                    <Label htmlFor="bk-answer" className="text-[12px]">
                      {eventType.customQuestion}
                    </Label>
                    <Input
                      id="bk-answer"
                      data-testid="input-answer"
                      value={form.answer}
                      onChange={(e) => setForm({ ...form, answer: e.target.value })}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="bk-notes" className="text-[12px]">
                    Anything I should know first? <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="bk-notes"
                    data-testid="input-notes"
                    rows={4}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="Timeline, budget, neighbourhoods you're circling — whatever helps me come prepared."
                  />
                </div>

                {error && (
                  <p className="text-[13px] text-destructive leading-relaxed" data-testid="booking-error">
                    {error}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    data-testid="button-confirm-booking"
                    className="rounded-sm px-7 h-11 font-display text-[11px] tracking-[0.18em]"
                  >
                    {book.isPending ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> BOOKING…
                      </>
                    ) : (
                      "CONFIRM BOOKING"
                    )}
                  </Button>
                  <span className="text-[12px] text-muted-foreground">
                    or call{" "}
                    <a href={SPENCER_PHONE_HREF} className="underline underline-offset-4">
                      {SPENCER_PHONE}
                    </a>
                  </span>
                </div>
              </form>
            )}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
