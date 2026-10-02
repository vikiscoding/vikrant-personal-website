// The only place site copy lives. Pages render from this file.
// Rules: never invent numbers, clients or testimonials. Every figure must trace to the résumé or the owner's confirmation.

export interface Proof {
  title: string;
  text: string;
  /** What it is not. Shown after the text, never first (ADR-022). */
  scope?: string;
  /** Text status chip (ADR-018): only for something a visitor can see or try right now. */
  chip?: string;
  /** First link is the primary action; the rest are secondary. */
  links: { label: string; href: string }[];
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

// Homepage copy by the owner (1 Oct 2026, ADR-022), with factual corrections agreed in review:
// "IT services" not "software" for fifteen years (2009–2017 was IT operations); the ~95% is the infrastructure
// for the 22 programs (résumé); the CompuCom team supported the estate, the integration was an SME role (résumé);
// 55% / 35% are the owner's figures (not on the résumé); drafts are never sent by anyone.
export const profile = {
  name: "Vikrant Singh",
  // Must match the LinkedIn headline. Regenerate public/og.png when it changes (scripts/make-brand-assets.py).
  headline: "IT Operations and Engineering",
  description:
    "I've led teams, and I build hands-on: useful systems for businesses, including my own. Delivery across 22 programs at Citi, Sev-1 operations for a 3,000-server government estate, and a site that runs on its own SLOs.",
  // Chosen 1 Oct 2026: led teams and builds hands-on; "including my own" = this site and Balance-Books.
  intro: "I've led teams, and I build hands-on: useful systems for businesses, including my own.",
  story: [
    "For fifteen years I've been accountable for IT services reaching people and staying up.",
    "At Citi, through Virtusa, I ran delivery across 22 Trade and Transaction Services programs in North America, from design to go-live; the infrastructure for all 22 landed about 95% on time. Root-cause work on two trade applications cut repeat incidents by 60%.",
    "For the Government of Ontario, through CompuCom (2018–2021), I led a 15-person team supporting a 24x7 estate of 3,000+ servers, and was the subject-matter expert on its ServiceNow–Remedy integration. I was the person the client called on Sev-1 and Sev-2, and I ran the response through restore. Fully automated resolution went from zero to 55% of volume, and time to restore fell by 35%.",
  ],
  principles: {
    lead: "What I hold a team to.",
    text: "Work isn't done without tests, monitoring, a way to roll back, and a named person who gets paged. Status means remaining work and risks, not percent complete. When something breaks at 3 a.m., I pick up. When something breaks, the people affected hear the truth first, and the fix changes what happens next time.",
  },
  aim: {
    lead: "What I'm building toward.",
    text: "Owning a product team end to end: the build as well as the run.",
  },
  location: "Toronto, Canada",
  // null = not rendered.
  links: {
    linkedin: "https://www.linkedin.com/in/ssvikrant/",
    email: "mailto:contact@vikrantsingh.fyi" as string | null,
    medium: "https://medium.com/@svikrant" as string | null,
    github: "https://github.com/vikiscoding" as string | null,
    // Web copy: mobile number and personal Gmail removed; contact@vikrantsingh.fyi only.
    resume: "/resume.pdf" as string | null,
  },
  // "Proof you can open" (ADR-022, ADR-023). Pulse run (client-side signal) and Ludo (server-side interaction latency,
  // ADR-026) are folded into the reliability item, so the proof stays at four items.
  // Never point Atlas Flow at the Incident-AI videos; its repo is in a private client organisation.
  proof: [
    {
      title: "This site's reliability",
      chip: "Live",
      text: "Two service level objectives with live error budgets; an outside probe checks the site every five minutes. Two small games feed it real traffic: a 30-second runner measures what the browser experiences, and a multiplayer Ludo game measures how long every move takes on the server. I break it on purpose and publish what I find, and when a load test of my own took part of it down, I wrote that up too.",
      links: [
        { label: "Live reliability", href: "/reliability/" },
        { label: "Postmortem: game day", href: "/notes/postmortem-game-day-1/" },
        { label: "Postmortem: real incident", href: "/notes/postmortem-free-tier-writes/" },
        { label: "Play the games", href: "/play/" },
      ],
    },
    {
      title: "Incident desk",
      chip: "Live",
      text: "Real alerts from this site go to an AI that proposes triage and drafts updates. Drafts are never sent; resolving and closing are always a person's call, and since 1 Oct 2026 so is priority, in public GitHub issues. If the model is down, the incident record still works.",
      scope: "a Python engine running one site's incidents, not ServiceNow.",
      links: [
        { label: "Watch the walkthrough (~14 min)", href: "https://youtu.be/j048FYXrRqs" },
        { label: "See it live", href: "/reliability/#incident-desk" },
        { label: "How it works", href: "/exhibits/incident-ai/" },
      ],
    },
    {
      // The owner's own business (ADR-023). Read-only review 1 Oct 2026: /scorecard scores six questions out of 12 with a
      // band and "where to tighten first"; the contact link carries the score, band and gaps, and the contact page
      // attaches them to the enquiry; Turnstile + /api/contact; MX via Cloudflare Email Routing. Never break it on purpose (ADR-008).
      title: "Balance-Books",
      chip: "Live",
      text: "A live bookkeeping site with a CRA readiness check: six questions, a score out of 12, and the areas to tighten first. If the visitor asks to talk, the contact form arrives with their score and gaps attached, so the context isn't lost. Bot protection with Cloudflare Turnstile, a serverless contact API, and business email through Cloudflare Email Routing.",
      scope: "a small business site; the check is a self-assessment, not tax advice.",
      links: [
        { label: "Try the CRA check", href: "https://balance-books.ca/scorecard" },
        { label: "Open the site", href: "https://balance-books.ca" },
      ],
    },
    {
      title: "Atlas Flow",
      text: "A live TypeScript/Node write path: web form, server-side validation, then a row written to SharePoint in production.",
      scope: "a marketing site, not a system with millions of members.",
      links: [{ label: "Open the live site", href: "https://atlasflowgroup.com" }],
    },
  ] satisfies Proof[],
  writingBlurb: "Short essays on putting AI into operations without losing track of who decides.",
} as const;
