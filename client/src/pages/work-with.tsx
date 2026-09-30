// Audience-segment landing pages ("Who we work with"). One data-driven
// template renders all eight avatars from the home page grid, each with its
// own SEO head (FAQ + breadcrumb schema), value props, process steps, related
// links, and contact CTA. Routes: /work-with (index) and /work-with/:slug.
import { Link, useRoute } from "wouter";
import {
  ArrowRight,
  Briefcase,
  Building2,
  Camera,
  Clock,
  Compass,
  FileText,
  GraduationCap,
  Heart,
  Home,
  KeyRound,
  LineChart,
  Mail,
  MapPin,
  Phone,
  Scale,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { SeoHead } from "@/components/seo-head";
import { FaqAccordion } from "@/components/faq-accordion";
import { Button } from "@/components/ui/button";
import NotFound from "@/pages/not-found";
import {
  SPENCER_PHONE,
  SPENCER_PHONE_HREF,
  SPENCER_EMAIL,
  SPENCER_EMAIL_HREF,
} from "@/lib/format";

const SITE_ORIGIN = "https://riversrealestate.ca";

interface SegmentPoint {
  icon: LucideIcon;
  title: string;
  body: string;
}

interface SegmentStep {
  title: string;
  body: string;
}

interface SegmentLink {
  title: string;
  desc: string;
  href: string;
}

export interface AudienceSegment {
  slug: string;
  icon: LucideIcon;
  title: string;
  card: string; // short blurb used on index cards
  headline: [string, string]; // [plain lead, emphasized tail]
  intro: string;
  image: string;
  imageAlt: string;
  /** "badge" = square emblem artwork: render uncropped on white instead of
   *  the 4:5 object-cover photo treatment. */
  imageStyle?: "badge";
  points: SegmentPoint[];
  /** Overrides the generic "What working together looks like." H2. Set it
   *  when the segment's own nouns (service, market, property type) make a
   *  more specific heading — answer engines cite headings. */
  pointsHeading?: string;
  steps: SegmentStep[];
  /** Overrides the generic "Three steps, no guesswork." H2. Same reasoning. */
  stepsHeading?: string;
  links: SegmentLink[];
  faq: Array<{ q: string; a: string }>;
  seoTitle: string;
  seoDescription: string;
}

export const AUDIENCE_SEGMENTS: AudienceSegment[] = [
  {
    slug: "luxury-properties",
    icon: Sparkles,
    title: "Luxury Properties",
    card: "Calgary's finest estates, penthouses, and villas. Private showings, off-market access, and expert negotiation for $1M+ buyers.",
    headline: ["The $1M+ market,", "handled properly."],
    intro:
      "Calgary's luxury tier is a small market where the best properties often trade quietly. Spencer Rivers — CLHMS, Million Dollar Guild — works it daily across Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire, pairing serious buyers with estates, penthouses, and villas that fit how they actually live.",
    image:
      "/img/work-with/luxury-properties.jpg",
    imageAlt: "Modern Calgary luxury estate at dusk — a Rivers Real Estate sale at 102 Malibou Road SW",
    points: [
      {
        icon: KeyRound,
        title: "Off-market access",
        body: "Some of the best homes in Aspen Woods and Mount Royal never hit the public MLS. Spencer maintains a private network of estate sellers and developers whose properties move through introductions, not listings.",
      },
      {
        icon: Scale,
        title: "Negotiation that pays for itself",
        body: "As a Certified Negotiation Expert, Spencer builds every offer on comparable sales, absorption rates, and days-on-market data — then negotiates from evidence, not emotion.",
      },
      {
        icon: ShieldCheck,
        title: "Discretion as standard",
        body: "Private showings on your schedule, confidential terms, and no public footprint until you want one. High-profile clients get the same process every time: quiet, documented, and clean.",
      },
    ],
    steps: [
      {
        title: "A real brief, not a wish list",
        body: "One conversation to define the communities, architecture, lot, and privacy requirements that matter — and the deal-breakers that disqualify a property before you waste a Saturday on it.",
      },
      {
        title: "The full market, including the quiet part",
        body: "MLS inventory plus off-market and pre-market opportunities from Spencer's private network, screened against your brief before anything reaches your inbox.",
      },
      {
        title: "Offer, diligence, and close",
        body: "Comparable-sales analysis, inspection and condition strategy, and negotiation through possession day — with the math written down at every step.",
      },
    ],
    links: [
      {
        title: "Browse $1.5M+ listings",
        desc: "Current luxury inventory across Calgary.",
        href: "/mls?minPrice=1500000",
      },
      {
        title: "Luxury neighbourhoods",
        desc: "Springbank Hill, Aspen Woods, Mount Royal, and more.",
        href: "/neighbourhoods",
      },
      {
        title: "Luxury condos & penthouses",
        desc: "Calgary's premier buildings, building by building.",
        href: "/condos",
      },
    ],
    faq: [
      {
        q: "How do I see homes that aren't on the MLS?",
        a: "Work with an agent who has access to them. Spencer maintains relationships with estate owners, builders, and other luxury agents across Calgary, and a meaningful share of his transactions start as private introductions rather than public listings.",
      },
      {
        q: "What does buyer representation cost me?",
        a: "In most Calgary transactions the buyer's agent is compensated from the transaction itself, so professional representation typically costs the buyer nothing out of pocket. Spencer confirms compensation in writing before you view a single property.",
      },
      {
        q: "Which Calgary neighbourhoods hold value best at the $1M+ level?",
        a: "Established communities with scarce land — Upper Mount Royal, Elbow Park, Britannia, Bel-Aire — have the longest track records. Springbank Hill and Aspen Woods lead the west side for newer estate product. The right answer depends on whether you value land, architecture, or walkability most.",
      },
      {
        q: "How long does a luxury purchase usually take?",
        a: "Anywhere from two weeks to a year. Inventory above $1M is thin, so the search is driven by fit rather than urgency. Spencer's average client views far fewer homes than the market norm because the screening happens before the showing.",
      },
    ],
    seoTitle: "Luxury Home Buyers | Calgary Estates, Penthouses & Villas | Spencer Rivers",
    seoDescription:
      "Buy in Calgary's $1M+ market with Spencer Rivers, CLHMS. Private showings, off-market access, and data-driven negotiation across Springbank Hill, Aspen Woods, Mount Royal, and more.",
  },
  {
    slug: "first-time-home-sellers",
    icon: Home,
    title: "First-Time Home Sellers",
    card: "Sell your first home with confidence. Pricing, timing, prep, and every form — so nothing gets missed.",
    headline: ["Your first sale,", "done right the first time."],
    intro:
      "Selling a home you've never sold before means pricing, timing, staging, conditions, and paperwork all landing at once. Spencer Rivers walks first-time sellers through every step with the same process he runs on million-dollar estates — the math on paper, the prep scheduled, and no form left to chance.",
    image:
      "/img/work-with/first-time-home-sellers.jpg",
    imageAlt: "Established residential street of well-kept family homes",
    points: [
      {
        icon: LineChart,
        title: "Pricing from evidence",
        body: "Comparable sales, current competition, and absorption rates — written down so you can see the math. Overpricing costs sellers more than any commission ever will; no one pays full price for a stale donut.",
      },
      {
        icon: Camera,
        title: "Prep and presentation",
        body: "A room-by-room prep plan, professional photography, and listing copy that shows buyers what's actually there. Small, targeted improvements routinely return multiples of their cost.",
      },
      {
        icon: FileText,
        title: "Every form, explained",
        body: "Listing agreements, disclosures, condition waivers, closing documents — Spencer walks you through each one in plain language before you sign anything.",
      },
    ],
    steps: [
      {
        title: "Evaluation and strategy",
        body: "A no-obligation home evaluation, a written pricing recommendation, and a launch timeline built around your move — not the other way around.",
      },
      {
        title: "Prep, photography, launch",
        body: "The home gets prepped, photographed, and marketed to the full buyer pool. You get a showing schedule that respects the fact that you still live there.",
      },
      {
        title: "Offers to possession day",
        body: "Every offer reviewed together, conditions and timelines negotiated, and each document handled through to keys and funds changing hands.",
      },
    ],
    links: [
      {
        title: "Free home evaluation",
        desc: "Find out what your home is worth today.",
        href: "/home-evaluation",
      },
      {
        title: "Talk it through first",
        desc: "A 15-minute call answers most first-seller questions.",
        href: "/contact",
      },
      {
        title: "Selling advice on the blog",
        desc: "Pricing, timing, and prep guides for Calgary sellers.",
        href: "/blog",
      },
    ],
    faq: [
      {
        q: "What does it cost to sell my home?",
        a: "Plan for real estate commission, legal fees (roughly $1,200–$2,000), and any mortgage payout penalty your lender charges. Spencer provides a written net-proceeds estimate before you list, so the number on possession day isn't a surprise.",
      },
      {
        q: "How should I price my first listing?",
        a: "From the evidence: recent comparable sales, active competition, and how fast homes like yours are absorbing. Pricing high 'to leave room to negotiate' is the most expensive mistake first-time sellers make — buyers simply skip the showing, and the listing goes stale.",
      },
      {
        q: "Do I need to renovate before selling?",
        a: "Rarely. Paint, lighting, decluttering, and professional photography move the needle far more per dollar than a renovation started for the sale. Spencer walks the home with you and flags only the fixes that actually return money.",
      },
      {
        q: "How long will it take to sell?",
        a: "In Calgary, well-priced homes typically sell within the first few weeks, and the strongest offers usually arrive early. If a listing sits past the neighbourhood's average days-on-market, that's data — and Spencer will tell you what it's saying.",
      },
    ],
    seoTitle: "First-Time Home Sellers in Calgary | Spencer Rivers, Rivers Real Estate",
    seoDescription:
      "Selling your first home in Calgary? Spencer Rivers handles pricing, prep, marketing, and every form — with a written plan and a net-proceeds estimate before you list.",
  },
  {
    slug: "expired-listings",
    icon: Clock,
    title: "Expired & Frustrated Sellers",
    card: "Expired, terminated, or stalled. Spencer Rivers diagnoses the list price, the photography, and the exposure — then re-prices, re-markets, and relists the home.",
    headline: ["Expired Calgary listings,", "relisted and sold."],
    intro:
      "Your home did not sell, and the Calgary market is not the reason. Spencer Rivers is a CLHMS luxury listing agent with Rivers Real Estate at Synterra Realty who relists expired, terminated, and stalled homes across Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire in Calgary, Alberta. Every relist opens with a written post-mortem — what the list price, the photography, and the exposure actually did — before Spencer Rivers re-prices, re-markets, and relists the property on Calgary MLS®.",
    image: "/img/work-with/luxury-properties.jpg",
    imageAlt:
      "Luxury home in Calgary, Alberta photographed at dusk for Rivers Real Estate — the presentation standard Spencer Rivers relists expired listings with",
    pointsHeading: "How Spencer Rivers relists a Calgary luxury home.",
    points: [
      {
        icon: LineChart,
        title: "A written post-mortem before the relist",
        body: "Spencer Rivers reviews the showing count, the written buyer feedback, the days on market, and the Calgary comparables that closed while the home sat. Showings without offers point to list price. No showings point to exposure or photography. A listing agent who guesses between the two costs the seller a second failed listing.",
      },
      {
        icon: Camera,
        title: "Photography, floor plans, and remarks rebuilt",
        body: "New professional photography, new floor plans, new listing remarks, and a room-by-room staging list. Luxury buyers above $1M shortlist Calgary listings from a phone screen, and a gallery that worked in spring reads as stale by fall. Spencer Rivers recycles nothing from the failed launch.",
      },
      {
        icon: Users,
        title: "The Calgary buyers who never saw it",
        body: "Pillar 9 MLS® is the floor, not the marketing plan. Spencer Rivers relaunches expired listings through paid distribution, the Calgary luxury agent network, and a private buyer list built across $100M+ in career sales — because the buyer who passed on the listing often never saw the home at all.",
      },
    ],
    stepsHeading: "From expired listing to sold, in three steps.",
    steps: [
      {
        title: "The post-mortem — no listing pitch",
        body: "One meeting at the home. Spencer Rivers pulls the showing history, the buyer feedback, and the Calgary sales that closed nearby, then explains what failed. Sellers keep that assessment whether or not they ever list with Rivers Real Estate.",
      },
      {
        title: "A written relist plan, with the math on it",
        body: "List price, prep, photography, timing, and marketing spend in one document — the target luxury buyer, the closed comparables the price is built on, and a net-proceeds estimate before a seller signs a listing agreement.",
      },
      {
        title: "Relist, market, and report every week",
        body: "Spencer Rivers relists the home on Calgary MLS®, markets it through paid and private channels, and reports showings, traffic, and feedback weekly — with a scheduled decision point if the Calgary market says something unexpected.",
      },
    ],
    links: [
      {
        title: "What is your Calgary home worth now?",
        desc: "A no-obligation home evaluation built on closed comparables.",
        href: "/home-evaluation",
      },
      {
        title: "Spencer Rivers' track record",
        desc: "CLHMS credentials, career sales, and how he markets luxury homes.",
        href: "/about",
      },
      {
        title: "Calgary neighbourhood data",
        desc: "Prices, inventory, and days on market by community.",
        href: "/neighbourhoods",
      },
    ],
    faq: [
      {
        q: "Why didn't my Calgary luxury home sell?",
        a: "Above $1M in Calgary, an expired listing almost always traces to one of three causes — a list price built on the wrong comparables, photography that fails on a phone screen, or exposure that never reached the luxury buyer pool — and usually two at once. Days on market then compound the problem: buyers read a long listing history as permission to wait, and no one pays full price for a stale donut. Spencer Rivers identifies which of the three failed before recommending a new list price.",
      },
      {
        q: "My Calgary home is still listed with another brokerage — can we talk?",
        a: "About strategy, yes. This is not an invitation to break a listing agreement. While a home is listed with another brokerage, the right first conversation is with the current listing agent — bring them the showing data and ask for a written marketing plan. When the listing expires or the brokerage cancels it, Spencer Rivers is available, and the post-mortem is free either way.",
      },
      {
        q: "Can I switch REALTORS® before my listing agreement ends?",
        a: "A listing agreement in Alberta is held by the brokerage rather than the individual REALTOR®, and it runs to a fixed expiry date. Ending it early requires the brokerage to agree to a cancellation in writing. Read the agreement for the expiry date and the holdover clause, which can still entitle the brokerage to commission on a buyer it introduced. Spencer Rivers reads Calgary listing agreements with sellers at no charge.",
      },
      {
        q: "Does relisting reset days on market in Calgary?",
        a: "A relist creates a new MLS® number and a fresh days-on-market count on Pillar 9, but the previous listing stays in the property history every Calgary REALTOR® can pull. Relisting to hide days on market does not work. Relisting with a corrected list price and rebuilt photography does — which is why the relist is the last step, not the first.",
      },
      {
        q: "How much should I cut the price on an expired listing?",
        a: "Possibly nothing. When photography, floor plans, and exposure caused the failure, a price reduction pays for a marketing mistake. Spencer Rivers reads what the Calgary market actually signalled, puts a number on it, and shows the closed comparables behind it. When a real reduction is the answer, the seller sees why on paper.",
      },
      {
        q: "How long should a luxury home take to sell in Calgary?",
        a: "Longer than the rest of the Calgary market, and that is normal — the buyer pool above $1M is small, so a correctly priced estate in Springbank Hill, Aspen Woods, or Upper Mount Royal can take months without anything being wrong. The signal is traffic, not the calendar. Steady showings without offers indicate list price. No showings indicate marketing. Spencer Rivers diagnoses either one before the listing term expires.",
      },
    ],
    seoTitle: "Expired Listings in Calgary | Relist Your Luxury Home | Spencer Rivers",
    seoDescription:
      "Expired Calgary luxury listing? Spencer Rivers, CLHMS listing agent, diagnoses list price, photography, and exposure — then re-prices, re-markets, and relists.",
  },
  {
    slug: "empty-nesters",
    icon: Heart,
    title: "Empty Nesters",
    card: "Right-size without compromise. Downsize into a luxury condo, lock-and-leave bungalow, or curated build — without losing equity in the move.",
    headline: ["Downsizing in Calgary:", "right-size without compromise."],
    intro:
      "The family home did its job. The next chapter should be simpler — a luxury condo with a concierge, a lock-and-leave bungalow, or a curated build closer to the grandkids — without giving up the quality you're used to or the equity you've built. Spencer Rivers, a Certified Condo Specialist, coordinates both sides of the move.",
    image: "/img/work-with/empty-nesters.jpg",
    imageAlt:
      "Empty Nesters — a couple enjoying sunset coffee overlooking the water",
    imageStyle: "badge",
    points: [
      {
        icon: Building2,
        title: "Condo diligence, done properly",
        body: "Reserve fund studies, condo documents, special assessments — as a Certified Condo Specialist, Spencer reads them all before you commit, so the building's finances are as sound as the suite.",
      },
      {
        icon: Clock,
        title: "One move, sequenced",
        body: "Sell the family home and buy the next one without carrying two properties or moving twice. Possession dates, bridge financing, and conditions are coordinated as one plan.",
      },
      {
        icon: TrendingUp,
        title: "Equity protected",
        body: "Decades of equity deserve a data-driven sale. Spencer prices the family home from comparable sales and negotiates the purchase side just as hard, so the downsize adds to your retirement math instead of subtracting from it.",
      },
    ],
    steps: [
      {
        title: "Define the next chapter",
        body: "Condo, villa, bungalow, or build — one conversation about maintenance, travel, family, and budget narrows Calgary's options to a shortlist that actually fits.",
      },
      {
        title: "Sell and buy as one plan",
        body: "The family home is prepped, priced, and listed while the search runs in parallel. Timelines are negotiated so you move once, on your schedule.",
      },
      {
        title: "Settle in",
        body: "From condo document review to possession-day logistics, everything is handled through to the day the boxes arrive at the new address.",
      },
    ],
    links: [
      {
        title: "Luxury condos & villas",
        desc: "Calgary's best lock-and-leave buildings.",
        href: "/condos",
      },
      {
        title: "What's the family home worth?",
        desc: "A free, data-driven evaluation is the starting point.",
        href: "/home-evaluation",
      },
      {
        title: "Explore neighbourhoods",
        desc: "Walkable, quieter, or closer to family — compare areas.",
        href: "/neighbourhoods",
      },
    ],
    faq: [
      {
        q: "Should I sell my house before buying the condo?",
        a: "Usually, yes — selling first tells you exactly what you have to spend and makes your purchase offer stronger. Spencer sequences the two transactions with negotiated possession dates so 'sell first' doesn't mean moving twice.",
      },
      {
        q: "What should I look for in a condo's documents?",
        a: "The reserve fund study, recent board minutes, and any special assessments. A beautiful suite in a poorly funded building is an expensive mistake. Spencer reviews the full document package on every condo his clients buy.",
      },
      {
        q: "What are my downsizing options besides a high-rise condo?",
        a: "Calgary has strong lock-and-leave villa and bungalow product — attached and detached — plus boutique low-rise buildings in communities like Britannia and Elbow Park. If nothing on the market fits, a curated build is on the table too.",
      },
      {
        q: "Will downsizing actually free up money?",
        a: "It should, and the math deserves to be done before you list. Spencer prepares a written net-proceeds estimate on the sale and realistic carrying costs on the purchase — condo fees included — so you see the full picture first.",
      },
    ],
    seoTitle: "Downsizing & Empty Nesters in Calgary | Spencer Rivers, Rivers Real Estate",
    seoDescription:
      "Right-size without compromise. Spencer Rivers, Certified Condo Specialist, coordinates the sale of the family home and the move into a luxury condo, villa, or bungalow — one plan, one move.",
  },
  {
    slug: "first-time-home-buyers",
    icon: Compass,
    title: "First-Time Home Buyers",
    card: "Buy smart, not fast. Coaching through financing, inspections, and the Calgary submarkets where your budget goes furthest.",
    headline: ["Buy smart,", "not fast."],
    intro:
      "Your first purchase sets up every move that follows, so it deserves more than a weekend of open houses. Spencer Rivers coaches first-time buyers through financing, inspections, and Calgary's submarkets with the same discipline he brings to the luxury tier — data first, pressure never.",
    image: "/img/work-with/first-time-home-buyers.jpg",
    imageAlt:
      "First Time Buyers — a couple with keys in front of their new home",
    imageStyle: "badge",
    points: [
      {
        icon: LineChart,
        title: "Where your budget goes furthest",
        body: "Calgary is dozens of submarkets, not one market. Spencer maps your budget against the communities with the best value trajectory, so your first home is also a sound first investment.",
      },
      {
        icon: ShieldCheck,
        title: "Inspections without shortcuts",
        body: "Foundation, roof, mechanical, and the paper trail behind them. Spencer treats conditions as protection, not paperwork — and will tell you plainly when a house isn't worth the risk.",
      },
      {
        icon: FileText,
        title: "Financing, decoded",
        body: "Pre-approval, deposit, down payment, closing costs — the full cash picture in plain language before you write an offer, with introductions to mortgage professionals who answer their phones.",
      },
    ],
    steps: [
      {
        title: "Education before house hunting",
        body: "One session covering the full buying process, the real costs beyond the down payment, and a pre-approval plan — so you shop with confidence instead of guesswork.",
      },
      {
        title: "A focused search",
        body: "A shortlist of communities matched to your budget and life, with listings screened before you spend an evening driving to them.",
      },
      {
        title: "Offer to keys",
        body: "Offer strategy from comparable sales, inspection and financing conditions handled properly, and every document explained through to possession day.",
      },
    ],
    links: [
      {
        title: "Search Calgary listings",
        desc: "Every MLS listing, updated continuously.",
        href: "/mls",
      },
      {
        title: "Compare neighbourhoods",
        desc: "Find the submarkets that fit your budget and life.",
        href: "/neighbourhoods",
      },
      {
        title: "Ask a question",
        desc: "No pitch — just answers about the process.",
        href: "/contact",
      },
    ],
    faq: [
      {
        q: "How much do I actually need to buy my first home in Calgary?",
        a: "Beyond the down payment (5% minimum on the first $500,000), budget for legal fees, a home inspection, title costs, and moving — typically $3,000–$6,000 in closing costs. Spencer prepares the full cash-to-close picture before you start viewing homes.",
      },
      {
        q: "Do I need a pre-approval before looking at homes?",
        a: "Yes. A pre-approval defines your real budget, locks a rate while you shop, and makes your offer credible to sellers. It costs nothing, and Spencer can connect you with mortgage professionals who turn them around quickly.",
      },
      {
        q: "What does a buyer's agent cost a first-time buyer?",
        a: "In most Calgary transactions, nothing out of pocket — the buyer's agent is compensated through the transaction. You get representation, negotiation, and paperwork handled at no direct cost, and Spencer confirms the details in writing up front.",
      },
      {
        q: "Should I wait for prices or rates to drop?",
        a: "Timing the market is a coin flip; time in the market is math. The better question is whether your income, down payment, and five-year plan support buying now. Spencer will run that math with you honestly — including when the answer is 'wait.'",
      },
    ],
    seoTitle: "First-Time Home Buyers in Calgary | Spencer Rivers, Rivers Real Estate",
    seoDescription:
      "Buy your first Calgary home with a coach, not a salesperson. Spencer Rivers guides financing, inspections, and neighbourhood choice — data first, pressure never.",
  },
  {
    slug: "innercity-properties",
    icon: Building2,
    title: "Innercity Properties",
    card: "Upper Mount Royal, Elbow Park, Roxboro, Mission, Beltline — Calgary's most walkable luxury submarkets.",
    headline: ["Calgary's inner city,", "block by block."],
    intro:
      "Upper Mount Royal, Elbow Park, Roxboro, Mission, Beltline — Calgary's inner city is where century-old estates, rebuilt infills, and full-floor condos share the same postal codes. Values here move block by block, and Spencer Rivers knows which blocks. This is the market he works every day.",
    image:
      "/img/neighbourhoods/upper-mount-royal.jpg",
    imageAlt: "Inner-city Calgary rooftops with the downtown skyline at sunset",
    points: [
      {
        icon: MapPin,
        title: "Block-level knowledge",
        body: "The same floor plan can trade $200K apart depending on the street, the slope, and the neighbour's setback. Spencer prices inner-city property at the block level, because that's where the market actually lives.",
      },
      {
        icon: Home,
        title: "Character homes and infills, both",
        body: "A 1912 Mount Royal estate and a new Roxboro infill are different purchases with different risks — heritage considerations, lot value, build quality. Spencer has transacted both, repeatedly.",
      },
      {
        icon: KeyRound,
        title: "The quiet inventory",
        body: "Inner-city Calgary's best properties often sell before they list. Spencer's network of owners, builders, and agents in these communities surfaces opportunities the portals never show.",
      },
    ],
    steps: [
      {
        title: "Pick your pocket",
        body: "Walkability, schools, lot size, river access — each inner-city community trades one for another. Spencer helps you rank them and narrows the search to the streets that fit.",
      },
      {
        title: "Screen the real inventory",
        body: "MLS listings plus off-market opportunities, each assessed on land value, structure, and resale trajectory before you view it.",
      },
      {
        title: "Buy or sell on evidence",
        body: "Block-level comparables and negotiation grounded in what actually closed — not what the listing next door is asking.",
      },
    ],
    links: [
      {
        title: "Upper Mount Royal",
        desc: "Calgary's most established estate community.",
        href: "/neighbourhoods/upper-mount-royal",
      },
      {
        title: "Elbow Park",
        desc: "River pathways and century homes.",
        href: "/neighbourhoods/elbow-park",
      },
      {
        title: "All neighbourhoods",
        desc: "Compare every community Spencer covers.",
        href: "/neighbourhoods",
      },
    ],
    faq: [
      {
        q: "Which inner-city Calgary neighbourhoods are best for luxury buyers?",
        a: "Upper Mount Royal, Elbow Park, and Roxboro lead for estates and land value; Mission and Beltline lead for walkable condo and townhome living. Each trades character, lot size, and convenience differently — the right one depends on how you live.",
      },
      {
        q: "Is buying a character home riskier than a new infill?",
        a: "It's a different risk, not necessarily a bigger one. Older homes need diligence on foundations, mechanical, and insurance; infills need diligence on builder quality and lot economics. Spencer runs the appropriate checklist for each.",
      },
      {
        q: "Why do prices vary so much within the same neighbourhood?",
        a: "Land. A quiet crescent, a ridge lot, or a south-facing backyard can move value dramatically within a few hundred metres. That's why Spencer comps at the block level rather than trusting neighbourhood averages.",
      },
      {
        q: "Do inner-city properties hold value better than the suburbs?",
        a: "Historically, established inner-city communities with scarce land — Mount Royal, Elbow Park, Britannia — have shown the most durable values in Calgary. Scarcity does the work: they aren't making more land beside the Elbow River.",
      },
    ],
    seoTitle: "Inner-City Calgary Real Estate | Mount Royal, Elbow Park, Mission | Spencer Rivers",
    seoDescription:
      "Buy or sell in Calgary's inner city with Spencer Rivers. Block-level expertise across Upper Mount Royal, Elbow Park, Roxboro, Mission, and Beltline — estates, infills, and condos.",
  },
  {
    slug: "move-ups",
    icon: TrendingUp,
    title: "Move-Ups",
    card: "Trading up to your forever home? We coordinate the sell-and-buy sequence so you're not stuck between two mortgages.",
    headline: ["Trade up", "without the tightrope."],
    intro:
      "The move-up is the hardest transaction in real estate: two deals, two sets of dates, and your equity in transit between them. Spencer Rivers coordinates the sell-and-buy sequence — pricing, conditions, bridge financing, possession dates — so you land in the forever home without ever carrying two mortgages you didn't plan for.",
    image:
      "/img/work-with/move-ups.jpg",
    imageAlt: "Craftsman estate home on an acreage — a Rivers Real Estate sale at 43 Red Willow Crescent",
    points: [
      {
        icon: Clock,
        title: "Sequencing is the strategy",
        body: "Sell-then-buy or buy-then-sell is a math problem — your equity position, the pace of your target market, and your risk tolerance. Spencer runs the numbers both ways and builds the timeline around the answer.",
      },
      {
        icon: LineChart,
        title: "Two negotiations, one plan",
        body: "Maximizing the sale and winning the purchase are negotiated together: possession dates, conditions, and deposits structured so each deal protects the other.",
      },
      {
        icon: ShieldCheck,
        title: "Bridges and back-up plans",
        body: "Bridge financing, condition timing, and contingency plans are arranged before they're needed — so a delayed closing is an inconvenience, not a crisis.",
      },
    ],
    steps: [
      {
        title: "Know both numbers",
        body: "A data-driven evaluation of your current home and a realistic budget for the next one — including the equity, penalties, and carrying costs in between.",
      },
      {
        title: "Launch in the right order",
        body: "Your sale and search run on a coordinated timeline, with conditions and possession dates negotiated to close the gap between the two deals.",
      },
      {
        title: "One moving day",
        body: "Both transactions close on a schedule you chose, your equity moves directly into the new home, and you move once.",
      },
    ],
    links: [
      {
        title: "What's your current home worth?",
        desc: "The move-up plan starts with this number.",
        href: "/home-evaluation",
      },
      {
        title: "Search your next home",
        desc: "Every Calgary MLS listing, updated continuously.",
        href: "/mls",
      },
      {
        title: "Plan the sequence",
        desc: "A 20-minute call maps your sell-and-buy timeline.",
        href: "/contact",
      },
    ],
    faq: [
      {
        q: "Should I sell my current home before buying the next one?",
        a: "For most move-up buyers, yes — a firm sale defines your budget and makes your purchase offer stronger. But in a fast market for your target home, the order can flip. Spencer runs your equity math and the pace of both submarkets before recommending a sequence.",
      },
      {
        q: "What is bridge financing and will I need it?",
        a: "A short-term loan that covers the gap when your purchase closes before your sale. It's a normal, planned tool — not a rescue measure — and Spencer coordinates with your lender so it's approved before you need it.",
      },
      {
        q: "Can I make my purchase conditional on selling my home?",
        a: "Yes — a sale-of-buyer's-home condition. Sellers accept them selectively, and they can weaken your offer in competition. Whether to use one is a strategy call Spencer makes with you based on how strong your listing is.",
      },
      {
        q: "What if my home sells before I find the next one?",
        a: "Negotiated possession dates, seller lease-backs, and short-term options close that gap. It's a far better problem than owning two homes — and it's exactly the scenario the sequencing plan is built to handle.",
      },
    ],
    seoTitle: "Move-Up Buyers in Calgary | Sell & Buy Without Two Mortgages | Spencer Rivers",
    seoDescription:
      "Trading up to your forever home? Spencer Rivers coordinates the sell-and-buy sequence — pricing, bridge financing, and possession dates — so you move once, without carrying two mortgages.",
  },
  {
    slug: "family-focused-properties",
    icon: Users,
    title: "Family-Focused Properties",
    card: "School zones, cul-de-sacs, oversized lots, basement suites — the Calgary submarkets built for growing families.",
    headline: ["Built for the years", "the kids are home."],
    intro:
      "A family home is a school zone, a safe street, a yard that earns its keep, and room to grow — before it's a number of bedrooms. Spencer Rivers raised his own family in Calgary and matches growing households to the communities built for exactly these years: Springbank Hill, Aspen Woods, Edgemont, Mahogany, McKenzie Lake, and beyond.",
    image:
      "/img/work-with/family-focused-properties.jpg",
    imageAlt: "A family of four in front of their Calgary home at golden hour",
    points: [
      {
        icon: GraduationCap,
        title: "Schools, verified",
        body: "Catchments change and programs differ — French immersion, IB, designated versus walkable. Spencer verifies current school designations for every home on your shortlist rather than trusting the listing's claim.",
      },
      {
        icon: MapPin,
        title: "Streets that raise kids well",
        body: "Cul-de-sacs, pathway systems, park access, and traffic patterns matter as much as the floor plan. Spencer walks the block at kid-hours, not just the house at showing time.",
      },
      {
        icon: Home,
        title: "Room to grow into",
        body: "Oversized lots, basement suite potential, and floor plans that flex from toddlers to teenagers — so the house fits the family in year ten, not just at possession.",
      },
    ],
    steps: [
      {
        title: "The family brief",
        body: "Schools, commutes, activities, and the five-year plan — one conversation that turns 'four bedrooms' into a real definition of the right home.",
      },
      {
        title: "Shortlist by community first",
        body: "Calgary's family submarkets each trade differently. Spencer narrows to the two or three communities that fit, then screens listings within them.",
      },
      {
        title: "Diligence a family needs",
        body: "School verification, inspection strategy, suite legality, and a possession timeline that doesn't land mid-semester.",
      },
    ],
    links: [
      {
        title: "Family neighbourhoods",
        desc: "Compare Calgary's best communities for kids.",
        href: "/neighbourhoods",
      },
      {
        title: "Search family homes",
        desc: "Filter by beds, lots, and location across the MLS.",
        href: "/mls",
      },
      {
        title: "Outgrowing your current home?",
        desc: "Start with what it's worth today.",
        href: "/home-evaluation",
      },
    ],
    faq: [
      {
        q: "Which Calgary neighbourhoods are best for families?",
        a: "It depends on the trade you want: west-side communities like Springbank Hill, Aspen Woods, and Edgemont for schools and established amenities; lake communities like Mahogany and McKenzie Lake for the beach-club lifestyle. Spencer shortlists based on your schools, commute, and budget.",
      },
      {
        q: "How do I confirm which schools a home is designated for?",
        a: "Check the CBE and Calgary Catholic designation tools for the exact address — catchments shift, and listings are sometimes out of date. Spencer verifies designations for every home his family clients shortlist.",
      },
      {
        q: "Is a basement suite worth prioritizing?",
        a: "If it's legal or legalizable, yes — it's flexible space for a nanny, teenagers, or in-laws now, and rental income later. Legal status matters enormously to value, and Spencer confirms it with the city rather than taking the listing's word.",
      },
      {
        q: "When is the best time of year for a family to move?",
        a: "Most families target possession in late June through August to land between school years. That means starting the search in late winter or spring. Working backward from a September school start is exactly the kind of timeline Spencer builds.",
      },
    ],
    seoTitle: "Family Homes in Calgary | School Zones, Lots & Communities | Spencer Rivers",
    seoDescription:
      "Find the Calgary communities built for growing families. Spencer Rivers verifies school zones, walks the streets, and matches your family to the right home in Springbank Hill, Aspen Woods, Mahogany, and more.",
  },
  {
    slug: "urban-properties",
    icon: Briefcase,
    title: "Urban Properties",
    card: "Loft condos, executive townhomes, and walkable inner-city neighbourhoods for professionals and downsizers.",
    headline: ["Walkable Calgary,", "properly vetted."],
    intro:
      "Loft condos in converted warehouses, executive townhomes off 17th Avenue, full-floor suites above the Beltline — urban Calgary is a market of buildings, and buildings have finances, boards, and reputations. Spencer Rivers, Certified Condo Specialist, vets the building as carefully as the suite.",
    image:
      "/img/neighbourhoods/beltline.jpg",
    imageAlt: "Downtown Calgary skyline above the Beltline",
    points: [
      {
        icon: Building2,
        title: "The building is the investment",
        body: "Reserve funds, board minutes, upcoming assessments, and construction pedigree decide whether an urban condo compounds or corrodes. Spencer reads the full document package on every purchase.",
      },
      {
        icon: MapPin,
        title: "Walkability, quantified",
        body: "Mission, Beltline, Kensington, Inglewood, East Village — each trades nightlife, quiet, and transit differently. Spencer matches the block to how you actually spend your week.",
      },
      {
        icon: TrendingUp,
        title: "Resale thinking, built in",
        body: "Floor plan efficiency, parking, views, and building reputation drive urban resale far more than finishes. Spencer buys with the exit in mind, even when the exit is a decade away.",
      },
    ],
    steps: [
      {
        title: "Neighbourhood, then building, then suite",
        body: "The search runs in that order — the right block, a shortlist of sound buildings, then the suites worth viewing inside them.",
      },
      {
        title: "Document diligence",
        body: "Condo documents, reserve fund study, and board minutes reviewed before your condition deadline — with a plain-language summary of what they say.",
      },
      {
        title: "Negotiate and close",
        body: "Offer strategy from building-level comparable sales, conditions handled properly, and possession coordinated with your schedule.",
      },
    ],
    links: [
      {
        title: "Luxury condos & lofts",
        desc: "Calgary's premier buildings, profiled one by one.",
        href: "/condos",
      },
      {
        title: "Beltline",
        desc: "Calgary's densest, most walkable neighbourhood.",
        href: "/neighbourhoods/beltline",
      },
      {
        title: "Search urban listings",
        desc: "Condos and townhomes across the inner city.",
        href: "/mls",
      },
    ],
    faq: [
      {
        q: "What should I check before buying a condo in Calgary?",
        a: "The building's reserve fund study, two years of board minutes, recent special assessments, and the management company's track record. The suite is the easy part — the building's finances are where urban purchases go wrong.",
      },
      {
        q: "Are condo fees in urban buildings worth it?",
        a: "Judged per square foot against what they cover — concierge, amenities, utilities, reserve contributions — many are fair. A suspiciously low fee is a bigger red flag than a high one; it often means the reserve fund is starving.",
      },
      {
        q: "Which urban neighbourhoods suit professionals best?",
        a: "Beltline and Mission for walk-to-work density and restaurants; Kensington and Inglewood for character and independent shops; East Village for new construction and river pathways. Each has distinct buildings worth targeting — and a few worth avoiding.",
      },
      {
        q: "Do lofts and townhomes hold value like detached homes?",
        a: "The good ones do. Scarce product — true conversion lofts, well-built brownstone-style townhomes, suites with parking and views — has performed well in Calgary. Commodity high-rise product is more cyclical, which is exactly why building selection matters.",
      },
    ],
    seoTitle: "Urban Condos, Lofts & Townhomes in Calgary | Spencer Rivers",
    seoDescription:
      "Buy urban Calgary with a Certified Condo Specialist. Spencer Rivers vets buildings — reserve funds, boards, construction — across Beltline, Mission, Kensington, Inglewood, and East Village.",
  },
];

export function getSegment(slug: string | undefined) {
  return AUDIENCE_SEGMENTS.find((s) => s.slug === slug);
}

// --- Shared CTA block -------------------------------------------------
function SegmentCta({ segment }: { segment: AudienceSegment }) {
  return (
    <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-24">
      <div className="bg-foreground text-background rounded-sm p-12 lg:p-16 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-10 items-center">
        <div>
          <div className="font-display text-[10px] tracking-[0.22em] text-background/65">
            GET IN TOUCH
          </div>
          <h2 className="mt-3 font-serif text-3xl lg:text-5xl leading-[1.05] max-w-[640px]">
            Sound like you? Start the conversation.
          </h2>
          <p className="mt-5 text-background/75 max-w-[560px]">
            Call or text Spencer directly. Every inquiry gets a personal reply
            within the day.
          </p>
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          <a
            href={SPENCER_PHONE_HREF}
            className="inline-flex items-center gap-3 px-5 py-3.5 border border-background/30 rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-background/10 transition-colors"
            data-testid={`link-segment-call-${segment.slug}`}
          >
            <Phone className="w-3.5 h-3.5" strokeWidth={1.8} />
            {SPENCER_PHONE}
          </a>
          <a
            href={SPENCER_EMAIL_HREF}
            className="inline-flex items-center gap-3 px-5 py-3.5 border border-background/30 rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-background/10 transition-colors"
            data-testid={`link-segment-email-${segment.slug}`}
          >
            <Mail className="w-3.5 h-3.5" strokeWidth={1.8} />
            {SPENCER_EMAIL.toUpperCase()}
          </a>
          <Link href="/contact">
              <Button
                variant="outline"
                className="bg-background text-foreground hover:bg-background/90 border-background h-11 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2"
                data-testid={`button-segment-contact-${segment.slug}`}
              >
                SEND A NOTE
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
              </Button>
            
          </Link>
        </div>
      </div>
    </section>
  );
}

// --- Detail page ------------------------------------------------------
export default function WorkWithDetailPage() {
  const [, params] = useRoute<{ slug: string }>("/work-with/:slug");
  const segment = getSegment(params?.slug);

  if (!segment) return <NotFound />;

  const others = AUDIENCE_SEGMENTS.filter((s) => s.slug !== segment.slug);
  const canonical = `${SITE_ORIGIN}/work-with/${segment.slug}`;

  return (
    <PublicLayout>
      {/* Schema (breadcrumbs) is server-emitted by metaForPath — this only
          keeps title/meta current on SPA nav. */}
      <SeoHead
        title={segment.seoTitle}
        description={segment.seoDescription}
        canonical={canonical}
        ogImage={segment.image}
      />

      {/* Hero */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pt-12 lg:pt-16 pb-16 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-center">
          <div className="lg:col-span-7">
            <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
              WHO WE WORK WITH — {segment.title.toUpperCase()}
            </div>
            <h1 className="mt-5 font-serif text-[40px] lg:text-[68px] leading-[1.02] tracking-tight">
              {segment.headline[0]}
              <br />
              <em className="not-italic font-normal">{segment.headline[1]}</em>
            </h1>
            <p className="mt-8 max-w-[620px] text-[17px] lg:text-[18px] leading-[1.7] text-foreground/85">
              {segment.intro}
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a href={SPENCER_PHONE_HREF}>
                <Button
                  className="h-12 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2 px-6"
                  data-testid={`button-hero-call-${segment.slug}`}
                >
                  <Phone className="w-3.5 h-3.5" strokeWidth={1.8} />
                  CALL OR TEXT SPENCER
                </Button>
              </a>
              <Link href="/contact">
                  <Button
                    variant="outline"
                    className="h-12 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2 px-6"
                    data-testid={`button-hero-contact-${segment.slug}`}
                  >
                    SEND A NOTE
                    <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
                  </Button>
                
              </Link>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div
              className={
                segment.imageStyle === "badge"
                  ? "aspect-square rounded-sm overflow-hidden bg-white flex items-center justify-center"
                  : "aspect-[4/5] rounded-sm overflow-hidden bg-secondary"
              }
            >
              <img
                src={segment.image}
                alt={segment.imageAlt}
                className={
                  segment.imageStyle === "badge"
                    ? "w-full h-full object-contain"
                    : "w-full h-full object-cover"
                }
                loading="eager"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="bg-secondary/30 border-y border-border py-16 lg:py-24">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10">
          <div className="max-w-2xl mb-12">
            <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
              HOW SPENCER HELPS
            </div>
            <h2 className="font-serif text-[30px] lg:text-[44px] leading-[1.05] tracking-tight">
              {segment.pointsHeading ?? "What working together looks like."}
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6">
            {segment.points.map(({ icon: Icon, title, body }) => (
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
        </div>
      </section>

      {/* Process steps */}
      <section className="max-w-[1100px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
          THE PROCESS
        </div>
        <h2 className="font-serif text-[30px] lg:text-[44px] leading-[1.05] tracking-tight mb-12">
          {segment.stepsHeading ?? "Three steps, no guesswork."}
        </h2>
        <div className="space-y-10">
          {segment.steps.map((step, i) => (
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

      {/* Related links */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pb-16 lg:pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6">
          {segment.links.map((l) => (
            <Link key={l.href + l.title} href={l.href} className="group block border border-border rounded-sm p-7 hover:border-foreground/40 transition-colors"
                data-testid={`link-segment-related-${segment.slug}-${l.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
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

      {/* FAQ */}
      <FaqAccordion
        items={segment.faq}
        heading="Frequently asked questions"
        eyebrow={segment.title.toUpperCase()}
      />

      {/* CTA */}
      <SegmentCta segment={segment} />

      {/* Other segments */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pb-24">
        <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-6">
          ALSO WORKING WITH
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border">
          {others.map((s) => (
            <Link key={s.slug} href={`/work-with/${s.slug}`} className="group block h-full bg-background p-5 lg:p-6 hover:bg-secondary/40 transition-colors"
                data-testid={`link-segment-other-${s.slug}`}>
                <s.icon
                  className="w-5 h-5 text-muted-foreground"
                  strokeWidth={1.4}
                />
                <div className="mt-3 font-serif text-[16px] leading-snug group-hover:translate-x-1 transition-transform">
                  {s.title}
                </div>
              
            </Link>
          ))}
        </div>
      </section>
    </PublicLayout>
  );
}

// --- Index page (/work-with) -----------------------------------------
export function WorkWithIndexPage() {
  return (
    <PublicLayout>
      <SeoHead
        title="Who We Work With | Spencer Rivers, Rivers Real Estate Calgary"
        description="Luxury buyers, first-time sellers, expired listings, empty nesters, move-up families, and urban professionals — see how Spencer Rivers works with each, across Calgary's best communities."
        canonical={`${SITE_ORIGIN}/work-with`}
      />

      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pt-12 lg:pt-16 pb-24">
        <div className="text-center max-w-3xl mx-auto mb-14 lg:mb-20">
          <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground mb-4">
            WHO WE WORK WITH
          </div>
          <h1 className="font-serif text-[36px] lg:text-[56px] leading-[1.04] tracking-tight">
            We are your team for buying or selling.
          </h1>
          <p className="mt-6 text-[15px] lg:text-[16px] text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            Every client walks in with a different next chapter. These are the
            nine we know best — pick yours and see exactly how Spencer Rivers
            runs the process.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6">
          {AUDIENCE_SEGMENTS.map(({ slug, icon: Icon, title, card }) => (
            <Link key={slug} href={`/work-with/${slug}`} className="group block border border-border rounded-sm p-7 lg:p-8 bg-card hover:border-foreground/40 transition-colors"
                data-testid={`card-workwith-${slug}`}>
                <Icon className="w-6 h-6 text-foreground" strokeWidth={1.4} />
                <h2 className="mt-5 font-serif text-[20px] leading-tight">
                  {title}
                </h2>
                <p className="mt-3 text-[13px] text-muted-foreground leading-relaxed">
                  {card}
                </p>
                <div className="mt-6 inline-flex items-center gap-2 font-display text-[10px] tracking-[0.22em] text-foreground group-hover:gap-3 transition-all">
                  LEARN MORE
                  <ArrowRight className="w-3 h-3" strokeWidth={1.8} />
                </div>
              
            </Link>
          ))}
        </div>
      </section>
    </PublicLayout>
  );
}
