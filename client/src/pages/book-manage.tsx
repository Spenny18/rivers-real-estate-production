// /book/manage/:uid — the invitee's own view of their booking.
//
// The uid in the URL is the only credential; it's unguessable (128 bits) and
// is the same link the confirmation email carries. From here they can add the
// meeting to a calendar, move it, or cancel it.

import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, Clock, Loader2, MapPin, Phone, Video, X } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
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

interface ManagedBooking {
  uid: string;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  cancelReason: string | null;
  eventType: {
    slug: string;
    name: string;
    description: string;
    durationMinutes: number;
    locationType: string;
    locationLabel: string;
    color: string;
  };
}

function LocationIcon({ type, className }: { type: string; className?: string }) {
  if (type === "video") return <Video className={className} />;
  if (type === "in_person") return <MapPin className={className} />;
  return <Phone className={className} />;
}

export default function BookManagePage() {
  const params = useParams<{ uid: string }>();
  const uid = params.uid ?? "";
  const qc = useQueryClient();

  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [newSlot, setNewSlot] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const key = [`/api/booking/bookings/${uid}`];
  const { data: booking, isLoading, isError } = useQuery<ManagedBooking>({
    queryKey: key,
    enabled: !!uid,
  });

  const reschedule = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/booking/bookings/${uid}/reschedule`, {
        startsAt: newSlot,
      });
      return (await res.json()) as ManagedBooking;
    },
    onSuccess: (b) => {
      qc.setQueryData(key, b);
      // The freed and taken slots both changed — drop the cached slot lists.
      qc.invalidateQueries({ queryKey: ["booking-slots"] });
      setMode("view");
      setNewSlot(null);
      setError(null);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/booking/bookings/${uid}/cancel`, {
        reason: reason || undefined,
      });
      return (await res.json()) as ManagedBooking;
    },
    onSuccess: (b) => {
      qc.setQueryData(key, b);
      qc.invalidateQueries({ queryKey: ["booking-slots"] });
      setMode("view");
      setError(null);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  if (isLoading) {
    return (
      <PublicLayout>
        <div className="max-w-3xl mx-auto px-6 py-32 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your booking…
        </div>
      </PublicLayout>
    );
  }

  if (isError || !booking) {
    return (
      <PublicLayout>
        <div className="max-w-3xl mx-auto px-6 py-32">
          <h1 className="font-serif text-[32px] mb-4">We couldn't find that booking.</h1>
          <p className="text-[15px] text-muted-foreground mb-6 leading-relaxed">
            The link may be out of date. Book a new time, or call{" "}
            <a href={SPENCER_PHONE_HREF} className="text-foreground underline underline-offset-4">
              {SPENCER_PHONE}
            </a>
            .
          </p>
          <Link
            href="/book"
            className="font-display text-[11px] tracking-[0.18em] underline underline-offset-4"
          >
            BOOK A TIME
          </Link>
        </div>
      </PublicLayout>
    );
  }

  const cancelled = booking.status === "cancelled";
  const past = Date.parse(booking.endsAt) < Date.now();

  return (
    <PublicLayout>
      <section className="max-w-3xl mx-auto px-6 md:px-10 py-16" data-testid="manage-booking">
        <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
          {cancelled ? "BOOKING CANCELLED" : past ? "PAST BOOKING" : "YOUR BOOKING"}
        </div>
        <h1 className="font-serif text-[34px] md:text-[42px] leading-[1.08] tracking-[-0.02em] mb-8">
          {booking.eventType.name}
        </h1>

        <div
          className={`border border-border rounded-sm divide-y divide-border ${cancelled ? "opacity-60" : ""}`}
        >
          <div className="p-5">
            <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1.5">
              WHEN
            </div>
            <div className={`text-[15px] ${cancelled ? "line-through" : ""}`}>
              {formatLongDateTime(booking.startsAt, timezone)}
            </div>
            <div className="text-[12px] text-muted-foreground mt-1">
              {booking.eventType.durationMinutes} minutes · {zoneLabel(timezone)}
            </div>
          </div>
          <div className="p-5">
            <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1.5">
              WHERE
            </div>
            <div className="text-[15px]">{booking.eventType.locationLabel}</div>
          </div>
          <div className="p-5">
            <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1.5">
              WHO
            </div>
            <div className="text-[15px]">{booking.name}</div>
            <div className="text-[13px] text-muted-foreground mt-0.5">
              {booking.email}
              {booking.phone ? ` · ${booking.phone}` : ""}
            </div>
          </div>
        </div>

        {cancelled ? (
          <div className="mt-8">
            <p className="text-[15px] text-muted-foreground leading-relaxed mb-6">
              This booking was cancelled{booking.cancelReason ? ` — "${booking.cancelReason}"` : ""}.
              The time is back in the calendar if you'd like to grab another.
            </p>
            <Link href={`/book/${booking.eventType.slug}`}>
              <Button
                data-testid="button-book-again"
                className="rounded-sm px-7 h-11 font-display text-[11px] tracking-[0.18em]"
              >
                BOOK A NEW TIME
              </Button>
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href={apiUrl(`/api/booking/bookings/${booking.uid}/ics`)}
                data-testid="link-ics"
                className="inline-flex items-center gap-2 border border-border rounded-sm px-4 py-2.5 text-[12px] font-display tracking-[0.14em] hover:bg-secondary/60 transition-colors"
              >
                <CalendarPlus className="h-3.5 w-3.5" /> ADD TO CALENDAR
              </a>
              {!past && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setMode(mode === "reschedule" ? "view" : "reschedule");
                      setError(null);
                    }}
                    data-testid="button-reschedule"
                    className="inline-flex items-center gap-2 border border-border rounded-sm px-4 py-2.5 text-[12px] font-display tracking-[0.14em] hover:bg-secondary/60 transition-colors"
                  >
                    <Clock className="h-3.5 w-3.5" /> RESCHEDULE
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode(mode === "cancel" ? "view" : "cancel");
                      setError(null);
                    }}
                    data-testid="button-cancel"
                    className="inline-flex items-center gap-2 border border-border rounded-sm px-4 py-2.5 text-[12px] font-display tracking-[0.14em] text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" /> CANCEL
                  </button>
                </>
              )}
            </div>

            {error && (
              <p className="mt-5 text-[13px] text-destructive leading-relaxed" data-testid="manage-error">
                {error}
              </p>
            )}

            {mode === "reschedule" && (
              <div className="mt-10 pt-10 border-t border-border">
                <h2 className="font-serif text-[24px] tracking-[-0.01em] mb-6">Pick a new time</h2>
                <BookingPicker
                  slug={booking.eventType.slug}
                  timezone={timezone}
                  onTimezoneChange={setTimezone}
                  selected={newSlot}
                  onSelect={(iso) => {
                    setNewSlot(iso);
                    setError(null);
                  }}
                  disabledNote={`Currently booked for ${formatLongDateTime(booking.startsAt, timezone)}.`}
                />
                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <Button
                    onClick={() => reschedule.mutate()}
                    disabled={!newSlot || reschedule.isPending}
                    data-testid="button-confirm-reschedule"
                    className="rounded-sm px-7 h-11 font-display text-[11px] tracking-[0.18em]"
                  >
                    {reschedule.isPending ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> MOVING…
                      </>
                    ) : (
                      <>
                        <Check className="h-3.5 w-3.5 mr-2" /> CONFIRM NEW TIME
                      </>
                    )}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setMode("view")}
                    className="text-[12px] text-muted-foreground underline underline-offset-4"
                  >
                    Never mind
                  </button>
                </div>
              </div>
            )}

            {mode === "cancel" && (
              <div className="mt-10 pt-10 border-t border-border max-w-xl">
                <h2 className="font-serif text-[24px] tracking-[-0.01em] mb-3">Cancel this booking?</h2>
                <p className="text-[14px] text-muted-foreground leading-relaxed mb-5">
                  The time goes straight back into the calendar. You can book again whenever suits.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="cancel-reason" className="text-[12px]">
                    Reason <span className="text-muted-foreground">(optional — helps me plan)</span>
                  </Label>
                  <Textarea
                    id="cancel-reason"
                    data-testid="input-cancel-reason"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="mt-6 flex flex-wrap items-center gap-4">
                  <Button
                    variant="destructive"
                    onClick={() => cancel.mutate()}
                    disabled={cancel.isPending}
                    data-testid="button-confirm-cancel"
                    className="rounded-sm px-7 h-11 font-display text-[11px] tracking-[0.18em]"
                  >
                    {cancel.isPending ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> CANCELLING…
                      </>
                    ) : (
                      "CANCEL BOOKING"
                    )}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setMode("view")}
                    className="text-[12px] text-muted-foreground underline underline-offset-4"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </PublicLayout>
  );
}
