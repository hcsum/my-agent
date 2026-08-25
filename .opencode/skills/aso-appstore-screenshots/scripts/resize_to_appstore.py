#!/usr/bin/env python3
import argparse
import os
from PIL import Image


def parse_target(value):
    try:
        width, height = value.lower().split("x", 1)
        width = int(width)
        height = int(height)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("target must be WIDTHxHEIGHT") from exc
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("target dimensions must be positive")
    return width, height


def resized_path(input_path):
    root, ext = os.path.splitext(input_path)
    return f"{root}-resized{ext or '.png'}"


def resize_one(input_path, target):
    target_w, target_h = target
    image = Image.open(input_path).convert("RGB")
    width, height = image.size

    crop_w = round(height * target_w / target_h)
    crop_h = height

    if crop_w > width:
        crop_w = width
        crop_h = round(width * target_h / target_w)

    left = max(0, round((width - crop_w) / 2))
    top = 0
    right = left + crop_w
    bottom = top + crop_h

    cropped = image.crop((left, top, right, bottom))
    resized = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)
    output_path = resized_path(input_path)
    resized.save(output_path)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Crop and resize images to exact App Store dimensions.")
    parser.add_argument("--target", type=parse_target, required=True, help="Target size, e.g. 1290x2796")
    parser.add_argument("--inputs", nargs="+", required=True, help="Input image paths")
    args = parser.parse_args()

    for input_path in args.inputs:
        output_path = resize_one(input_path, args.target)
        with Image.open(output_path) as img:
            print(f"{output_path} {img.width}x{img.height}")


if __name__ == "__main__":
    main()
