#!/usr/bin/env python3
"""ASIAIR log reader.

Parses the Autorun and PHD2 guide logs in an ASIAIR log directory, groups them into
imaging sessions and writes a self-contained HTML viewer.

    python3 asiair_logs.py /Volumes/asiair/log            # build output/index.html and open it
    python3 asiair_logs.py /Volumes/asiair/log --serve    # also serve it on http://localhost:8765
    python3 asiair_logs.py /Volumes/asiair/log --json     # also write output/data.json
"""
from __future__ import annotations

import argparse
import functools
import http.server
import sys
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from asiairlog.report import build_report  # noqa: E402
from asiairlog.sessions import build_dataset  # noqa: E402

DEFAULT_LOG_DIR = "/Volumes/asiair/log"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Parse ASIAIR Autorun + PHD2 guide logs into a session viewer.")
    ap.add_argument("log_dir", nargs="?", default=DEFAULT_LOG_DIR, help=f"ASIAIR log directory (default: {DEFAULT_LOG_DIR})")
    ap.add_argument("-o", "--out", default="output", help="output directory (default: ./output)")
    ap.add_argument("--gap-hours", type=float, default=5.0,
                    help="logs separated by more than this many idle hours start a new session (default: 5)")
    ap.add_argument("--json", action="store_true", help="also write data.json next to index.html")
    ap.add_argument("--no-open", action="store_true", help="do not open the result in a browser")
    ap.add_argument("--serve", nargs="?", const=8765, type=int, metavar="PORT",
                    help="serve the output directory over HTTP (default port 8765)")
    ap.add_argument("--quiet", action="store_true", help="less console output")
    args = ap.parse_args(argv)

    log_dir = Path(args.log_dir).expanduser()
    if not log_dir.is_dir():
        print(f"error: {log_dir} is not a directory (is the ASIAIR share mounted?)", file=sys.stderr)
        return 2
    out_dir = Path(args.out).expanduser()
    log = (lambda *a, **k: None) if args.quiet else print

    t0 = time.time()
    data = build_dataset(log_dir, gap_hours=args.gap_hours, log=log)
    index = build_report(data, out_dir, write_json=args.json)
    n_sessions = len(data["sessions"])
    lights = sum(s["summary"]["light_frames"] for s in data["sessions"])
    hours = sum(s["summary"]["light_integration_s"] or 0 for s in data["sessions"]) / 3600
    print(f"\n{n_sessions} sessions · {lights} light frames · {hours:.1f} h integration → {index} "
          f"({index.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.1f}s)")

    if args.serve:
        url = f"http://localhost:{args.serve}/index.html"
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(out_dir))
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.serve), handler)
        print(f"Serving {out_dir} at {url}  (Ctrl-C to stop)")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    if not args.no_open:
        webbrowser.open(index.resolve().as_uri())
    return 0


if __name__ == "__main__":
    sys.exit(main())
