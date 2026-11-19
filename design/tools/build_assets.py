"""Derive the shipped web/desktop assets from the generated originals.

One-off, re-runnable: `python3 design/tools/build_assets.py` from the repository
root. Needs Pillow (with WebP support) and nothing else. The originals live in
design/source/ and are never shipped; what this writes is what the client and
the desktop shell load.

  design/source/art/join.png        -> web/public/art/join.webp       (1600x1200, opaque)
  design/source/art/empty-chat.png  -> web/public/art/empty-chat.webp  (480x360, alpha)
  design/source/art/empty-voice.png -> web/public/art/empty-voice.webp (320x240, alpha)
  web/public/icon-512.png           -> web/public/apple-touch-icon.png (180, opaque)
  (drawn)                           -> web/public/favicon.png (64), favicon.svg
  desktop/build/icon.png            -> desktop/assets/icon-256.png (window icon, connect page)
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "design" / "source"
PUBLIC = ROOT / "web" / "public"

CORAL = (0xEE, 0x99, 0x7F)
BASE = (0x11, 0x13, 0x18)

# The chosen logo (concept A): three touching dots in a triangle. Measured on
# design/concepts/logo-a.png (1024 px): dot radius ~87, centres (512, 430),
# (418, 593), (605, 593). Normalised to a 0..1 box around the three dots.
DOT_R = 0.2405
DOTS = ((0.5, DOT_R), (0.2405, 0.6905), (0.7595, 0.6905))
#  ^ two dots of radius r side by side touch at x = 0.5; the top dot sits on
#    them: its centre is 2r * sin(60deg) above theirs (0.45 = 0.6905 - 0.2405).


def webp(src: Path, dst: Path, size: tuple[int, int], quality: int, clean_haze: bool = False) -> None:
    image = Image.open(src)
    image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    if clean_haze:
        # empty-voice.png carries a faint white glow (alpha up to ~55) around the
        # headphones; on the dark app it reads as a grey smudge. Drop near-white,
        # low-alpha pixels and the faintest shadow.
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                r, g, b, a = pixels[x, y]
                if a < 40 or (min(r, g, b) > 205 and a < 200):
                    pixels[x, y] = (0, 0, 0, 0)
    if image.size != size:
        image = image.resize(size, Image.Resampling.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if image.mode == "RGBA":
        image.save(dst, "WEBP", quality=quality, method=6, alpha_quality=90, exact=False)
    else:
        image.save(dst, "WEBP", quality=quality, method=6)


def favicon(size: int) -> Image.Image:
    """The dots filling the frame on a rounded dark tile: legible at 16 px."""
    scale = 8
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=big * 0.22, fill=BASE + (255,))
    pad = big * 0.12
    box = big - 2 * pad
    # The dot group is 1 wide and (0.6905 + r) tall; centre it vertically.
    height = (DOTS[1][1] + DOT_R) * box
    top = (big - height) / 2
    for cx, cy in DOTS:
        x, y, r = pad + cx * box, top + cy * box, DOT_R * box * 0.96
        draw.ellipse((x - r, y - r, x + r, y + r), fill=CORAL + (255,))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def favicon_svg() -> str:
    pad, box = 0.12 * 32, 0.76 * 32
    top = (32 - (DOTS[1][1] + DOT_R) * box) / 2
    circles = "".join(
        f'<circle cx="{pad + cx * box:.2f}" cy="{top + cy * box:.2f}" r="{DOT_R * box * 0.96:.2f}"/>'
        for cx, cy in DOTS
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<rect width="32" height="32" rx="7" fill="#111318"/>'
        f'<g fill="#EE997F">{circles}</g></svg>\n'
    )


def main() -> None:
    webp(SRC / "art" / "join.png", PUBLIC / "art" / "join.webp", (1600, 1200), 90)
    webp(SRC / "art" / "empty-chat.png", PUBLIC / "art" / "empty-chat.webp", (480, 360), 82)
    webp(SRC / "art" / "empty-voice.png", PUBLIC / "art" / "empty-voice.webp", (320, 240), 82, clean_haze=True)

    Image.open(PUBLIC / "icon-512.png").convert("RGB").resize((180, 180), Image.Resampling.LANCZOS).save(
        PUBLIC / "apple-touch-icon.png", optimize=True
    )
    favicon(64).save(PUBLIC / "favicon.png", optimize=True)
    (PUBLIC / "favicon.svg").write_text(favicon_svg())

    Image.open(ROOT / "desktop" / "build" / "icon.png").convert("RGB").resize(
        (256, 256), Image.Resampling.LANCZOS
    ).save(ROOT / "desktop" / "assets" / "icon-256.png", optimize=True)

    for path in sorted([*PUBLIC.glob("*.png"), *PUBLIC.glob("*.svg"), *(PUBLIC / "art").glob("*")]):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
