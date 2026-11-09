// sitemap.xml for search engines, built from the pages themselves so a new note or essay is listed without an edit
// here. A static file at build time; no package (AGENTS.md: prefer the platform). No <lastmod>: the build has no
// honest per-page date, and a wrong one is worse than none.
import type { APIRoute } from "astro";

// Pages that exist but are not public yet. atlas-flow is unlinked until its written walk exists (profile.ts).
const UNLISTED = new Set(["/exhibits/atlas-flow/"]);

const pages = Object.keys(import.meta.glob("./**/*.astro"));

function toPath(file: string): string | null {
  const rel = file.replace(/^\.\//, "").replace(/\.astro$/, "");
  if (rel.split("/").some((part) => part.startsWith("_") || part.includes("["))) return null;
  const route = rel === "index" ? "" : rel.replace(/\/?index$/, "");
  return route ? `/${route}/` : "/"; // build.format "directory": every page ends in a slash
}

export const GET: APIRoute = ({ site }) => {
  const paths = pages
    .map(toPath)
    .filter((p): p is string => p !== null && !UNLISTED.has(p))
    .sort();
  const urls = paths.map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
