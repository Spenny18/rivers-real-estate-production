// /book — the menu of bookable meeting types. Equivalent to a Calendly
// profile page: one card per meeting, each linking to its own booking page.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Clock, MapPin, Phone, Video, Loader2 } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { SPENCER_PHONE, SPENCER_PHONE_HREF, SPENCER_EMAIL, SPENCER_EMAIL_HREF } from "@/lib/format";

interface PublicEventType {
  id: number;
  slug: string;
  name: string;
  description: string;
  durationMinutes: number;
  locationType: string;
  locationLabel: string;
  color: string;
}

function LocationIcon({ type, className }: { type: string; className?: string }) {
  if (type === "video") return <Video className={className} />;
  if (type === "in_person") return <MapPin className={className} />;
  return <Phone className={className} />;
}

export default function BookIndexPage() {
  const { data: types = [], isLoading } = useQuery<PublicEventType[]>({
    queryKey: ["/api/booking/event-types"],
  });

  return (
    <PublicLayout>
      <section className="max-w-5xl mx-auto px-6 md:px-10 pt-16 pb-24">
        <div className="max-w-2xl">
          <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
            BOOK A TIME
          </div>
          <h1 className="font-serif text-[36px] md:text-[52px] leading-[1.05] tracking-[-0.02em] mb-5">
            Let's find a time that works.
          </h1>
          <p className="text-[15px] md:text-[16px] text-muted-foreground leading-relaxed">
            Pick the conversation that fits where you are. You'll see my real
            availability, choose a time in your own time zone, and get a
            confirmation with a calendar invite immediately — no phone tag.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground mt-14">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading meeting types…
          </div>
        ) : types.length === 0 ? (
          <div className="mt-14 border border-border rounded-sm p-8">
            <p className="text-[15px] text-muted-foreground leading-relaxed">
              Online booking isn't open right now. Call{" "}
              <a href={SPENCER_PHONE_HREF} className="text-foreground underline underline-offset-4">
                {SPENCER_PHONE}
              </a>{" "}
              or email{" "}
              <a href={SPENCER_EMAIL_HREF} className="text-foreground underline underline-offset-4">
                {SPENCER_EMAIL}
              </a>{" "}
              and we'll set something up directly.
            </p>
          </div>
        ) : (
          <div className="mt-14 grid gap-4 md:grid-cols-2" data-testid="event-type-list">
            {types.map((t) => (
              <Link
                key={t.slug}
                href={`/book/${t.slug}`}
                data-testid={`link-book-${t.slug}`}
                className="group block border border-border rounded-sm p-7 hover:border-foreground/40 transition-colors relative overflow-hidden"
              >
                <span
                  className="absolute left-0 top-0 bottom-0 w-[3px]"
                  style={{ background: t.color }}
                  aria-hidden
                />
                <h2 className="font-serif text-[24px] leading-tight tracking-[-0.01em] mb-3">
                  {t.name}
                </h2>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-muted-foreground mb-4">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    {t.durationMinutes} min
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <LocationIcon type={t.locationType} className="h-3.5 w-3.5" />
                    {t.locationLabel}
                  </span>
                </div>
                <p className="text-[14px] text-muted-foreground leading-relaxed line-clamp-4">
                  {t.description}
                </p>
                <span className="mt-5 inline-flex items-center gap-2 font-display text-[11px] tracking-[0.18em] text-foreground">
                  SELECT A TIME
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
          </div>
        )}

        <div className="mt-16 pt-8 border-t border-border text-[13px] text-muted-foreground leading-relaxed">
          Prefer to skip the form? Call{" "}
          <a href={SPENCER_PHONE_HREF} className="text-foreground underline underline-offset-4">
            {SPENCER_PHONE}
          </a>{" "}
          — if I'm with clients, leave a message and I'll call back the same day.
        </div>
      </section>
    </PublicLayout>
  );
}
