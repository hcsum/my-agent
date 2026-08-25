#!/usr/bin/env python3
"""Tile a rendered set into one image, so a whole round can be reviewed at once.

    python3 contact_sheet.py out/*.png --output out/sheet.png
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


def sheet(paths, out, tile_h=900, gap=28, bg=(24, 20, 18), label=True):
    imgs = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        imgs.append((Path(p).stem, im.resize((round(im.width * tile_h / im.height), tile_h),
                                             Image.Resampling.LANCZOS)))
    pad = 40 if label else 0
    W = sum(im.width for _, im in imgs) + gap * (len(imgs) + 1)
    H = tile_h + gap * 2 + pad
    canvas = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(canvas)
    x = gap
    for name, im in imgs:
        canvas.paste(im, (x, gap))
        if label:
            d.text((x + im.width // 2, gap + tile_h + 12), name, fill=(210, 200, 190), anchor="ma")
        x += im.width + gap
    canvas.save(out)
    print(f"✓ {out} ({canvas.width}x{canvas.height})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--output", default="sheet.png")
    ap.add_argument("--height", type=int, default=900)
    args = ap.parse_args()
    sheet(sorted(args.images), args.output, tile_h=args.height)


if __name__ == "__main__":
    main()
