// Instant home valuation widget — two-phase flow:
//
//   Phase 1: collect contact info (name + email + phone). The "Get
//            Estimate" button is disabled until these are valid.
//   Phase 2: address autocomplete (with aerial preview) + the property
//            details Gnowise's AVM actually needs to be accurate (sqft,
//            beds, baths, lot, age, type — plus an optional "more details"
//            expander for style/basement/garage/AC/pool). Submit emails
//            the visitor a branded report AND creates a lead for Spencer.
//
// Why property details up front: Gnowise's address-only path returns near-
// empty property_attributes on sparsely-indexed Calgary addresses — e.g.
// 38 Elmont Cv SW (actual ~$1.86M) came back at $268K because the model
// was valuing an essentially empty record. Per Gnowise support (Amir,
// 2026-06), forwarding the documented §4 attributes brings the same home
// back at $1.83M+ with confidence 0.94. The initial form is the right
// place to collect those — every visitor on a luxury home eval page knows
// their own sqft and bed count, so the friction is low and the accuracy
// payoff is enormous.
//
// The refinement banner (shown only when Gnowise STILL returns thin
// attributes after we sent them) is kept as a defence-in-depth fallback
// and almost never fires now.
//
// We deliberately gate the value behind contact info — Spencer's whole
// reason for adding this is lead capture. Each estimate is a fully-formed
// lead with what they're evaluating + their info.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Building2,
  Home,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Pencil,
  Wand2,
  ChevronDown,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { formatPrice, formatPriceCompact } from "@/lib/format";
import {
  PlacesAutocomplete,
  type PlaceSelection,
} from "@/components/places-autocomplete";
import { StaticMapPreview } from "@/components/static-map-preview";
import { PrivacyLink } from "@/components/privacy-link";


interface ValuationResponse {
  ok: boolean;
  message?: string;
  estimate?: number;
  valueLow?: number;
  valueHigh?: number;
  confidence?: number;
  valuationSource?: "A" | "H" | "HA";
  estimatedLease?: number;
  leaseLow?: number;
  leaseHigh?: number;
  capRate?: number;
  liquidityScore?: number;
  parameters?: Record<string, any>;
}

interface EmailResponse {
  ok: boolean;
  message?: string;
  result?: ValuationResponse;
  leadId?: number;
}

// Source fields needed to re-call /api/public/valuation for a given history
// entry during refinement. Captured at the moment the initial estimate runs
// so refinement is decoupled from whatever the address autocomplete is
// pointing at now (the user may have entered a second address before
// circling back to refine the first one).
interface HistoryEntrySource {
  address: string;
  aptNum: string;
  isCondo: boolean;
  postalCode?: string;
  municipality?: string;
  province?: string;
}

interface HistoryEntry {
  id: string;
  displayAddress: string;
  aptNum: string;
  isCondo: boolean;
  source: HistoryEntrySource;
  result: ValuationResponse;
  /** Whether the refinement form is currently expanded on this row. */
  refining: boolean;
}

interface Contact {
  name: string;
  email: string;
  phone: string;
}

interface Props {
  onSeedManualForm?: (address: string, aptNum: string) => void;
}

// Gnowise enumerations (PDF §5). Forwarded straight through to the API as
// documented values; the server passes them on without translation.
const PROPERTY_TYPES_HOUSE = [
  "Detached",
  "Semi-Detached",
  "Att/Row/Twnhouse",
  "Duplex",
  "Triplex",
  "Fourplex",
  "Multiplex",
];
const PROPERTY_TYPES_CONDO = [
  "Comm Element Condo",
  "Condo Apt",
  "Condo Townhouse",
];
const STYLES_HOUSE = [
  "1 1/2 Storey",
  "2-Storey",
  "2 1/2 Storey",
  "3-Storey",
  "Backsplit 3",
  "Backsplit 4",
  "Backsplit 5",
  "Bungaloft",
  "Bungalow",
  "Bungalow-Raised",
  "Sidesplit 3",
  "Sidesplit 4",
  "Sidesplit 5",
  "Other",
];
const STYLES_CONDO = [
  "Apartment",
  "Bachelor/Studio",
  "Loft",
  "Multi-Level",
  "Stacked Townhse",
  "Other",
];
const CONDITIONS: { value: string; label: string }[] = [
  { value: "1", label: "1 — Major repairs required" },
  { value: "2", label: "2 — Repairs needed" },
  { value: "3", label: "3 — Well maintained" },
  { value: "4", label: "4 — Like new" },
  { value: "5", label: "5 — New" },
];
const BASEMENTS = [
  "Finished",
  "Fin W/O",
  "Part Fin",
  "Unfinished",
  "Apartment",
  "Crawl Space",
  "Full",
  "Half",
  "Part Bsmt",
  "Sep Entrance",
  "W/O",
  "Walk-Up",
  "Other",
];
const POOLS = ["None", "Inground", "Abv Grnd", "Indoor"];
const ACS = ["Central Air", "Window Unit", "Wall Unit", "None", "Other"];

// Gnowise's API only accepts age as one of these bucketed strings (PDF §5.6).
// We collect a year-built integer from the user (much better UX than asking
// them to subtract from the current year) and convert to the right bucket
// just before submitting. The model can't distinguish 2018 from 2020 — both
// land in the same bucket — but a year input is friction-free where a
// dropdown was a chore. Computed once at module load; an end-of-year tick
// just gives next year's first deploy the new floor.
const CURRENT_YEAR = new Date().getFullYear();
function yearToAgeBucket(year: number | undefined): string | undefined {
  if (year == null || !Number.isFinite(year)) return undefined;
  if (year < 1800 || year > CURRENT_YEAR + 5) return undefined;
  const age = CURRENT_YEAR - year;
  if (age <= 0) return "New";
  if (age <= 5) return "0-5";
  if (age <= 10) return "6-10";
  if (age <= 15) return "11-15";
  if (age <= 30) return "16-30";
  if (age <= 50) return "31-50";
  if (age <= 99) return "51-99";
  return "100+";
}
const GARAGES = [
  "Attached",
  "Detached",
  "Built-In",
  "Underground",
  "Surface",
  "Carport",
  "None",
  "Other",
];

// Refinement form state. Mirrors the optional attributes the server route
// accepts; the server discards anything blank before forwarding to Gnowise.
// `yearBuilt` is a UX-level field — the user enters a year (e.g. 2018) and
// we bucket it to Gnowise's `Age` enum (e.g. "6-10") at submit time.
// `histValue` / `histValueDate` are the optional §9.1 HPI-adjusted anchor.
interface RefinementFormState {
  propertyType: string;
  style: string;
  bedrooms: string;
  washrooms: string;
  roomsArea: string;
  lotArea: string;
  yearBuilt: string;
  condition: string;
  basement: string;
  garageType: string;
  garageSpaces: string;
  ac: string;
  pool: string;
  histValue: string;
  histValueDate: string;
}

// Default form values. Most Calgary luxury homes are Detached / 2-Storey /
// Well-Maintained / no pool / central air / attached garage — seeding these
// reduces friction so the user only touches sqft, beds, baths, age, and
// the few fields they care about.
const refinementDefaults = (isCondo: boolean): RefinementFormState => ({
  propertyType: isCondo ? "Condo Apt" : "Detached",
  style: isCondo ? "Apartment" : "2-Storey",
  bedrooms: "",
  washrooms: "",
  roomsArea: "",
  lotArea: "",
  yearBuilt: "",
  condition: "3",
  basement: isCondo ? "" : "Finished",
  garageType: isCondo ? "Underground" : "Attached",
  // Default to 2 for detached / 1 for condo. Empirically (Gnowise scenario
  // probes on 38 Elmont Cv SW, 2026-06): leaving GarageSpaces blank treats
  // the property as if it has no garage and shaves $400K+ off the estimate.
  // Most Calgary luxury detached homes have ≥2 spaces, so 2 is a safer
  // baseline than blank. Visitors who know they have a triple bump to 3.
  garageSpaces: isCondo ? "1" : "2",
  ac: "Central Air",
  pool: "None",
  histValue: "",
  histValueDate: "",
});

function isContactComplete(c: Contact): boolean {
  return (
    c.name.trim().length >= 2 &&
    c.email.includes("@") &&
    c.email.includes(".") &&
    c.phone.trim().length >= 7
  );
}

// Treat the result as "thin" — and worth a refinement prompt — when Gnowise
// echoed back no living area. Amir at Gnowise flagged RoomsArea==null as
// the canonical signal for "model had no record to value." We also fire it
// when bedrooms+washrooms are both missing (the alternate fall-through).
function needsRefinement(r: ValuationResponse): boolean {
  const p = r.parameters ?? {};
  const sqft = p.RoomsArea ?? p.rooms_area;
  if (sqft == null) return true;
  const beds = p.Bedrooms ?? p.bedrooms;
  const baths = p.Washrooms ?? p.Bathrooms ?? p.washrooms;
  if (beds == null && baths == null) return true;
  return false;
}

export function HomeValuationWidget({ onSeedManualForm }: Props) {
  const [contact, setContact] = useState<Contact>({
    name: "",
    email: "",
    phone: "",
  });
  // Once the user finishes the contact form, we collapse it to a single-line
  // "as <Name>" badge with an Edit pencil. Lets them update if they typo'd
  // their email without redoing the layout for every subsequent valuation.
  const [contactLocked, setContactLocked] = useState(false);

  const [address, setAddress] = useState("");
  const [aptNum, setAptNum] = useState("");
  const [isCondo, setIsCondo] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSelection | null>(
    null,
  );
  // Property-detail fields the visitor fills in alongside the address.
  // Seeded with Calgary-luxury-appropriate defaults so they only have to
  // touch the few fields that change per-property (sqft, beds, baths, age).
  const [details, setDetails] = useState<RefinementFormState>(() =>
    refinementDefaults(false),
  );
  const updateDetail = <K extends keyof RefinementFormState>(
    key: K,
    value: RefinementFormState[K],
  ) => setDetails((d) => ({ ...d, [key]: value }));
  const [moreDetailsOpen, setMoreDetailsOpen] = useState(false);
  const [recentPurchaseOpen, setRecentPurchaseOpen] = useState(false);
  // When the visitor toggles condo on/off, flip the property-type / style /
  // basement / garage defaults so the right enums show up in the dropdowns
  // without forcing them to re-pick. They can still override anything.
  const setIsCondoAndDefaults = (v: boolean) => {
    setIsCondo(v);
    setDetails((d) => ({
      ...d,
      propertyType: v ? "Condo Apt" : "Detached",
      style: v ? "Apartment" : "2-Storey",
      basement: v ? "" : "Finished",
      garageType: v ? "Underground" : "Attached",
    }));
  };
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Initial estimate — gated, emails the visitor, creates a lead. We forward
  // every property detail field the user filled in so Gnowise has enough
  // signal to return an accurate first-try estimate. The server's
  // extractAttrs() drops anything blank before forwarding to the API.
  const valuation = useMutation<EmailResponse, Error>({
    mutationFn: async () => {
      const numeric = (v: string | undefined) => {
        if (!v || !v.trim()) return undefined;
        const n = Number(v.replace(/,/g, ""));
        return Number.isFinite(n) ? n : undefined;
      };
      const text = (v: string | undefined) =>
        v && v.trim() ? v.trim() : undefined;
      const res = await apiRequest("POST", "/api/public/valuation/email", {
        name: contact.name.trim(),
        email: contact.email.trim(),
        phone: contact.phone.trim(),
        address: selectedPlace?.streetAddress
          ? selectedPlace.streetAddress
          : address.trim(),
        aptNum: aptNum.trim(),
        isCondo: isCondo || !!aptNum.trim(),
        postalCode: selectedPlace?.postalCode,
        municipality: selectedPlace?.city,
        province: selectedPlace?.province,
        // Property attributes (PDF §4). The blank ones get dropped server-side.
        condition: numeric(details.condition),
        propertyType: text(details.propertyType),
        style: text(details.style),
        bedrooms: numeric(details.bedrooms),
        washrooms: numeric(details.washrooms),
        roomsArea: numeric(details.roomsArea),
        lotArea: numeric(details.lotArea),
        age: yearToAgeBucket(numeric(details.yearBuilt)),
        basement: text(details.basement),
        garageType: text(details.garageType),
        garageSpaces: numeric(details.garageSpaces),
        ac: text(details.ac),
        pool: text(details.pool),
        // §9.1 HPI-adjusted anchor. Only meaningful when histValue is set;
        // the server's extractAttrs drops it otherwise. We pair it with
        // the current propertyType so Gnowise has a complete anchor.
        histValue: numeric(details.histValue),
        histValueDate: text(details.histValueDate),
        histPropertyType: numeric(details.histValue)
          ? text(details.propertyType)
          : undefined,
      });
      return res.json();
    },
    onSuccess: (envelope) => {
      const r = envelope.result;
      if (!envelope.ok || !r || !r.ok || r.estimate == null) return;
      const sourceAddress = selectedPlace?.streetAddress
        ? selectedPlace.streetAddress
        : address.trim();
      setHistory((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          displayAddress:
            selectedPlace?.formattedAddress ||
            (aptNum.trim()
              ? `${address.trim()} · Unit ${aptNum.trim()}`
              : address.trim()),
          aptNum: aptNum.trim(),
          isCondo,
          source: {
            address: sourceAddress,
            aptNum: aptNum.trim(),
            isCondo: isCondo || !!aptNum.trim(),
            postalCode: selectedPlace?.postalCode,
            municipality: selectedPlace?.city,
            province: selectedPlace?.province,
          },
          result: r,
          refining: false,
        },
        ...prev,
      ]);
    },
  });

  // Refinement — re-call /api/public/valuation (no email, no second lead)
  // with extra attributes for a specific history entry. Replaces the entry
  // in place on success.
  const refine = useMutation<
    ValuationResponse,
    Error,
    { entryId: string; attrs: Partial<RefinementFormState> }
  >({
    mutationFn: async ({ entryId, attrs }) => {
      const entry = history.find((e) => e.id === entryId);
      if (!entry) throw new Error("That estimate is no longer in the list.");
      const numeric = (v: string | undefined) => {
        if (!v || !v.trim()) return undefined;
        const n = Number(v.replace(/,/g, ""));
        return Number.isFinite(n) ? n : undefined;
      };
      const text = (v: string | undefined) =>
        v && v.trim() ? v.trim() : undefined;
      const res = await apiRequest("POST", "/api/public/valuation", {
        address: entry.source.address,
        aptNum: entry.source.aptNum,
        isCondo: entry.source.isCondo,
        postalCode: entry.source.postalCode,
        municipality: entry.source.municipality,
        province: entry.source.province,
        condition: numeric(attrs.condition),
        propertyType: text(attrs.propertyType),
        style: text(attrs.style),
        bedrooms: numeric(attrs.bedrooms),
        washrooms: numeric(attrs.washrooms),
        roomsArea: numeric(attrs.roomsArea),
        lotArea: numeric(attrs.lotArea),
        age: yearToAgeBucket(numeric(attrs.yearBuilt)),
        basement: text(attrs.basement),
        garageType: text(attrs.garageType),
        garageSpaces: numeric(attrs.garageSpaces),
        ac: text(attrs.ac),
        pool: text(attrs.pool),
        histValue: numeric(attrs.histValue),
        histValueDate: text(attrs.histValueDate),
        histPropertyType: numeric(attrs.histValue)
          ? text(attrs.propertyType)
          : undefined,
      });
      return res.json();
    },
    onSuccess: (data, { entryId }) => {
      if (!data?.ok || data.estimate == null) return;
      setHistory((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, result: data, refining: false }
            : e,
        ),
      );
    },
  });

  const setEntryRefining = (entryId: string, refining: boolean) => {
    setHistory((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, refining } : e)),
    );
  };

  const handlePlace = (p: PlaceSelection) => {
    setAddress(p.formattedAddress);
    setSelectedPlace(p);
  };

  // Surface failures inline above the address form. The mutation payload
  // could fail because either (a) Gnowise couldn't value the address or
  // (b) the email send itself errored — both render the same way.
  const envelope = valuation.data;
  const latestFailure =
    envelope &&
    (!envelope.ok || !envelope.result?.ok)
      ? envelope.result?.message ?? envelope.message ?? "Couldn't run that one."
      : null;

  const contactReady = isContactComplete(contact);
  const phase: "contact" | "address" = contactLocked ? "address" : "contact";

  return (
    <section
      id="instant"
      className="relative bg-foreground text-background"
      data-testid="valuation-widget"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_540px] gap-12 lg:gap-16 items-start">
          {/* Left: copy ---------------------------------------------------- */}
          <div>
            <div className="font-display text-[11px] tracking-[0.32em] text-background/65 inline-flex items-center gap-2">
              <Sparkles className="w-3 h-3" strokeWidth={1.8} />
              INSTANT ALGORITHMIC ESTIMATE
            </div>
            <h2
              className="mt-5 font-serif text-3xl lg:text-5xl leading-[1.05]"
              style={{ letterSpacing: "-0.01em" }}
            >
              See your home's estimated value in seconds.
            </h2>
            <p className="mt-5 max-w-xl text-background/80 text-[15px] leading-relaxed">
              Powered by an automated valuation model trained on public records
              and recent comparable sales. Each estimate is emailed directly
              to you, and Spencer follows up personally within one business
              hour so you can ask any questions.
            </p>
            <ul className="mt-6 space-y-2 text-background/70 text-[13px]">
              <li className="flex items-start gap-2">
                <CheckCircle2
                  className="w-3.5 h-3.5 mt-1 shrink-0 text-background/85"
                  strokeWidth={2}
                />
                <span>Calgary address autocomplete (Google Places)</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2
                  className="w-3.5 h-3.5 mt-1 shrink-0 text-background/85"
                  strokeWidth={2}
                />
                <span>Estimated value, likely range, rent + cap rate</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2
                  className="w-3.5 h-3.5 mt-1 shrink-0 text-background/85"
                  strokeWidth={2}
                />
                <span>
                  Refine for accuracy by adding a few details — sqft, beds,
                  baths — and the estimate sharpens instantly.
                </span>
              </li>
            </ul>
          </div>

          {/* Right: form + history --------------------------------------- */}
          <div className="space-y-5">
            <div className="bg-background text-foreground rounded-sm border border-border p-7 lg:p-9 shadow-2xl">
              {/* Contact info — either expanded form or collapsed badge */}
              {phase === "contact" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (contactReady) setContactLocked(true);
                  }}
                  className="space-y-4"
                >
                  <div>
                    <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-2">
                      STEP 1 OF 2 — YOUR INFO
                    </div>
                    <h3 className="font-serif text-xl leading-tight">
                      Enter your contact info once.
                    </h3>
                    <p className="text-[13px] text-muted-foreground mt-1.5">
                      Each estimate gets emailed to you, and Spencer reviews
                      every one personally before following up.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="val-name">Your name</Label>
                    <Input
                      id="val-name"
                      value={contact.name}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, name: e.target.value }))
                      }
                      placeholder="First and last"
                      data-testid="input-contact-name"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="val-email">Email</Label>
                    <Input
                      id="val-email"
                      type="email"
                      value={contact.email}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, email: e.target.value }))
                      }
                      placeholder="you@example.com"
                      data-testid="input-contact-email"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="val-phone">Phone</Label>
                    <Input
                      id="val-phone"
                      type="tel"
                      value={contact.phone}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, phone: e.target.value }))
                      }
                      placeholder="(403) 555-1234"
                      data-testid="input-contact-phone"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={!contactReady}
                    className="w-full h-12 font-display text-[11px] tracking-[0.22em]"
                    data-testid="button-contact-continue"
                  >
                    CONTINUE TO ADDRESS
                  </Button>

                  <p className="text-[11px] text-muted-foreground leading-relaxed text-center">
                    Spencer reviews every request personally. No spam, reply
                    to opt out anytime. <PrivacyLink />.
                  </p>
                </form>
              ) : (
                <>
                  {/* Collapsed contact badge */}
                  <div className="flex items-start justify-between gap-3 mb-5 pb-5 border-b border-border">
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                        SENDING REPORTS TO
                      </div>
                      <div className="text-[14px] font-medium mt-1 truncate">
                        {contact.name}{" "}
                        <span className="text-muted-foreground font-normal">
                          · {contact.email}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setContactLocked(false)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Edit contact info"
                    >
                      <Pencil className="w-4 h-4" strokeWidth={1.8} />
                    </button>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (
                        !valuation.isPending &&
                        address.trim().length > 5
                      ) {
                        valuation.mutate();
                      }
                    }}
                    className="space-y-4"
                  >
                    <div>
                      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-2">
                        STEP 2 — PROPERTY ADDRESS
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="val-address">Property address</Label>
                      <PlacesAutocomplete
                        id="val-address"
                        value={address}
                        onChange={(v) => {
                          setAddress(v);
                          setSelectedPlace(null);
                        }}
                        onSelect={handlePlace}
                        data-testid="input-valuation-address"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Start typing, then pick from the dropdown — that's
                        how the aerial preview loads and how Gnowise gets
                        the postal code.
                      </p>
                    </div>

                    {/* Aerial preview — always present so the section never
                        disappears. Shows a labelled placeholder until the
                        user picks from the Google Places dropdown (which is
                        what sets lat/lng); flips to the real Static Maps
                        image as soon as a place is selected. Lets the user
                        visually confirm the property before they spend a
                        Gnowise call on it. */}
                    <div
                      className="space-y-1.5"
                      data-testid="map-preview-wrap"
                    >
                      <Label>Aerial preview</Label>
                      {selectedPlace?.lat != null &&
                      selectedPlace?.lng != null ? (
                        <StaticMapPreview
                          lat={selectedPlace.lat}
                          lng={selectedPlace.lng}
                          alt={`Aerial view of ${selectedPlace.formattedAddress}`}
                        />
                      ) : (
                        <div
                          className="bg-secondary/40 rounded-sm border border-dashed border-border w-full flex flex-col items-center justify-center text-center px-6"
                          style={{ aspectRatio: "600 / 280" }}
                          data-testid="map-preview-placeholder"
                        >
                          <MapPin
                            className="w-5 h-5 text-muted-foreground mb-2"
                            strokeWidth={1.5}
                          />
                          <p className="text-[12px] text-muted-foreground max-w-xs leading-relaxed">
                            Pick an address from the dropdown above to see
                            an aerial preview of the property.
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
                      <div className="space-y-1.5">
                        <Label htmlFor="val-unit">Unit / suite (if condo)</Label>
                        <Input
                          id="val-unit"
                          value={aptNum}
                          onChange={(e) => {
                            setAptNum(e.target.value);
                            if (e.target.value.trim() && !isCondo) {
                              setIsCondoAndDefaults(true);
                            }
                          }}
                          placeholder="e.g. 2104"
                          data-testid="input-valuation-unit"
                        />
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer pb-2.5">
                        <Checkbox
                          checked={isCondo}
                          onCheckedChange={(v) =>
                            setIsCondoAndDefaults(!!v)
                          }
                          id="val-iscondo"
                        />
                        <span className="text-[13px] select-none">
                          It's a condo
                        </span>
                      </label>
                    </div>

                    {/* Property details — the accuracy levers. Sqft is the
                        single biggest one per Gnowise §11 (and Amir's
                        diagnosis of the 38 Elmont undervaluation), so we
                        require it. Everything else is helpful but optional;
                        the defaults are tuned to Calgary luxury detached so
                        most visitors only touch sqft / beds / baths. */}
                    <div className="pt-2 border-t border-border">
                      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-3">
                        PROPERTY DETAILS
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-beds"
                            className="text-[11px]"
                          >
                            Bedrooms
                          </Label>
                          <Input
                            id="val-beds"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={details.bedrooms}
                            onChange={(e) =>
                              updateDetail("bedrooms", e.target.value)
                            }
                            placeholder="4"
                            className="h-9 text-[13px]"
                            data-testid="input-beds"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-baths"
                            className="text-[11px]"
                          >
                            Bathrooms
                          </Label>
                          <Input
                            id="val-baths"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={details.washrooms}
                            onChange={(e) =>
                              updateDetail("washrooms", e.target.value)
                            }
                            placeholder="4"
                            className="h-9 text-[13px]"
                            data-testid="input-baths"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-sqft"
                            className="text-[11px]"
                          >
                            Living sqft *
                          </Label>
                          <Input
                            id="val-sqft"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={details.roomsArea}
                            onChange={(e) =>
                              updateDetail("roomsArea", e.target.value)
                            }
                            placeholder="3,500"
                            className="h-9 text-[13px]"
                            data-testid="input-sqft"
                            required
                          />
                        </div>
                        {!isCondo && (
                          <div className="space-y-1.5">
                            <Label
                              htmlFor="val-lot"
                              className="text-[11px]"
                            >
                              Lot sqft
                            </Label>
                            <Input
                              id="val-lot"
                              type="number"
                              inputMode="numeric"
                              min={0}
                              value={details.lotArea}
                              onChange={(e) =>
                                updateDetail("lotArea", e.target.value)
                              }
                              placeholder="7,500"
                              className="h-9 text-[13px]"
                              data-testid="input-lot"
                            />
                          </div>
                        )}
                      </div>

                      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-year"
                            className="text-[11px]"
                          >
                            Year built
                          </Label>
                          <Input
                            id="val-year"
                            type="number"
                            inputMode="numeric"
                            min={1850}
                            max={CURRENT_YEAR + 5}
                            value={details.yearBuilt}
                            onChange={(e) =>
                              updateDetail("yearBuilt", e.target.value)
                            }
                            placeholder={String(CURRENT_YEAR - 8)}
                            className="h-9 text-[13px]"
                            data-testid="input-year-built"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-type"
                            className="text-[11px]"
                          >
                            Property type
                          </Label>
                          <Select
                            value={details.propertyType}
                            onValueChange={(v) =>
                              updateDetail("propertyType", v)
                            }
                          >
                            <SelectTrigger
                              id="val-type"
                              className="h-9 text-[13px]"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(isCondo
                                ? PROPERTY_TYPES_CONDO
                                : PROPERTY_TYPES_HOUSE
                              ).map((p) => (
                                <SelectItem key={p} value={p}>
                                  {p}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-cond"
                            className="text-[11px]"
                          >
                            Condition
                          </Label>
                          <Select
                            value={details.condition}
                            onValueChange={(v) =>
                              updateDetail("condition", v)
                            }
                          >
                            <SelectTrigger
                              id="val-cond"
                              className="h-9 text-[13px]"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CONDITIONS.map((c) => (
                                <SelectItem
                                  key={c.value}
                                  value={c.value}
                                >
                                  {c.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="val-gspaces-main"
                            className="text-[11px]"
                          >
                            Garage spaces
                          </Label>
                          <Input
                            id="val-gspaces-main"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={10}
                            value={details.garageSpaces}
                            onChange={(e) =>
                              updateDetail("garageSpaces", e.target.value)
                            }
                            placeholder="2"
                            className="h-9 text-[13px]"
                            data-testid="input-garage-spaces"
                          />
                        </div>
                      </div>

                      {/* Optional "more details" expander. These four extra
                          fields rarely move the estimate enough to justify
                          asking everyone for them — but a luxury buyer
                          rebuilding a known home wants to be precise, so we
                          let them open the panel. */}
                      <button
                        type="button"
                        onClick={() => setMoreDetailsOpen((v) => !v)}
                        className="mt-4 inline-flex items-center gap-1.5 text-[11px] tracking-wider text-muted-foreground hover:text-foreground"
                        data-testid="button-toggle-more-details"
                      >
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${moreDetailsOpen ? "rotate-180" : ""}`}
                          strokeWidth={1.6}
                        />
                        {moreDetailsOpen ? "Hide" : "More"} details (style,
                        basement, garage, AC, pool)
                      </button>

                      {moreDetailsOpen && (
                        <div
                          className="mt-3 space-y-3"
                          data-testid="more-details"
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="space-y-1.5">
                              <Label
                                htmlFor="val-style"
                                className="text-[11px]"
                              >
                                Style
                              </Label>
                              <Select
                                value={details.style}
                                onValueChange={(v) =>
                                  updateDetail("style", v)
                                }
                              >
                                <SelectTrigger
                                  id="val-style"
                                  className="h-9 text-[13px]"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {(isCondo
                                    ? STYLES_CONDO
                                    : STYLES_HOUSE
                                  ).map((s) => (
                                    <SelectItem key={s} value={s}>
                                      {s}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            {!isCondo && (
                              <div className="space-y-1.5">
                                <Label
                                  htmlFor="val-bsmt"
                                  className="text-[11px]"
                                >
                                  Basement
                                </Label>
                                <Select
                                  value={details.basement}
                                  onValueChange={(v) =>
                                    updateDetail("basement", v)
                                  }
                                >
                                  <SelectTrigger
                                    id="val-bsmt"
                                    className="h-9 text-[13px]"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {BASEMENTS.map((b) => (
                                      <SelectItem key={b} value={b}>
                                        {b}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            <div className="space-y-1.5">
                              <Label
                                htmlFor="val-ac"
                                className="text-[11px]"
                              >
                                AC
                              </Label>
                              <Select
                                value={details.ac}
                                onValueChange={(v) =>
                                  updateDetail("ac", v)
                                }
                              >
                                <SelectTrigger
                                  id="val-ac"
                                  className="h-9 text-[13px]"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ACS.map((a) => (
                                    <SelectItem key={a} value={a}>
                                      {a}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label
                                htmlFor="val-gtype"
                                className="text-[11px]"
                              >
                                Garage type
                              </Label>
                              <Select
                                value={details.garageType}
                                onValueChange={(v) =>
                                  updateDetail("garageType", v)
                                }
                              >
                                <SelectTrigger
                                  id="val-gtype"
                                  className="h-9 text-[13px]"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {GARAGES.map((g) => (
                                    <SelectItem key={g} value={g}>
                                      {g}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            {!isCondo && (
                              <div className="space-y-1.5">
                                <Label
                                  htmlFor="val-pool"
                                  className="text-[11px]"
                                >
                                  Pool
                                </Label>
                                <Select
                                  value={details.pool}
                                  onValueChange={(v) =>
                                    updateDetail("pool", v)
                                  }
                                >
                                  <SelectTrigger
                                    id="val-pool"
                                    className="h-9 text-[13px]"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {POOLS.map((p) => (
                                      <SelectItem key={p} value={p}>
                                        {p}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Optional purchase history — PDF §9.1 HPI-adjusted
                        anchor. When the homeowner knows when/what they
                        paid, this is the single biggest accuracy lever in
                        the entire form; Gnowise's response then comes back
                        source="HA". Collapsed by default so we don't
                        clutter the form for visitors who don't have this
                        data. */}
                    <div className="pt-2 border-t border-border">
                      <button
                        type="button"
                        onClick={() =>
                          setRecentPurchaseOpen((v) => !v)
                        }
                        className="inline-flex items-center gap-1.5 text-[11px] tracking-wider text-muted-foreground hover:text-foreground"
                        data-testid="button-toggle-recent-purchase"
                      >
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${recentPurchaseOpen ? "rotate-180" : ""}`}
                          strokeWidth={1.6}
                        />
                        Recent purchase{" "}
                        <span className="text-muted-foreground/70">
                          (if you bought in the last 10 years — biggest
                          accuracy boost)
                        </span>
                      </button>
                      {recentPurchaseOpen && (
                        <div
                          className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3"
                          data-testid="recent-purchase"
                        >
                          <div className="space-y-1.5">
                            <Label
                              htmlFor="val-histvalue"
                              className="text-[11px]"
                            >
                              What did you pay? ($)
                            </Label>
                            <Input
                              id="val-histvalue"
                              type="number"
                              inputMode="numeric"
                              min={0}
                              value={details.histValue}
                              onChange={(e) =>
                                updateDetail("histValue", e.target.value)
                              }
                              placeholder="1,400,000"
                              className="h-9 text-[13px]"
                              data-testid="input-hist-value"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor="val-histdate"
                              className="text-[11px]"
                            >
                              When did you buy?
                            </Label>
                            <Input
                              id="val-histdate"
                              type="date"
                              value={details.histValueDate}
                              onChange={(e) =>
                                updateDetail(
                                  "histValueDate",
                                  e.target.value,
                                )
                              }
                              max={`${CURRENT_YEAR}-12-31`}
                              min="1990-01-01"
                              className="h-9 text-[13px]"
                              data-testid="input-hist-date"
                            />
                          </div>
                          <p className="text-[11px] text-muted-foreground sm:col-span-2 leading-relaxed">
                            Gnowise anchors the AVM against this datapoint
                            and adjusts for the price index between then
                            and today. Far more accurate than the model
                            guessing in isolation.
                          </p>
                        </div>
                      )}
                    </div>

                    <Button
                      type="submit"
                      disabled={
                        valuation.isPending ||
                        address.trim().length < 6 ||
                        !details.roomsArea.trim()
                      }
                      className="w-full h-12 font-display text-[11px] tracking-[0.22em]"
                      data-testid="button-valuation-submit"
                    >
                      {valuation.isPending
                        ? "ESTIMATING…"
                        : "GET ESTIMATE & EMAIL REPORT"}
                    </Button>
                    {!details.roomsArea.trim() &&
                      address.trim().length >= 6 && (
                        <p className="text-[11px] text-muted-foreground text-center -mt-2">
                          Add the living square footage to enable the
                          estimate — it's the biggest accuracy lever.
                        </p>
                      )}

                    {latestFailure && (
                      <div className="border border-border bg-secondary/50 rounded-sm p-3 flex gap-2 items-start">
                        <AlertTriangle
                          className="w-4 h-4 mt-0.5 shrink-0 text-foreground/70"
                          strokeWidth={1.6}
                        />
                        <div className="flex-1 text-[13px] leading-relaxed">
                          <div className="font-medium">Couldn't run that one.</div>
                          <div className="text-muted-foreground mt-0.5">
                            {latestFailure}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              onSeedManualForm?.(address.trim(), aptNum.trim());
                              document
                                .getElementById("manual-evaluation")
                                ?.scrollIntoView({ behavior: "smooth" });
                            }}
                            className="mt-2 font-display text-[10px] tracking-[0.22em] underline hover:no-underline"
                          >
                            REQUEST A MANUAL ANALYSIS INSTEAD →
                          </button>
                        </div>
                      </div>
                    )}
                  </form>
                </>
              )}
            </div>

            {history.length > 0 && (
              <div
                className="bg-background/95 text-foreground rounded-sm border border-background/15 shadow-2xl divide-y divide-border"
                data-testid="valuation-history"
              >
                <div className="px-5 py-3 flex items-center justify-between">
                  <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                    YOUR ESTIMATES THIS SESSION
                  </div>
                  <button
                    type="button"
                    onClick={() => setHistory([])}
                    className="text-[11px] text-muted-foreground hover:text-foreground tracking-wider"
                    data-testid="button-history-clear"
                  >
                    Clear
                  </button>
                </div>
                {history.map((entry) => (
                  <HistoryRow
                    key={entry.id}
                    entry={entry}
                    refining={entry.refining}
                    onStartRefine={() => setEntryRefining(entry.id, true)}
                    onCancelRefine={() => setEntryRefining(entry.id, false)}
                    onSubmitRefine={(attrs) =>
                      refine.mutate({ entryId: entry.id, attrs })
                    }
                    refinePending={
                      refine.isPending &&
                      refine.variables?.entryId === entry.id
                    }
                    refineError={
                      refine.isError &&
                      refine.variables?.entryId === entry.id
                        ? (refine.error?.message ??
                          "Couldn't refine. Try again or request a hand-prepared analysis.")
                        : null
                    }
                    onRequestManual={() => {
                      onSeedManualForm?.(
                        entry.displayAddress,
                        entry.aptNum,
                      );
                      document
                        .getElementById("manual-evaluation")
                        ?.scrollIntoView({ behavior: "smooth" });
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- History row ----------------------------------------------------

interface HistoryRowProps {
  entry: HistoryEntry;
  refining: boolean;
  refinePending: boolean;
  refineError: string | null;
  onStartRefine: () => void;
  onCancelRefine: () => void;
  onSubmitRefine: (attrs: Partial<RefinementFormState>) => void;
  onRequestManual: () => void;
}

function HistoryRow({
  entry,
  refining,
  refinePending,
  refineError,
  onStartRefine,
  onCancelRefine,
  onSubmitRefine,
  onRequestManual,
}: HistoryRowProps) {
  const r = entry.result;
  const thin = needsRefinement(r);
  return (
    <div className="px-5 py-5">
      <div className="text-[13px] font-medium leading-tight truncate">
        {entry.displayAddress}
      </div>
      <div className="mt-2 flex items-baseline gap-3 flex-wrap">
        <div
          className="font-serif text-3xl"
          style={{ letterSpacing: "-0.01em" }}
        >
          {formatPrice(r.estimate!)}
        </div>
        {r.valueLow != null && r.valueHigh != null && (
          <div className="text-[12px] text-muted-foreground tabular-nums">
            {formatPriceCompact(r.valueLow)} – {formatPriceCompact(r.valueHigh)}
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
        {(r.parameters?.PropertyType ?? r.parameters?.property_type) && (
          <span>{r.parameters.PropertyType ?? r.parameters.property_type}</span>
        )}
        {(r.parameters?.Bedrooms ?? r.parameters?.bedrooms) != null && (
          <>
            <span>·</span>
            <span>{r.parameters.Bedrooms ?? r.parameters.bedrooms} bed</span>
          </>
        )}
        {(r.parameters?.Washrooms ??
          r.parameters?.Bathrooms ??
          r.parameters?.washrooms) != null && (
          <>
            <span>·</span>
            <span>
              {r.parameters.Washrooms ??
                r.parameters.Bathrooms ??
                r.parameters.washrooms}{" "}
              bath
            </span>
          </>
        )}
        {(r.parameters?.RoomsArea ?? r.parameters?.rooms_area) != null && (
          <>
            <span>·</span>
            <span>
              {(
                r.parameters.RoomsArea ?? r.parameters.rooms_area
              ).toLocaleString("en-CA")}{" "}
              sqft
            </span>
          </>
        )}
        {typeof r.confidence === "number" && (
          <>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              {r.confidence >= 0.8 ? (
                <Home className="w-3 h-3" strokeWidth={1.6} />
              ) : (
                <Building2 className="w-3 h-3" strokeWidth={1.6} />
              )}
              {r.confidence >= 0.8
                ? "High confidence"
                : r.confidence >= 0.5
                  ? "Moderate confidence"
                  : "Lower confidence"}
            </span>
          </>
        )}
      </div>
      {(typeof r.estimatedLease === "number" ||
        typeof r.capRate === "number") && (
        <div className="mt-3 flex gap-4 flex-wrap text-[11px]">
          {typeof r.estimatedLease === "number" && (
            <div className="inline-flex items-center gap-1.5">
              <span className="font-display tracking-[0.18em] text-muted-foreground uppercase">
                Rent est
              </span>
              <span className="tabular-nums">
                {formatPriceCompact(r.estimatedLease)}/mo
              </span>
            </div>
          )}
          {typeof r.capRate === "number" && (
            <div className="inline-flex items-center gap-1.5">
              <span className="font-display tracking-[0.18em] text-muted-foreground uppercase">
                Cap rate
              </span>
              <span className="tabular-nums">
                {(r.capRate * 100).toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* Refinement: banner OR expanded form */}
      {thin && !refining && (
        <div className="mt-4 border border-border bg-secondary/40 rounded-sm p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              className="w-4 h-4 mt-0.5 shrink-0 text-foreground/70"
              strokeWidth={1.6}
            />
            <div className="flex-1">
              <div className="text-[13px] font-medium leading-tight">
                Limited data on this address.
              </div>
              <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
                The model couldn't find a complete record — add a few details
                and the estimate sharpens instantly.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={onStartRefine}
                className="mt-3 font-display text-[10px] tracking-[0.22em]"
                data-testid="button-start-refine"
              >
                <Wand2 className="w-3 h-3 mr-1.5" strokeWidth={1.8} />
                ADD PROPERTY DETAILS
              </Button>
            </div>
          </div>
        </div>
      )}

      {refining && (
        <RefinementForm
          entry={entry}
          pending={refinePending}
          error={refineError}
          onCancel={onCancelRefine}
          onSubmit={onSubmitRefine}
        />
      )}

      <div className="mt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRequestManual}
          className="font-display text-[10px] tracking-[0.22em]"
        >
          REQUEST HAND-PREPARED ANALYSIS →
        </Button>
      </div>
    </div>
  );
}

// ---------- Refinement form ------------------------------------------------

function RefinementForm({
  entry,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  entry: HistoryEntry;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (attrs: Partial<RefinementFormState>) => void;
}) {
  const [form, setForm] = useState<RefinementFormState>(() =>
    refinementDefaults(entry.isCondo),
  );

  const update = <K extends keyof RefinementFormState>(
    key: K,
    value: RefinementFormState[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  // For luxury Calgary detached homes the sqft + beds + baths + age fields
  // do the heavy lifting; everything else is fine on its defaults. We
  // require sqft because that's the single biggest accuracy lever per
  // Amir at Gnowise — without it the model is back to valuing a near-empty
  // record.
  const canSubmit = !pending && form.roomsArea.trim().length > 0;

  const isCondo = entry.isCondo;
  const styleOptions = isCondo ? STYLES_CONDO : STYLES_HOUSE;
  const propertyTypeOptions = isCondo
    ? PROPERTY_TYPES_CONDO
    : PROPERTY_TYPES_HOUSE;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit(form);
      }}
      className="mt-4 border border-foreground/15 bg-secondary/30 rounded-sm p-4 lg:p-5 space-y-4"
      data-testid="refinement-form"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
            REFINE FOR ACCURACY
          </div>
          <h4 className="font-serif text-lg mt-1 leading-tight">
            Tell us about your home
          </h4>
          <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
            Square footage matters most. Everything else helps if you know it
            — leave defaults otherwise.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-muted-foreground hover:text-foreground tracking-wider shrink-0"
        >
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`pt-${entry.id}`} className="text-[11px]">
            Property type
          </Label>
          <Select
            value={form.propertyType}
            onValueChange={(v) => update("propertyType", v)}
          >
            <SelectTrigger id={`pt-${entry.id}`} className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {propertyTypeOptions.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`st-${entry.id}`} className="text-[11px]">
            Building style
          </Label>
          <Select
            value={form.style}
            onValueChange={(v) => update("style", v)}
          >
            <SelectTrigger id={`st-${entry.id}`} className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {styleOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`bd-${entry.id}`} className="text-[11px]">
            Bedrooms
          </Label>
          <Input
            id={`bd-${entry.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            value={form.bedrooms}
            onChange={(e) => update("bedrooms", e.target.value)}
            placeholder="4"
            className="h-9 text-[13px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ba-${entry.id}`} className="text-[11px]">
            Bathrooms
          </Label>
          <Input
            id={`ba-${entry.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            value={form.washrooms}
            onChange={(e) => update("washrooms", e.target.value)}
            placeholder="4"
            className="h-9 text-[13px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`sf-${entry.id}`} className="text-[11px]">
            Living sqft *
          </Label>
          <Input
            id={`sf-${entry.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            value={form.roomsArea}
            onChange={(e) => update("roomsArea", e.target.value)}
            placeholder="3,500"
            className="h-9 text-[13px]"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`lt-${entry.id}`} className="text-[11px]">
            Lot sqft
          </Label>
          <Input
            id={`lt-${entry.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            value={form.lotArea}
            onChange={(e) => update("lotArea", e.target.value)}
            placeholder="7,500"
            className="h-9 text-[13px]"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`yr-${entry.id}`} className="text-[11px]">
            Year built
          </Label>
          <Input
            id={`yr-${entry.id}`}
            type="number"
            inputMode="numeric"
            min={1850}
            max={CURRENT_YEAR + 5}
            value={form.yearBuilt}
            onChange={(e) => update("yearBuilt", e.target.value)}
            placeholder={String(CURRENT_YEAR - 8)}
            className="h-9 text-[13px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`co-${entry.id}`} className="text-[11px]">
            Condition
          </Label>
          <Select
            value={form.condition}
            onValueChange={(v) => update("condition", v)}
          >
            <SelectTrigger id={`co-${entry.id}`} className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!isCondo && (
          <div className="space-y-1.5">
            <Label htmlFor={`bs-${entry.id}`} className="text-[11px]">
              Basement
            </Label>
            <Select
              value={form.basement}
              onValueChange={(v) => update("basement", v)}
            >
              <SelectTrigger id={`bs-${entry.id}`} className="h-9 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASEMENTS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`gt-${entry.id}`} className="text-[11px]">
            Garage type
          </Label>
          <Select
            value={form.garageType}
            onValueChange={(v) => update("garageType", v)}
          >
            <SelectTrigger id={`gt-${entry.id}`} className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GARAGES.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`gs-${entry.id}`} className="text-[11px]">
            Garage spaces
          </Label>
          <Input
            id={`gs-${entry.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            max={10}
            value={form.garageSpaces}
            onChange={(e) => update("garageSpaces", e.target.value)}
            placeholder="3"
            className="h-9 text-[13px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ac-${entry.id}`} className="text-[11px]">
            AC
          </Label>
          <Select value={form.ac} onValueChange={(v) => update("ac", v)}>
            <SelectTrigger id={`ac-${entry.id}`} className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!isCondo && (
        <div className="space-y-1.5 max-w-[200px]">
          <Label htmlFor={`pl-${entry.id}`} className="text-[11px]">
            Pool
          </Label>
          <Select value={form.pool} onValueChange={(v) => update("pool", v)}>
            <SelectTrigger id={`pl-${entry.id}`} className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POOLS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {error && (
        <div className="text-[12px] text-destructive leading-relaxed">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="submit"
          disabled={!canSubmit}
          className="h-10 px-5 font-display text-[10px] tracking-[0.22em]"
          data-testid="button-submit-refine"
        >
          {pending ? "RECALCULATING…" : "RECALCULATE ESTIMATE"}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        {!form.roomsArea.trim() && (
          <span className="text-[11px] text-muted-foreground">
            * Living sqft is required.
          </span>
        )}
      </div>
    </form>
  );
}
