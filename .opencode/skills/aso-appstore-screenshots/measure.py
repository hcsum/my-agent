#!/usr/bin/env python3
"""Pixel probes for cropping real UI out of a capture.

Guessing a corner radius by eye is how a breakout panel ends up with pale
slivers in its four corners: the mask is rounded tighter than the element it
was cut from, so the screen background behind it survives the crop. Measure it.

CLI:
    python3 measure.py capture.png --crop 42 1836 1163 2165
    python3 measure.py capture.png --bounds 0 1700 1206 2300
"""

import argparse

from PIL import Image


def _diff(a, b):
    return sum(abs(x - y) for x, y in zip(a[:3], b[:3]))


def corner_radius(img, box, tol=40, probe=90):
    """Radius of the top-left corner of the element occupying `box`.

    Walks down the left edge recording how far in the element starts, then
    solves the circle that fits those insets. Returns 0 for a square corner
    (a crop taken out of a solid interior region, for instance).
    """
    c = img.convert("RGB").crop(box)
    w, h = c.size
    bg = c.getpixel((min(w - 1, w // 2), 2))  # background sits just outside the corner
    samples = []
    for y in range(2, min(probe, h), 2):
        row = next((x for x in range(min(probe * 2, w)) if _diff(c.getpixel((x, y)), bg) <= tol), None)
        if row is not None:
            samples.append((y, row))
    inside = [(y, x) for y, x in samples if x > 0]
    if len(inside) < 3:
        return 0

    # inset(y) = r - sqrt(r^2 - (r - y)^2); solve for r at each sample, take the median
    fits = []
    for y, inset in inside:
        if inset <= 0 or y >= inset * 12:
            continue
        # r^2 - 2r(y + inset) + (y^2 + inset^2) = 0
        b = y + inset
        disc = b * b - (y * y + inset * inset)
        if disc <= 0:
            continue
        fits.append(b + disc ** 0.5)
    if not fits:
        return 0
    fits.sort()
    return round(fits[len(fits) // 2])


def content_bounds(img, box, tol=24):
    """Tight box of the non-background content inside `box`, in capture pixels.

    Use it to snap a hand-picked crop onto the real edges of a card or bubble.
    """
    c = img.convert("RGB").crop(box)
    w, h = c.size
    bg = c.getpixel((2, 2))
    xs, ys = [], []
    step = max(1, min(w, h) // 300)
    for y in range(0, h, step):
        for x in range(0, w, step):
            if _diff(c.getpixel((x, y)), bg) > tol:
                xs.append(x)
                ys.append(y)
    if not xs:
        return box
    return (box[0] + min(xs), box[1] + min(ys), box[0] + max(xs) + 1, box[1] + max(ys) + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--crop", nargs=4, type=int, help="x0 y0 x1 y1: report its corner radius")
    ap.add_argument("--bounds", nargs=4, type=int, help="x0 y0 x1 y1: tighten onto real content")
    args = ap.parse_args()

    img = Image.open(args.image)
    if args.crop:
        print(f"corner radius: {corner_radius(img, tuple(args.crop))} px")
    if args.bounds:
        print("content bounds:", content_bounds(img, tuple(args.bounds)))


if __name__ == "__main__":
    main()
