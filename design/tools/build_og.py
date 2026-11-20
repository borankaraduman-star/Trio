"""Build the link-preview image of /indir: web/public/og/trio-og.png (1200x630).

Re-runnable: `python3 design/tools/build_og.py` from the repository root.
Needs Pillow and a bold sans font with Turkish letters (Inter, else DejaVu
Sans). The picture on the right is a REAL screenshot rendered by the e2e suite
(e2e/screenshots/v10-site-hero-window.png, from 77-site-general: the /indir
hero's main screen in its last picture, at 2x: a group's evening in #genel,
five people in the voice room, a reaction and a photo); the left is the mark
and the line.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SHOT = ROOT / "e2e" / "screenshots" / "v10-site-hero-window.png"
OUT = ROOT / "web" / "public" / "og" / "trio-og.png"

W, H = 1200, 630
BASE = (0x11, 0x13, 0x18)
SIDE = (0x17, 0x1A, 0x20)
BORDER = (0x2B, 0x30, 0x3A)
TEXT = (0xF2, 0xF1, 0xED)
MUTED = (0xA0, 0xA6, 0xB2)
CORAL = (0xEE, 0x99, 0x7F)
TEAL = (0x69, 0xB9, 0xAA)
AMBER = (0xDD, 0xB1, 0x74)

FONTS_BOLD = [
    "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
    "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONTS_REGULAR = [
    "/usr/share/fonts/opentype/inter/Inter-Medium.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise SystemExit(f"no font found among {candidates}")


def rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *image.size), radius, fill=255)
    out = image.convert("RGBA")
    out.putalpha(mask)
    return out


def main() -> None:
    S = 2  # draw at 2x, downsample once: smooth edges
    canvas = Image.new("RGB", (W * S, H * S), BASE)

    # A warm pool of light under the window, nothing else in the background.
    glow = Image.new("L", (W * S, H * S), 0)
    ImageDraw.Draw(glow).ellipse((560 * S, 120 * S, 1320 * S, 760 * S), fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(120 * S))
    canvas.paste(Image.new("RGB", canvas.size, CORAL), (0, 0), glow)

    # The window: the real screenshot (it carries its own title bar), its right edge running off the card.
    shot = Image.open(SHOT).convert("RGB")
    win_w = 700 * S
    scale = win_w / shot.width
    window = shot.resize((win_w, round(shot.height * scale)), Image.Resampling.LANCZOS)
    window = rounded(window, 18 * S)
    x, y = 540 * S, 66 * S
    shadow = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x, y + 30 * S, x + win_w, y + window.height + 30 * S), 18 * S, fill=200
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(36 * S))
    canvas.paste(Image.new("RGB", canvas.size, (0, 0, 0)), (0, 0), shadow)
    canvas.paste(window, (x, y), window)
    outline = ImageDraw.Draw(canvas)
    outline.rounded_rectangle((x, y, x + win_w, y + window.height), 18 * S, outline=BORDER, width=S)

    # The mark, the name, the line.
    d = ImageDraw.Draw(canvas)
    r = 15 * S
    mx, my = 72 * S, 84 * S
    for cx, cy in ((mx + r, my), (mx, my + round(r * 1.73)), (mx + 2 * r, my + round(r * 1.73))):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=CORAL)
    d.text((mx + 62 * S, my - 6 * S), "Trio", font=font(FONTS_BOLD, 46 * S), fill=TEXT, anchor="lt")

    title = font(FONTS_BOLD, 58 * S)
    d.text((70 * S, 212 * S), "Grubunun", font=title, fill=TEXT, anchor="ls")
    d.text((70 * S, 278 * S), "sohbeti,", font=title, fill=TEXT, anchor="ls")
    d.text((70 * S, 344 * S), "kendi", font=title, fill=CORAL, anchor="ls")
    d.text((70 * S, 410 * S), "sunucunda.", font=title, fill=CORAL, anchor="ls")

    small = font(FONTS_REGULAR, 24 * S)
    d.text((72 * S, 470 * S), "Yazı, sesli oda, ekran ve müzik.", font=small, fill=MUTED, anchor="ls")
    d.text((72 * S, 504 * S), "Davet koduyla, küçük gruplar için.", font=small, fill=MUTED, anchor="ls")
    for i, colour in enumerate((CORAL, TEAL, AMBER)):
        cx = (78 + i * 18) * S
        d.ellipse((cx - 5 * S, 548 * S - 5 * S, cx + 5 * S, 548 * S + 5 * S), fill=colour)

    canvas = canvas.resize((W, H), Image.Resampling.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, optimize=True)
    print(f"{OUT.relative_to(ROOT)}  {canvas.size[0]}x{canvas.size[1]}  {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
