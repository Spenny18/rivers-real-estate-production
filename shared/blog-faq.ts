// FAQ entries in a blog post body, for FAQPage schema (server/seo-inject.ts).
//
// A post opts in by having a "## Frequently Asked Questions" (or "## FAQ" /
// "## FAQs") section whose questions are "### " headings, each followed by
// its answer paragraphs — the shape blog-detail.tsx renders as visible H3s,
// so the schema only ever describes text that is on the page. The section
// ends at the next "## " heading.

export interface BlogFaq {
  question: string;
  answer: string;
}

const FAQ_HEADING = /^##\s+(frequently asked questions|faqs?)\s*:?\s*$/i;

/** Markdown the renderer supports, reduced to plain text. */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractBlogFaqs(body: string): BlogFaq[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => FAQ_HEADING.test(l.trim()));
  if (start < 0) return [];
  const out: BlogFaq[] = [];
  let q: string | null = null;
  let answer: string[] = [];
  const flush = () => {
    const a = plain(answer.join("\n"));
    if (q && a) out.push({ question: plain(q), answer: a });
    q = null;
    answer = [];
  };
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^##\s/.test(line)) break;
    if (/^###\s/.test(line)) {
      flush();
      q = line.replace(/^###\s+/, "");
      continue;
    }
    if (q) answer.push(line);
  }
  flush();
  return out.slice(0, 20);
}
