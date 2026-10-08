// /privacy-policy — what the site collects and why.
//
// Written to match what the code actually does: the first-party activity
// tracking in server/tracking.ts, email open/click tracking, the cookies set
// by server/tracking-routes.ts and server/account.ts, and the third parties
// wired into client/index.html and the server. If any of those change, this
// page should change with them. Title and description must stay in sync with
// metaForPath() in server/seo-inject.ts.

import type { ReactNode } from "react";
import { PublicLayout } from "@/components/public-layout";
import { SeoHead } from "@/components/seo-head";
import { SPENCER_EMAIL, SPENCER_EMAIL_HREF, SPENCER_PHONE, SPENCER_PHONE_HREF } from "@/lib/format";

export const PRIVACY_TITLE = "Privacy Policy | Rivers Real Estate";
export const PRIVACY_DESCRIPTION =
  "How Spencer Rivers and Rivers Real Estate collect, use and protect your personal information — cookies, website activity, email tracking, and your choices.";

const EFFECTIVE = "October 8, 2026";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 pt-10 first:pt-0">
      <h2 className="font-serif text-2xl lg:text-[28px] leading-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-[15.5px] leading-[1.75] text-foreground/85">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc pl-5 space-y-2 marker:text-foreground/40">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

const COOKIES: Array<{ name: string; by: string; purpose: string; lasts: string }> = [
  {
    name: "lhc_vid",
    by: "This site",
    purpose:
      "A random ID that lets us recognise your browser between visits, so pages and listings you view can be linked to you once you've contacted us.",
    lasts: "2 years",
  },
  {
    name: "rrec_account",
    by: "This site",
    purpose: "Keeps you signed in to your client portal (saved homes, searches, notes).",
    lasts: "60 days",
  },
  {
    name: "rivers.listings.unlocked",
    by: "This site (browser storage)",
    purpose: "Remembers that you've already registered to see full listing details.",
    lasts: "Until cleared",
  },
  {
    name: "_ga, _ga_*",
    by: "Google Analytics",
    purpose: "Anonymous, aggregate statistics about how the site is used.",
    lasts: "Up to 2 years",
  },
  {
    name: "Follow Up Boss tracker",
    by: "Follow Up Boss (our CRM)",
    purpose: "Records page views for contacts in our CRM, like our own activity tracking.",
    lasts: "Set by Follow Up Boss",
  },
];

const SECTIONS = [
  ["who", "Who we are"],
  ["collect", "What we collect"],
  ["use", "How we use it"],
  ["cookies", "Cookies and website activity"],
  ["email", "Email, and how we track it"],
  ["share", "Who we share it with"],
  ["where", "Where your information is stored"],
  ["keep", "How long we keep it"],
  ["choices", "Your choices and rights"],
  ["security", "Security"],
  ["changes", "Changes to this policy"],
  ["contact", "Contact"],
] as const;

export default function PrivacyPolicyPage() {
  return (
    <PublicLayout>
      <SeoHead title={PRIVACY_TITLE} description={PRIVACY_DESCRIPTION} canonical="https://riversrealestate.ca/privacy-policy" />

      <article className="max-w-[820px] mx-auto px-6 lg:px-10 pt-12 lg:pt-16 pb-20 lg:pb-28">
        <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground">LEGAL</div>
        <h1 className="mt-4 font-serif text-4xl lg:text-6xl leading-[1.05]">Privacy Policy</h1>
        <p className="mt-5 text-[13px] text-muted-foreground">Effective {EFFECTIVE}</p>
        <p className="mt-6 text-[17px] leading-[1.7] text-foreground/85">
          Buying or selling a home means sharing a lot about yourself. This page explains, in plain
          language, what this website collects, what I do with it, and the choices you have.
        </p>

        <nav aria-label="On this page" className="mt-10 rounded-sm border border-border p-5">
          <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground mb-3">ON THIS PAGE</div>
          <ol className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[14px] list-decimal pl-5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:underline underline-offset-2">
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-12 divide-y divide-border [&>section]:pb-10">
          <Section id="who" title="Who we are">
            <p>
              This website (riversrealestate.ca and luxuryhomescalgary.ca) is operated by Spencer Rivers,
              a REALTOR® with Synterra Realty in Calgary, Alberta, doing business as Rivers Real Estate.
              In this policy “I”, “we” and “us” mean Spencer Rivers and Rivers Real Estate.
            </p>
            <p>
              We handle personal information in line with Alberta's <em>Personal Information Protection
              Act</em> (PIPA) and, where it applies, the federal <em>Personal Information Protection and
              Electronic Documents Act</em> (PIPEDA). I am responsible for privacy for this website; you
              can reach me using the details at the end of this page.
            </p>
          </Section>

          <Section id="collect" title="What we collect">
            <p>
              <strong className="text-foreground">Information you give us.</strong> When you send an
              inquiry, request a showing or a home valuation, book a meeting, register to see full
              listing details, subscribe to the newsletter, or create a client portal account, we
              collect what you enter — typically your name, email, phone number, a property address and
              your message. If we work together on a transaction, we also handle the documents and
              electronic signatures that transaction needs.
            </p>
            <p>
              <strong className="text-foreground">Information collected automatically.</strong> When you
              browse the site we record the pages and listings you view, when you viewed them, the page
              that referred you (including campaign tags in the link), and basic technical details such
              as your browser type. Your IP address is used to protect forms from abuse and spam.
            </p>
            <p>
              <strong className="text-foreground">Email engagement.</strong> Some emails we send record
              whether they were opened and which links were clicked (see{" "}
              <a href="#email" className="underline underline-offset-2">Email</a> below).
            </p>
            <p>
              We don't knowingly collect information from anyone under 18, and the site isn't directed
              at children.
            </p>
          </Section>

          <Section id="use" title="How we use it">
            <List
              items={[
                "To reply to you and provide the real estate services you ask for — showings, valuations, advice, and representing you in a purchase or sale.",
                "To send the listing alerts, market updates and newsletters you've signed up for.",
                "To understand what you're looking for, so the homes and advice I bring you are relevant — for example, noticing that you've been looking at homes in a particular neighbourhood or price range.",
                "To let me know when someone I'm working with returns to the site, so I can follow up at a useful moment.",
                "To keep the records Alberta real estate regulations require, and to meet other legal obligations.",
                "To run, secure and improve the website.",
              ]}
            />
            <p>We do not sell, rent or trade your personal information, and we never will.</p>
          </Section>

          <Section id="cookies" title="Cookies and website activity">
            <p>
              The site uses a small number of cookies and similar browser storage. Our own visitor
              cookie lets us recognise your browser from one visit to the next. Until you identify
              yourself — by submitting a form, signing in to your portal, or clicking a link in an email
              from us — the pages you view are recorded against that random ID only. Once you do, your
              browsing history on this site (including what you viewed before) becomes part of your
              client record, so I can see which homes have caught your interest.
            </p>
            {/* Phones: one card per cookie. A four-column table doesn't fit at 375px. */}
            <div className="sm:hidden space-y-3">
              {COOKIES.map((c) => (
                <div key={c.name} className="rounded-sm border border-border p-4 text-[14px]">
                  <div className="font-mono text-[13px] text-foreground break-all">{c.name}</div>
                  <div className="mt-1 text-[12.5px] text-muted-foreground">
                    {c.by} · {c.lasts}
                  </div>
                  <p className="mt-2 leading-relaxed">{c.purpose}</p>
                </div>
              ))}
            </div>
            <div className="hidden sm:block">
              <table className="w-full text-[14px] border-collapse">
                <thead>
                  <tr className="text-left font-display text-[10px] tracking-[0.16em] text-muted-foreground">
                    <th className="py-2 pr-4 font-normal">NAME</th>
                    <th className="py-2 pr-4 font-normal">SET BY</th>
                    <th className="py-2 pr-4 font-normal">PURPOSE</th>
                    <th className="py-2 font-normal">LASTS</th>
                  </tr>
                </thead>
                <tbody>
                  {COOKIES.map((c) => (
                    <tr key={c.name} className="border-t border-border align-top">
                      <td className="py-3 pr-4 font-mono text-[12.5px] whitespace-nowrap">{c.name}</td>
                      <td className="py-3 pr-4 whitespace-nowrap">{c.by}</td>
                      <td className="py-3 pr-4 leading-relaxed">{c.purpose}</td>
                      <td className="py-3 whitespace-nowrap">{c.lasts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              You can block or delete cookies in your browser settings. The site still works without
              them, but we won't be able to keep you signed in to your portal or remember your listing
              registration. Google offers an{" "}
              <a
                href="https://tools.google.com/dlpage/gaoptout"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                opt-out add-on for Google Analytics
              </a>
              .
            </p>
          </Section>

          <Section id="email" title="Email, and how we track it">
            <p>
              We only send commercial email — newsletters, market updates, listing alerts — to people
              who have asked for it or with whom we have an existing relationship, as Canada's
              Anti-Spam Legislation (CASL) requires. Every one of those emails includes a way to
              unsubscribe, and we act on it promptly.
            </p>
            <p>
              Listing alerts, newsletters, valuation emails and messages I send you from my CRM contain
              a tiny invisible image and links that pass through this website. These tell us when an
              email is opened and which links are clicked, and clicking a link identifies your browser
              as described above. If you'd rather this didn't happen, set your email app not to load
              images automatically — the emails still work, and links still take you where they say.
              Unsubscribe links are never tracked.
            </p>
          </Section>

          <Section id="share" title="Who we share it with">
            <p>
              We share personal information only with the service providers that run this website and
              my business, and only what they need to do their job. They're required to protect it and
              may not use it for their own purposes.
            </p>
            <List
              items={[
                <><strong className="text-foreground">Website hosting and backups</strong> — Fly.io (servers) and Cloudflare (encrypted backups).</>,
                <><strong className="text-foreground">Customer relationship management</strong> — Follow Up Boss.</>,
                <><strong className="text-foreground">Email delivery</strong> — Resend (alerts and newsletters) and Google Workspace (my own mailbox and calendar).</>,
                <><strong className="text-foreground">Analytics</strong> — Google Analytics (aggregate site statistics).</>,
                <><strong className="text-foreground">Maps and address lookup</strong> — Google Maps and OpenStreetMap, which receive the addresses you search and your IP address when maps load.</>,
                <><strong className="text-foreground">Home valuations</strong> — our automated valuation provider receives the property address you submit.</>,
              ]}
            />
            <p>
              My brokerage, Synterra Realty, may access client and transaction records as part of its
              legal supervision of my practice. With your consent, we share what's needed with others
              involved in your transaction — for example lawyers, lenders, inspectors or the other
              party's agent. We may also disclose information where the law requires it.
            </p>
          </Section>

          <Section id="where" title="Where your information is stored">
            <p>
              Some of our service providers, including our website host, store information on servers
              in the United States. Information stored outside Canada is subject to the laws of that
              country and may be accessible to its courts and authorities. If you have questions about
              how a particular provider handles your information, ask me and I'll tell you.
            </p>
          </Section>

          <Section id="keep" title="How long we keep it">
            <p>
              We keep your information for as long as we have a working relationship and for as long
              afterwards as it's useful to you or required by law — Alberta real estate rules require
              brokerages to keep transaction records for a number of years. When information is no
              longer needed, or you ask us to delete it and we're not required to keep it, we delete it.
            </p>
          </Section>

          <Section id="choices" title="Your choices and rights">
            <List
              items={[
                "Ask what personal information we hold about you, and get a copy.",
                "Ask us to correct anything that's wrong.",
                "Withdraw your consent — for example to emails or to activity tracking — and ask us to delete your information, subject to records we're legally required to keep.",
                "Unsubscribe from any email using the link in it, or by replying to tell me.",
              ]}
            />
            <p>
              Send any of these requests to the email address below. I'll confirm your identity and
              respond within 45 days, as Alberta law requires. If you're not satisfied with how I've
              handled your information, you can contact the{" "}
              <a
                href="https://oipc.ab.ca"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Office of the Information and Privacy Commissioner of Alberta
              </a>
              .
            </p>
          </Section>

          <Section id="security" title="Security">
            <p>
              The site is served over encrypted connections, access to client records is restricted to
              me and protected by login, and backups are encrypted. No system is perfectly secure, but
              we take reasonable steps to protect your information against loss, theft and misuse.
            </p>
          </Section>

          <Section id="changes" title="Changes to this policy">
            <p>
              If we change how we handle personal information, we'll update this page and the effective
              date at the top. Significant changes will be noted here.
            </p>
          </Section>

          <Section id="contact" title="Contact">
            <p>Questions or requests about your personal information:</p>
            <p>
              Spencer Rivers, Rivers Real Estate — Synterra Realty
              <br />
              700 - 1816 Crowchild Trail NW, Calgary, Alberta T2M 3Y7
              <br />
              <a href={SPENCER_EMAIL_HREF} className="underline underline-offset-2">
                {SPENCER_EMAIL}
              </a>{" "}
              ·{" "}
              <a href={SPENCER_PHONE_HREF} className="underline underline-offset-2">
                {SPENCER_PHONE}
              </a>
            </p>
          </Section>
        </div>
      </article>
    </PublicLayout>
  );
}
