#!/usr/bin/env python3
"""Builds web/public/brand/wordmark.svg: the "good" mark of GoodLeap's logo, "leap" and a small caption.

The letters of "leap" and of the caption are outlined from the font files, so the SVG draws the same
everywhere, including as an <img>, where the page's @font-face does not apply. The "good" paths are
taken from the logo file with its "HOME" group dropped; the orange swoosh keeps its gradients.

Usage: python3 -I scripts/build-wordmark.py --logo gl_logo_new.svg --leap-font sofia_semi_bold.otf \
         --caption-font sofia_semi_bold.otf [--out web/public/brand/wordmark.svg] [--scale 1.2]
Needs fontTools (pip install fonttools).
"""
import argparse
import re
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

# Measured on the logo: the baseline of "good" and the width of its right edge, in the logo's 73x64 box.
MARK_BASELINE = 24.35
MARK_LEFT, MARK_RIGHT = 0.56, 70.86
MARK_X_HEIGHT_UNITS = 16.55  # the "o" from its top to its bottom, overshoots included


def outline(font: TTFont, text: str, size: float, x: float, y: float, tracking: float = 0.0) -> tuple[str, float]:
    """The path data for `text` with its baseline at y, starting at x; returns the data and the end x."""
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    parts: list[str] = []
    cursor = x
    for char in text:
        name = cmap[ord(char)]
        if char != " ":
            pen = SVGPathPen(glyphs, ntos=lambda value: f"{value:.2f}".rstrip("0").rstrip("."))
            glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, y)))
            parts.append(pen.getCommands())
        cursor += font["hmtx"][name][0] * scale + tracking
    return "".join(parts), cursor


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("--logo", required=True, help="gl_logo_new.svg")
    args.add_argument("--leap-font", required=True, help="the font for 'leap'; Sofia Pro 600 matches the mark's stroke weight, Black is heavier")
    args.add_argument("--caption-font", required=True, help="the font for the caption (Sofia Pro 600)")
    args.add_argument("--out", default="web/public/brand/wordmark.svg")
    args.add_argument("--scale", type=float, default=1.2, help="px per logo unit")
    args.add_argument("--caption", default="PARTNER PORTAL")
    args.add_argument("--caption-px", type=float, default=11.0)
    args.add_argument("--gap", type=float, default=4.0, help="logo units between 'd' and 'l'")
    opts = args.parse_args()

    logo = Path(opts.logo).read_text()
    # Keep the paths that draw "good" (fill white or a gradient) and the gradients; drop the "HOME" path.
    paths = re.findall(r"<path [^>]*/>", logo)
    good = [p for p in paths if 'fill="white"' in p or "url(#" in p]
    good = [p for p in good if not p.startswith('<path d="M11.8186 47.9979')]  # HOME
    defs = re.search(r"<defs>.*?</defs>", logo, re.S).group(0)

    k = opts.scale
    leap_font = TTFont(opts.leap_font)
    # Size the font so its "o" matches the mark's "o"; the baselines then agree.
    o_bounds = leap_font.getGlyphSet()
    from fontTools.pens.boundsPen import BoundsPen

    pen = BoundsPen(o_bounds)
    o_bounds[leap_font.getBestCmap()[ord("o")]].draw(pen)
    em = leap_font["head"].unitsPerEm
    font_size_logo = MARK_X_HEIGHT_UNITS / ((pen.bounds[3] - pen.bounds[1]) / em)

    origin_x = -MARK_LEFT * k
    baseline = MARK_BASELINE * k
    leap_start = origin_x + (MARK_RIGHT + opts.gap) * k - 0.06 * font_size_logo * k  # the "l" has a left bearing
    leap_d, leap_end = outline(leap_font, "leap", font_size_logo * k, leap_start, baseline)

    caption_font = TTFont(opts.caption_font)
    cap_height = caption_font["OS/2"].sCapHeight / caption_font["head"].unitsPerEm * opts.caption_px
    mark_bottom = 32.2 * k
    caption_baseline = mark_bottom + 9 + cap_height
    caption_d, caption_end = outline(
        caption_font, opts.caption, opts.caption_px, 1.0, caption_baseline, tracking=opts.caption_px * 0.08
    )

    width = max(leap_end, caption_end) + 1
    height = caption_baseline + 2
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" viewBox="0 0 {width:.2f} {height:.2f}" fill="none" role="img" aria-label="GoodLeap Partner portal">
{defs}
<g transform="translate({origin_x:.3f} 0) scale({k})">
{chr(10).join(good)}
</g>
<path d="{leap_d}" fill="#ffffff"/>
<path d="{caption_d}" fill="#a9a4c9"/>
</svg>
"""
    Path(opts.out).write_text(svg)
    print(f"wrote {opts.out}: {width:.0f}x{height:.0f}px, leap font size {font_size_logo * k:.1f}px")


if __name__ == "__main__":
    main()
