// Readable plain-text email bodies for the Inbox.
//
// Gmail's plain-text version of an HTML email renders every picture as
// "[Image]" (or "[cid:…]", "[signature_123]") and every link as
// "label<http://…>" — e.g. "www.example.com<http://www.example.com/>" or
// "pat@x.com<mailto:pat@x.com>". This turns that back into clickable text:
//   - image placeholders are dropped and counted;
//   - "label<url>" becomes one link on the label when the label is the URL
//     (or the address); otherwise the label stays and a small "link" follows;
//   - bare URLs, www. addresses, emails and North American phone numbers
//     become links.

export type Segment = { type: "text"; text: string } | { type: "link"; text: string; href: string };

export interface EmailText {
  segments: Segment[];
  hiddenImages: number;
}

const PLACEHOLDER = /\[(?:image(?::[^\]\n]*)?|inline image[^\]\n]*|cid:[^\]\n]*|signature_[^\]\n]*|logo[^\]\n]*)\]/gi;

// label<url>: the URL in angle brackets, with its scheme.
const ANGLE_LINK = /(\S*)\s?<((?:https?:\/\/|mailto:|tel:)[^>\s]+)>/gi;

// Bare things worth linking, in priority order within one pattern.
const BARE = new RegExp(
  [
    String.raw`(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])`, // 1 URL
    String.raw`(\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])?)`, // 2 www.
    String.raw`([a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,})`, // 3 email
    String.raw`((?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)`, // 4 phone
  ].join("|"),
  "gi",
);

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^mailto:|^tel:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/.]+$/, "");
}

function linkifyBare(text: string, out: Segment[]) {
  let last = 0;
  for (const m of Array.from(text.matchAll(BARE))) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", text: text.slice(last, i) });
    const [whole, url, www, email, phone] = m;
    if (url) out.push({ type: "link", text: url, href: url });
    else if (www) out.push({ type: "link", text: www, href: `https://${www}` });
    else if (email) out.push({ type: "link", text: email, href: `mailto:${email}` });
    else if (phone) {
      const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      out.push(digits.length === 10 ? { type: "link", text: phone, href: `tel:+1${digits}` } : { type: "text", text: whole });
    }
    last = i + whole.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
}

export function formatEmailText(raw: string | null | undefined): EmailText {
  let hiddenImages = 0;
  let text = (raw ?? "").replace(PLACEHOLDER, () => {
    hiddenImages++;
    return "";
  });
  // Lines left empty by removed placeholders, and runs of blank lines.
  text = text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const segments: Segment[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(ANGLE_LINK))) {
    const i = m.index ?? 0;
    const [whole, label, href] = m;
    if (i > last) linkifyBare(text.slice(last, i), segments);
    if (label && norm(label) === norm(href)) {
      // "www.x.com<http://www.x.com/>" -> one link on the label.
      segments.push({ type: "link", text: label, href });
    } else {
      // "View listing <http://…>" -> keep the words, add a compact link.
      if (label) linkifyBare(label, segments);
      segments.push({ type: "text", text: whole.length > (label?.length ?? 0) && /\s</.test(whole) ? " " : "" });
      segments.push({ type: "link", text: href.startsWith("mailto:") ? href.slice(7) : "link", href });
    }
    last = i + whole.length;
  }
  if (last < text.length) linkifyBare(text.slice(last), segments);

  // Merge adjacent text segments.
  const merged: Segment[] = [];
  for (const s of segments) {
    const prev = merged[merged.length - 1];
    if (s.type === "text" && prev?.type === "text") prev.text += s.text;
    else if (!(s.type === "text" && s.text === "")) merged.push({ ...s });
  }
  return { segments: merged, hiddenImages };
}
