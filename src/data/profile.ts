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

/**
 * On-site notes, newest first. Listed above the essays; the bodies stay on their own pages.
 * Claims are the owner's one-line readings. "Decision", not "step": game day 1's note says an AI
 * triaged the alert and every decision after that stayed with a person.
 */
export interface SiteNote {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  claim: string;
  href: string;
}

export const siteNotes: SiteNote[] = [
  {
    title: "Dependencies we couldn't see, and the one inside the checker",
    date: "2026-10-04",
    claim: "If we can't read an expiry, we don't call it fine. That includes the checker's own.",
    href: "/notes/dependency-expiry-gaps/",
  },
  {
    title: "The failure list that lost its history",
    date: "2026-10-04",
    claim: "Nothing was lost. One cap was shared, and the wrong records filled it.",
    href: "/notes/failure-list-lost-history/",
  },
  {
    title: "When a load test used up the day's database writes",
    date: "2026-10-02",
    claim: "The failure looked like a choice. The logs said otherwise.",
    href: "/notes/postmortem-free-tier-writes/",
  },
  {
    title: "Game day 1",
    date: "2026-10-01",
    claim: "The site raised it. A human still made every decision after.",
    href: "/notes/postmortem-game-day-1/",
  },
];

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
// drafts are never sent by anyone.
// 3 Oct 2026: the CompuCom 55% and 35% figures came off this page. They were the owner's, not on the résumé,
// and the paragraph no longer states a magnitude for automation or restore time.
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
    "For the Government of Ontario, through CompuCom (2018–2021), I led a 15-person team supporting a 24x7 estate of 3,000+ servers, and was the subject-matter expert on its ServiceNow–Remedy integration. I was the person the client called on Sev-1 and Sev-2, and I ran the response through restore. We moved a large share of that volume onto automated resolution and shortened restore time by tightening the integration path and the runbooks around it.",
  ],
  principles: {
    lead: "What I hold a team to.",
    text: "Work isn't done without tests, monitoring, a way to roll back, and a named person who gets paged. Status means remaining work and risks, not percent complete. When something breaks at 3 a.m., I pick up. When something breaks, the people affected hear the truth first, and the fix changes what happens next time.",
  },
  aim: {
    lead: "What I'm building toward.",
    text: "Owning a product team end to end: the build as well as the run.",
  },
  // Minute walk above "Proof you can open". Not a fifth proof item (ADR-022, ADR-023): these four links
  // already exist. "Early readings" because the first 30-day window is still open (completes 30 Oct 2026);
  // this line must not read as a finished error budget. The free-tier line does not call that event an outage:
  // pages kept serving, and capacity is not paged (incident of 2 Oct 2026).
  shortPath: {
    heading: "A short path",
    lede: "If you only have a minute:",
    steps: [
      {
        label: "Live reliability",
        href: "/reliability/",
        text: "this site's own SLOs and error budgets (still early readings) and recent failures.",
      },
      {
        label: "When the write budget ran out",
        href: "/notes/postmortem-free-tier-writes/",
        text: "a load test of mine used up the day's database writes, and what changed after.",
      },
      {
        label: "Incident desk",
        // /issues alone is open-only, and every ticket so far is closed, so that page looks empty.
        // is:issue is the public record, open and closed, not a hand-picked subset.
        href: "https://github.com/vikiscoding/vikrant_perswebsite_incidents_aiengine/issues?q=is%3Aissue",
        text: "alerts land as public issues; an agent proposes, and a human authorizes every decision after that.",
      },
      {
        label: "Game day 1",
        href: "/notes/postmortem-game-day-1/",
        text: "a planned fault, already run, through detect, triage, and restore.",
      },
    ],
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
        { label: "Watch a live game day (~9 min)", href: "https://youtu.be/wdwIQ6LTs_Q" },
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
