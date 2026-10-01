"""Brand assets (ADR-018): favicon set and the social share image.

Re-run whenever the headline changes, so the LinkedIn preview always matches the site (requirement R2):
    python scripts/make-brand-assets.py
Reads the headline from src/data/profile.ts and writes into public/. Needs Pillow and Segoe UI (Windows); the
fonts only rasterise the PNG, they are never shipped to visitors.
"""

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
ACCENT = (31, 95, 139)  # --accent (light theme)
BG = (251, 251, 249)  # --bg
FG = (27, 27, 26)  # --fg
MUTED = (93, 93, 88)  # --muted
FONTS = Path("C:/Windows/Fonts")

# The heartbeat glyph, in a 64-unit box: a flat line with one beat. Shared by every size.
BEAT = [(10, 34), (22, 34), (27, 22), (33, 46), (38, 30), (42, 34), (54, 34)]

FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1f5f8b"/>
  <polyline points="10,34 22,34 27,22 33,46 38,30 42,34 54,34" fill="none" stroke="#fff" stroke-width="5"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def glyph(size: int) -> Image.Image:
    scale = 4  # draw large, then downsample for clean anti-aliasing
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 14 / 64), fill=ACCENT + (255,))
    pts = [(x * s / 64, y * s / 64) for x, y in BEAT]
    d.line(pts, fill=(255, 255, 255, 255), width=max(2, int(s * 5 / 64)), joint="curve")
    r = int(s * 2.5 / 64)
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def headline() -> str:
    text = (ROOT / "src/data/profile.ts").read_text(encoding="utf-8")
    m = re.search(r'^\s*headline:\s*"([^"]+)"', text, re.M)
    if not m:
        raise SystemExit("headline not found in src/data/profile.ts")
    return m.group(1)


def wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def share_image() -> Image.Image:
    W, H, M = 1200, 630, 88
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    img.paste(glyph(76), (M, 84), glyph(76))
    bold = ImageFont.truetype(str(FONTS / "segoeuib.ttf"), 78)
    regular = ImageFont.truetype(str(FONTS / "segoeui.ttf"), 44)
    small = ImageFont.truetype(str(FONTS / "segoeui.ttf"), 30)
    d.text((M, 196), "Vikrant Singh", font=bold, fill=FG)
    y = 310
    for line in wrap(d, headline(), regular, W - 2 * M):
        d.text((M, y), line, font=regular, fill=FG)
        y += 58
    # Faint heartbeat trace above the footer: the site's theme, not decoration for its own sake.
    base, beat = 520, [(0, 0), (380, 0), (410, -40), (440, 36), (468, -18), (490, 0), (W - 2 * M, 0)]
    d.line([(M + x, base + yy) for x, yy in beat], fill=(205, 219, 229), width=4, joint="curve")
    d.text((M, 552), "vikrantsingh.fyi  ·  Live reliability  ·  Incident-AI  ·  Writing", font=small, fill=MUTED)
    return img


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    (PUBLIC / "favicon.svg").write_text(FAVICON_SVG, encoding="utf-8")
    glyph(180).save(PUBLIC / "apple-touch-icon.png")
    glyph(32).save(PUBLIC / "favicon-32.png")
    glyph(48).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    share_image().save(PUBLIC / "og.png", optimize=True)
    print("wrote favicon.svg, favicon.ico, favicon-32.png, apple-touch-icon.png, og.png")


if __name__ == "__main__":
    main()
