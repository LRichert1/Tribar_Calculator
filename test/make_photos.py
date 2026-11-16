#!/usr/bin/env python3
"""Synthetic tribar photos for test/e2e.js (no real site photos in the repo).

    python3 test/make_photos.py OUTDIR     # needs numpy, scipy, opencv-python 4.x

Writes:
  spot-1..3.jpg   one photo of bars about 15% thinner than new, cropped three ways a few px
                  apart: the same spot photographed three times, for averaging
  far-off.jpg     much thinner bars (about 36%): a "different spot" for the spread warning
  low-amber.jpg   bars about 34 px apart: amber resolution warning
  low-red.jpg     bars about 24 px apart: red resolution warning
"""
import os, sys
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parity import synth  # noqa: E402

out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
big = synth(1640, 1240, 64, 0.40, 2.0, 1)
for i, (dx, dy) in enumerate([(0, 0), (9, 5), (17, 13)]):
    cv2.imwrite(os.path.join(out, 'spot-%d.jpg' % (i + 1)), big[dy:dy + 1200, dx:dx + 1600], [cv2.IMWRITE_JPEG_QUALITY, 92 - 3 * i])
    print('spot-%d.jpg 1600 x 1200 cropped at' % (i + 1), dx, dy)
PHOTOS = [
    ('far-off.jpg',   1600, 1200, 64, 0.30,  2.0, 4),
    ('low-amber.jpg', 1100,  825, 34, 0.40,  2.0, 5),
    ('low-red.jpg',    900,  675, 24, 0.40,  2.0, 6),
]
for name, W, H, pitch, ratio, angle, seed in PHOTOS:
    cv2.imwrite(os.path.join(out, name), synth(W, H, pitch, ratio, angle, seed), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(name, W, 'x', H, 'pitch', pitch, 'ratio', ratio)
