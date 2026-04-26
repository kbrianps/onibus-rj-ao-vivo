#!/usr/bin/env python3
"""
Build worker/data/routes.json from a Rio GTFS feed.

Usage:
  curl -L -o /tmp/gtfs-rio.zip "https://hub.tumidata.org/dataset/d0978152-4bbc-4162-810b-7478c9f2b0f7/resource/f1b70820-9c4a-4295-bc98-c9beb04ba457/download/rdj.zip"
  cd /tmp && unzip -o gtfs-rio.zip routes.txt trips.txt shapes.txt
  python3 scripts/build-routes.py /tmp/trips.txt /tmp/shapes.txt worker/data/routes.json

Process:
  1. Reads trips.txt and shapes.txt from a GTFS feed.
  2. Maps trip_short_name (= SPPO line, e.g. "104") to its set of shape_ids.
  3. Reconstructs each shape as an ordered list of [lat, lng] points.
  4. Simplifies each polyline with Ramer-Douglas-Peucker (~15m tolerance).
  5. Writes the result as compact JSON.
"""

import csv
import json
import math
import os
import sys
from collections import defaultdict

EPS = 0.00013  # ~15m in WGS84 degrees
PRECISION = 5


def perp_distance(pt, line_start, line_end):
    x0, y0 = pt
    x1, y1 = line_start
    x2, y2 = line_end
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x0 - x1, y0 - y1)
    num = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1)
    den = math.hypot(dx, dy)
    return num / den


def rdp(points, epsilon):
    if len(points) < 3:
        return points
    dmax = 0
    index = 0
    for i in range(1, len(points) - 1):
        d = perp_distance(points[i], points[0], points[-1])
        if d > dmax:
            dmax = d
            index = i
    if dmax > epsilon:
        left = rdp(points[: index + 1], epsilon)
        right = rdp(points[index:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]


def main(trips_path, shapes_path, output_path):
    line_shapes = defaultdict(set)
    with open(trips_path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            line = (r.get("trip_short_name") or "").strip().upper()
            shape_id = (r.get("shape_id") or "").strip()
            if line and shape_id:
                line_shapes[line].add(shape_id)

    shape_points = defaultdict(list)
    with open(shapes_path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            sid = r["shape_id"]
            seq = int(r["shape_pt_sequence"])
            lat = float(r["shape_pt_lat"])
            lng = float(r["shape_pt_lon"])
            shape_points[sid].append((seq, lat, lng))

    for sid in shape_points:
        shape_points[sid].sort()
        shape_points[sid] = [[p[1], p[2]] for p in shape_points[sid]]

    output = {}
    total_before, total_after = 0, 0
    for line, sids in line_shapes.items():
        polylines = []
        for sid in sids:
            if sid in shape_points:
                pts = shape_points[sid]
                total_before += len(pts)
                simp = rdp(pts, EPS)
                simp = [[round(p[0], PRECISION), round(p[1], PRECISION)] for p in simp]
                total_after += len(simp)
                polylines.append(simp)
        if polylines:
            output[line] = polylines

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"), ensure_ascii=False)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    reduction = 100 * (1 - total_after / total_before) if total_before else 0
    print(f"lines: {len(output)}")
    print(f"points: {total_before} -> {total_after} ({reduction:.1f}% reduction)")
    print(f"output: {output_path} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
