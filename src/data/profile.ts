// The only place site copy lives. Pages render from this file.
// Rules: never invent numbers, clients or testimonials. Private workspace names never appear here.
// Every TODO must be confirmed by Vikrant before P0a ships.

export interface Exhibit {
  slug: string;
  /** Public name, as a recruiter will see it on GitHub or the live site. */
  name: string;
  summary: string;
  /** One-line honest bound. */
  bound: string;
  /** The card's one primary action. null = no action yet (nothing half-finished is linked). */
  link: { label: string; href: string } | null;
  /** The finished page the card title links to; null = no page yet. */
  page: string | null;
  /** Text status chip (ADR-018): only for something a visitor can see or try right now. */
  chip?: string;
}

export interface Post {
  title: string;
  /** Publish date on Medium, YYYY-MM-DD. */
  date: string;
  /** One claim, in the post's own words. */
  claim: string;
  /** Canonical Medium URL. We list and link; we never republish. */
  url: string;
}

/** Medium posts, newest first. Titles, dates and URLs from the Medium feed (medium.com/feed/@svikrant), 30 Sep 2026. */
export const writing: Post[] = [
  {
    title: "Tests passed. Nobody can explain the change.",
    date: "2026-09-28",
    claim: "Writing got cheap. Knowing did not.",
    url: "https://svikrant.medium.com/tests-passed-nobody-can-explain-the-change-499fbcabd824",
  },
  {
    title: "You will not read the pile. Stop designing as if you will.",
    date: "2026-09-24",
    claim: "You cannot review everything. So review the right things.",
    url: "https://svikrant.medium.com/you-will-not-read-the-pile-stop-designing-as-if-you-will-723dc7516de1",
  },
  {
    title: "AI did not invent looking it up",
    date: "2026-09-23",
    claim: "The model did not introduce outside help. It moved it from the search bar into the editor.",
    url: "https://svikrant.medium.com/we-were-already-looking-it-up-81e19fd00234",
  },
  {
    title: "AI proposes. A human authorizes.",
    date: "2026-09-22",
    claim: "If the AI model is down, the folder is still the ticket.",
    url: "https://svikrant.medium.com/ai-proposes-a-human-authorizes-b64a10734bea",
  },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-22" → "22 Sep 2026". Fixed month names (ICU renders "Sept" in some locales). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export const profile = {
  name: "Vikrant Singh",
  // Chosen by Vikrant 30 Sep 2026 (Stage 1.2). LinkedIn must be updated to match word for word (R2).
  // No "owns the pager" until the heartbeat has 30 days of history plus a game day (ROADMAP Stage 3).
  headline: "Delivery leader for product and platform teams: plan, gate, production",
  // Confirmed by Vikrant 30 Sep 2026: CompuCom 2018–2021 (3 years); Virtusa/Citi about 3 years.
  // Still unconfirmed for public use, so left out: 55% auto-resolve, MTTR −35%.
  bio: [
    "I lead delivery of product slices end to end, from the one-pager to production.",
    "At CompuCom (2018–2021): ServiceNow–Remedy integration and Sev-1/2 operations. At Virtusa for Citi (about 3 years): 22 application programs, design to go-live.",
    "Today I build AI into operations with a human gate: the AI proposes, people decide.",
  ],
  location: "Toronto, Canada",
  // null = not rendered.
  links: {
    linkedin: "https://www.linkedin.com/in/ssvikrant/",
    // Set by Vikrant 30 Sep 2026. Must be a working Cloudflare Email Routing address.
    email: "mailto:contact@vikrantsingh.fyi" as string | null,
    medium: "https://medium.com/@svikrant" as string | null,
    // The account that owns the public engine repo vikrant_perswebsite_incidents_aiengine (verified via gh auth).
    github: "https://github.com/vikiscoding" as string | null,
    // Web copy (30 Sep 2026): mobile number and personal Gmail removed; contact@vikrantsingh.fyi only.
    resume: "/resume.pdf" as string | null,
  },
  // One primary call to action per card. Incident-AI first (finished walk), Pulse run last (ADR-015).
  exhibits: [
    {
      slug: "incident-ai",
      name: "Incident-AI",
      summary:
        "Incident triage where the AI drafts and a human authorizes. Folder is the ticket. If the model is down, the path still works.",
      bound: "Python on GitHub Actions, handling one small site's real incidents. Not ServiceNow.",
      link: { label: "Watch the walk (~14 min)", href: "https://youtu.be/j048FYXrRqs" },
      page: "/exhibits/incident-ai/",
      chip: "Live",
    },
    {
      slug: "atlas-flow",
      name: "Atlas Flow",
      summary: "Live TypeScript/Node write path: form to server action to a SharePoint row, in production.",
      bound: "A marketing site in production, not a system with millions of members.",
      // Hidden until the written walk exists (30 Sep 2026): no link, no "in progress" page linked.
      // When it's written: link { label: "Read the walk", href: "/exhibits/atlas-flow/" }, page: "/exhibits/atlas-flow/".
      // Never point it at the Incident-AI videos; its repo is in a private client organisation.
      link: null,
      page: null,
    },
    {
      // ADR-015: exhibit three, a client-path testbed. Never the hero; no numbers here until real samples exist;
      // never linked to the Incident-AI or Atlas videos or essays.
      slug: "pulse-run",
      name: "Pulse run",
      summary: "Tiny browser runner used as a client perf and error-budget testbed on this same site.",
      bound: "A 30-second toy, not a product.",
      link: { label: "Play 30 seconds →", href: "/play/" },
      page: "/play/",
      chip: "Playable",
    },
  ] satisfies Exhibit[],
} as const;
