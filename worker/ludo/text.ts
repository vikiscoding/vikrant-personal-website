// Text people type into Ludo (names and room chat), in any language. Pure functions, so they are unit-testable
// outside the Workers runtime. Rule: keep everything a script or emoji needs (combining marks, zero-width joiners,
// direction marks); remove only control characters and the bidi overrides that can visually spoof text.

export const CHAT_MAX_CHARS = 200;

/** Display names in any script: letters with their combining marks (needed by Hindi, Thai, …), digits, spaces, - _ . '
 *  and the zero-width (non-)joiners Persian and Indic scripts need. At most 16 visible characters. Kept in the room only. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.'\u200C\u200D-]*$/u;
const NAME_MAX_CHARS = 16;
/** Bidi embedding and override characters: they can visually reorder text to spoof it, and no language needs them typed. */
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** What a reader counts as characters (graphemes): "नमस्ते" is 4, and a family emoji (three people joined by zero-width joiners) is 1. */
const visibleLength = (s: string) => [...segmenter.segment(s)].length;

export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").replace(BIDI_OVERRIDES, "").replace(/\s+/g, " ").trim();
  return NAME.test(s) && visibleLength(s) <= NAME_MAX_CHARS && s.length <= 64 ? s : null;
}

/** Chat text in any language: control characters and bidi overrides removed; joiners, direction marks and combining marks
 *  kept, because scripts and emoji need them. Whitespace collapsed; 1–200 visible characters, at most 1,500 code units. */
export function cleanChat(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(BIDI_OVERRIDES, "").replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= 1_500 && visibleLength(s) <= CHAT_MAX_CHARS ? s : null;
}
