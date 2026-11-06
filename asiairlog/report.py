"""Builds the self-contained HTML viewer from the parsed dataset."""
from __future__ import annotations

import json
from pathlib import Path

TEMPLATE_DIR = Path(__file__).parent / "templates"


def _read(name: str) -> str:
    return (TEMPLATE_DIR / name).read_text(encoding="utf-8")


def render_html(data: dict) -> str:
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    payload = payload.replace("</", "<\\/")  # keep </script> out of the JSON island
    html = _read("app.html")
    html = html.replace("/*__CSS__*/", _read("app.css"))
    html = html.replace("/*__JS__*/", _read("app.js"))
    html = html.replace("__DATA__", payload)
    return html


def build_report(data: dict, out_dir: Path, write_json: bool = False) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    index = out_dir / "index.html"
    index.write_text(render_html(data), encoding="utf-8")
    if write_json:
        (out_dir / "data.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    return index
