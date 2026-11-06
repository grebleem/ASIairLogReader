"""Parser for ASIAIR Autorun logs (Autorun_Log_YYYY-MM-DD_HHMMSS.txt).

Two stages:
  1. parse_autorun_file()  -> flat list of timestamped Event objects with a machine-readable
     `kind` and parsed `data` fields.
  2. build_autorun_model() -> walks a (time-sorted) event list and reconstructs the
     structured objects: plans, autorun runs, sequences, frames, autofocus runs,
     auto-center attempts, meridian flips and guide settle records.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .util import (
    angular_sep_arcmin,
    exposure_to_seconds,
    iso,
    linfit,
    parse_autorun_dt,
    parse_dec_deg,
    parse_duration_s,
    parse_ra_hours,
    r3,
)


# --------------------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------------------
@dataclass
class Event:
    t: datetime
    kind: str
    cat: str
    level: str
    text: str
    file: str
    line: int
    source: str = "autorun"
    data: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            "t": iso(self.t),
            "kind": self.kind,
            "cat": self.cat,
            "level": self.level,
            "text": self.text,
            "src": self.source,
            "file": self.file,
            "line": self.line,
            "data": {k: r3(v) for k, v in self.data.items()},
        }


_TS = re.compile(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) (.*)$")
_LOG_ON = re.compile(r"^Log enabled at (\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})")
_LOG_OFF = re.compile(r"^Log disabled at (\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})")

# (regex, kind, cat, level, data-builder)
_RULES: list[tuple[re.Pattern, str, str, str, Any]] = []


def _rule(pattern, kind, cat, level="info", data=None):
    _RULES.append((re.compile(pattern), kind, cat, level, data))


_EXP = r"([\d.]+)(ms|s)"

_rule(r"^Plan (.+) Start$", "plan_start", "plan", "info", lambda m: {"plan": m[1]})
_rule(r"^Plan (.+) Finish$", "plan_finish", "plan", "success", lambda m: {"plan": m[1]})
_rule(r"^Pause Plan (.+)$", "plan_pause", "plan", "warn", lambda m: {"plan": m[1]})
_rule(r"^\[Autorun\|Begin\] (.+) Start$", "run_begin", "autorun", "info", lambda m: {"target": m[1]})
_rule(r"^\[Autorun\|End\] Finish Autorun$", "run_end", "autorun", "success", lambda m: {"reason": "finished"})
_rule(r"^\[Autorun\|End\] Pause Autorun$", "run_end", "autorun", "warn", lambda m: {"reason": "paused"})
_rule(r"^\[Autorun\|End\] (.+)$", "run_end", "autorun", "warn", lambda m: {"reason": m[1]})
_rule(r"^Stop Autorun Manually$", "autorun_stop_manual", "autorun", "warn")
_rule(r"^Target RA:(\S+) DEC:(\S+)$", "target", "mount", "info",
      lambda m: {"ra": m[1], "dec": m[2], "ra_h": parse_ra_hours(m[1]), "dec_deg": parse_dec_deg(m[2])})
_rule(r"^Mount slews to target position: RA:(\S+) DEC:(\S+)$", "slew", "mount", "info",
      lambda m: {"ra": m[1], "dec": m[2], "ra_h": parse_ra_hours(m[1]), "dec_deg": parse_dec_deg(m[2])})
_rule(r"^Shooting (\d+) (\w+) frames, auto-exposure Bin(\d+)$", "shooting", "sequence", "info",
      lambda m: {"count": int(m[1]), "type": m[2], "exposure_s": None, "auto": True, "bin": int(m[3])})
_rule(r"^Shooting (\d+) (\w+) frames, exposure " + _EXP + r" Bin(\d+)$", "shooting", "sequence", "info",
      lambda m: {"count": int(m[1]), "type": m[2], "exposure_s": exposure_to_seconds(m[3], m[4]), "auto": False,
                 "bin": int(m[5])})
_rule(r"^Filter change, (.+) change to (.+)$", "filter_change", "filter", "info",
      lambda m: {"from": m[1], "to": m[2]})
_rule(r"^Exposure " + _EXP + r" image (\d+)#$", "exposure", "exposure", "info",
      lambda m: {"exposure_s": exposure_to_seconds(m[1], m[2]), "image": int(m[3])})
_rule(r"^Exposure " + _EXP + r"$", "exposure_single", "exposure", "info",
      lambda m: {"exposure_s": exposure_to_seconds(m[1], m[2])})
_rule(r"^Plate Solve$", "plate_solve", "autocenter", "info")
_rule(r"^Solve succeeded: RA:(\S+) DEC:(\S+) Angle = ([-\d.]+), Star number = (\d+)$", "solve_result",
      "autocenter", "success",
      lambda m: {"ok": True, "ra": m[1], "dec": m[2], "ra_h": parse_ra_hours(m[1]), "dec_deg": parse_dec_deg(m[2]),
                 "angle": float(m[3]), "stars": int(m[4])})
_rule(r"^Solve failed.*$", "solve_result", "autocenter", "error", lambda m: {"ok": False})
_rule(r"^\[AutoCenter\|Begin\] Auto-Center (\d+)#$", "center_begin", "autocenter", "info",
      lambda m: {"attempt": int(m[1])})
_rule(r"^\[AutoCenter\|End\] The target is centered$", "center_end", "autocenter", "success",
      lambda m: {"ok": True, "result": "centered"})
_rule(r"^\[AutoCenter\|End\] Too far from center, distance = ([\d.]+)%\(([\d.]+)°\)$", "center_end", "autocenter",
      "warn", lambda m: {"ok": False, "result": "too far", "distance_pct": float(m[1]), "distance_deg": float(m[2])})
_rule(r"^\[AutoCenter\|End\] (.+)$", "center_end", "autocenter", "warn", lambda m: {"ok": False, "result": m[1]})
_rule(r"^Start Tracking$", "tracking_start", "mount", "info")
_rule(r"^Stop Tracking$", "tracking_stop", "mount", "info")
_rule(r"^Mount GoTo Home POS$", "mount_home", "mount", "info")
_rule(r"^Wait for Mount Settle$", "mount_settle_wait", "mount", "info")
_rule(r"^Turn Off Cooling$", "cooling_off", "camera", "info")
# Guiding
_rule(r"^\[Guide\] Stop Guiding$", "guide_stop", "guide", "info")
_rule(r"^\[Guide\] Stop Looping$", "guide_stop_looping", "guide", "info")
_rule(r"^\[Guide\] ReSelect Guide star$", "guide_reselect", "guide", "info")
_rule(r"^\[Guide\] Start Guiding$", "guide_start", "guide", "info")
_rule(r"^\[Guide\] Guide Settle$", "guide_settle", "guide", "info")
_rule(r"^\[Guide\] Settle Done$", "settle_done", "guide", "success")
_rule(r"^\[Guide\] Settle Timeout$", "settle_timeout", "guide", "warn")
_rule(r"^\[Guide\] Settle failed$", "settle_failed", "guide", "error")
_rule(r"^\[Guide\] Dither Settle$", "dither_settle", "guide", "info")
_rule(r"^\[Guide\] Dither$", "dither", "guide", "info")
_rule(r"^\[Guide\] Guide star lost$", "star_lost", "guide", "warn")
_rule(r"^\[Guide\] Select Guide Star failed.*$", "select_star_failed", "guide", "error")
_rule(r"^\[Guide\] (.+)$", "guide_other", "guide", "info", lambda m: {"msg": m[1]})
# Autofocus
_rule(r"^\[AutoFocus\|Begin\] (.*), exposure ([\d.]+)s Bin(\d+), temperature (-?[\d.]+)℃$", "af_begin", "autofocus",
      "info", lambda m: {"reason": m[1], "exposure_s": float(m[2]), "bin": int(m[3]), "temperature": float(m[4])})
_rule(r"^\[AutoFocus\|Begin\] (.*)$", "af_begin", "autofocus", "info", lambda m: {"reason": m[1]})
_rule(r"^Find Focus Star$", "af_find_star", "autofocus", "info")
_rule(r"^Find Focus Star: detect and calculate star size ([\d.]+) ,\s+EAF position (\d+)$", "af_star_measure",
      "autofocus", "info", lambda m: {"size": float(m[1]), "pos": int(m[2])})
_rule(r"^Find Focus Star: finding appropriate stars star size ([\d.]+)$", "af_star_search", "autofocus", "info",
      lambda m: {"size": float(m[1])})
_rule(r"^Calculate V-Curve$", "af_vcurve_begin", "autofocus", "info")
_rule(r"^Calculate V-Curve: detect and calculate star size ([\d.]+) ,\s+EAF position (\d+)$", "af_vcurve_point",
      "autofocus", "info", lambda m: {"size": float(m[1]), "pos": int(m[2])})
_rule(r"^Find Focus Point$", "af_focus_begin", "autofocus", "info")
_rule(r"^Calculate Focus Point: detect and calculate star size ([\d.]+) ,\s+EAF position (\d+)$", "af_focus_point",
      "autofocus", "info", lambda m: {"size": float(m[1]), "pos": int(m[2])})
_rule(r"^Auto focus succeeded, the focused position is (\d+)$", "af_result", "autofocus", "success",
      lambda m: {"ok": True, "pos": int(m[1])})
_rule(r"^Auto focus failed.*$", "af_result", "autofocus", "error", lambda m: {"ok": False})
_rule(r"^\[AutoFocus\|End\] Auto focus succeeded$", "af_end", "autofocus", "success", lambda m: {"ok": True})
_rule(r"^\[AutoFocus\|End\] (.+)$", "af_end", "autofocus", "error", lambda m: {"ok": False, "msg": m[1]})
_rule(r"^Start AF Manually$", "af_manual_start", "autofocus", "info")
_rule(r"^Cancel AF Manually$", "af_manual_cancel", "autofocus", "warn")
# Meridian flip
_rule(r"^\[Meridian Flip\|Begin\] Wait (\S+) to Meridian Flip$", "flip_begin", "flip", "info",
      lambda m: {"wait": m[1], "wait_s": parse_duration_s(m[1])})
_rule(r"^\[Meridian Flip\|Begin\] (.+)$", "flip_begin", "flip", "info", lambda m: {"msg": m[1]})
_rule(r"^Meridian Flip (\d+)# Start$", "flip_start", "flip", "info", lambda m: {"attempt": int(m[1])})
_rule(r"^\[Meridian Flip\|End\] Meridian Flip succeeded$", "flip_end", "flip", "success", lambda m: {"ok": True})
_rule(r"^\[Meridian Flip\|End\] (.+)$", "flip_end", "flip", "error", lambda m: {"ok": False, "msg": m[1]})


def classify(text: str):
    for rx, kind, cat, level, data in _RULES:
        m = rx.match(text)
        if m:
            d = data(m) if data else {}
            return kind, cat, level, d
    return "other", "other", "info", {}


def parse_autorun_file(path: Path) -> list[Event]:
    events: list[Event] = []
    name = path.name
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for ln, raw in enumerate(fh, 1):
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            m = _LOG_ON.match(line)
            if m:
                events.append(Event(parse_autorun_dt(m[1]), "log_enabled", "log", "info", line, name, ln))
                continue
            m = _LOG_OFF.match(line)
            if m:
                events.append(Event(parse_autorun_dt(m[1]), "log_disabled", "log", "info", line, name, ln))
                continue
            m = _TS.match(line)
            if not m:
                # Continuation / unknown line: attach to previous timestamp if any
                if events:
                    events.append(Event(events[-1].t, "other", "other", "info", line, name, ln))
                continue
            t = parse_autorun_dt(m[1])
            text = m[2].strip()
            kind, cat, level, data = classify(text)
            events.append(Event(t, kind, cat, level, text, name, ln, data=data))
    return events


# --------------------------------------------------------------------------------------
# Structured model
# --------------------------------------------------------------------------------------
@dataclass
class Frame:
    id: int
    image: int
    t: datetime
    exposure_s: float
    type: str
    bin: int
    filter: str | None
    target: str | None
    run_id: int | None
    seq_id: int | None
    end: datetime
    settle_s: float | None = None
    settle_result: str | None = None
    settle_kind: str | None = None
    star_lost: int = 0
    guide: dict | None = None  # filled in by sessions.py from PHD2 data

    def to_dict(self):
        return {
            "id": self.id, "image": self.image, "t": iso(self.t), "end": iso(self.end),
            "exposure_s": r3(self.exposure_s), "type": self.type, "bin": self.bin, "filter": self.filter,
            "target": self.target, "run_id": self.run_id, "seq_id": self.seq_id,
            "settle_s": r3(self.settle_s), "settle_result": self.settle_result, "settle_kind": self.settle_kind,
            "star_lost": self.star_lost, "guide": self.guide,
        }


@dataclass
class Sequence:
    id: int
    run_id: int | None
    t: datetime
    type: str
    count: int
    exposure_s: float | None
    auto: bool
    bin: int
    filter: str | None = None
    frames: list[int] = field(default_factory=list)

    def to_dict(self):
        return {"id": self.id, "run_id": self.run_id, "t": iso(self.t), "type": self.type, "count": self.count,
                "exposure_s": r3(self.exposure_s), "auto": self.auto, "bin": self.bin, "filter": self.filter,
                "frames": self.frames, "taken": len(self.frames)}


@dataclass
class Run:
    id: int
    target: str
    start: datetime
    plan: str | None
    end: datetime | None = None
    end_reason: str | None = None
    ra: str | None = None
    dec: str | None = None
    ra_h: float | None = None
    dec_deg: float | None = None
    sequences: list[int] = field(default_factory=list)
    frames: list[int] = field(default_factory=list)
    pointings: list[dict] = field(default_factory=list)
    stopped_manually: bool = False

    def to_dict(self):
        return {"id": self.id, "target": self.target, "plan": self.plan, "start": iso(self.start),
                "end": iso(self.end), "end_reason": self.end_reason, "ra": self.ra, "dec": self.dec,
                "ra_h": r3(self.ra_h), "dec_deg": r3(self.dec_deg), "sequences": self.sequences,
                "frames": self.frames, "pointings": self.pointings, "stopped_manually": self.stopped_manually}


@dataclass
class AutoFocus:
    id: int
    start: datetime
    reason: str
    trigger: str
    exposure_s: float | None
    bin: int | None
    temperature: float | None
    run_id: int | None
    target: str | None
    filter: str | None
    end: datetime | None = None
    result: str = "unknown"  # success | failed | cancelled | unknown
    start_pos: int | None = None
    start_size: float | None = None
    search: list[dict] = field(default_factory=list)
    vcurve: list[dict] = field(default_factory=list)
    focus_points: list[dict] = field(default_factory=list)
    final_pos: int | None = None
    final_size: float | None = None
    fit: dict | None = None

    def to_dict(self):
        dur = (self.end - self.start).total_seconds() if self.end else None
        return {"id": self.id, "start": iso(self.start), "end": iso(self.end), "duration_s": r3(dur),
                "reason": self.reason, "trigger": self.trigger, "exposure_s": self.exposure_s, "bin": self.bin,
                "temperature": self.temperature, "run_id": self.run_id, "target": self.target, "filter": self.filter,
                "result": self.result, "start_pos": self.start_pos, "start_size": self.start_size,
                "search": self.search, "vcurve": self.vcurve, "focus_points": self.focus_points,
                "final_pos": self.final_pos, "final_size": self.final_size, "fit": self.fit,
                "delta": (self.final_pos - self.start_pos) if (self.final_pos is not None and
                                                              self.start_pos is not None) else None}


@dataclass
class AutoCenter:
    id: int
    group: int
    attempt: int
    start: datetime
    run_id: int | None
    target: str | None
    end: datetime | None = None
    slew_ra: str | None = None
    slew_dec: str | None = None
    exposure_s: float | None = None
    solved: bool | None = None
    solved_ra: str | None = None
    solved_dec: str | None = None
    angle: float | None = None
    stars: int | None = None
    error_arcmin: float | None = None
    ok: bool | None = None
    result: str | None = None
    distance_pct: float | None = None
    distance_deg: float | None = None
    context: str = "slew"  # slew | flip

    def to_dict(self):
        return {"id": self.id, "group": self.group, "attempt": self.attempt, "start": iso(self.start),
                "end": iso(self.end), "run_id": self.run_id, "target": self.target, "slew_ra": self.slew_ra,
                "slew_dec": self.slew_dec, "exposure_s": self.exposure_s, "solved": self.solved,
                "solved_ra": self.solved_ra, "solved_dec": self.solved_dec, "angle": self.angle, "stars": self.stars,
                "error_arcmin": r3(self.error_arcmin), "ok": self.ok, "result": self.result,
                "distance_pct": self.distance_pct, "distance_deg": self.distance_deg, "context": self.context}


@dataclass
class MeridianFlip:
    id: int
    start: datetime
    run_id: int | None
    target: str | None
    wait_s: float | None
    end: datetime | None = None
    flip_start: datetime | None = None
    ok: bool | None = None
    attempts: int = 0
    centers: list[int] = field(default_factory=list)
    msg: str | None = None

    def to_dict(self):
        return {"id": self.id, "start": iso(self.start), "end": iso(self.end), "flip_start": iso(self.flip_start),
                "run_id": self.run_id, "target": self.target, "wait_s": self.wait_s, "ok": self.ok,
                "attempts": self.attempts, "centers": self.centers, "msg": self.msg,
                "duration_s": r3((self.end - self.start).total_seconds()) if self.end else None}


@dataclass
class Settle:
    id: int
    start: datetime
    kind: str  # dither | guide
    end: datetime | None = None
    result: str | None = None  # done | timeout | failed
    star_lost: int = 0

    def to_dict(self):
        return {"id": self.id, "start": iso(self.start), "end": iso(self.end), "kind": self.kind,
                "result": self.result, "star_lost": self.star_lost,
                "duration_s": r3((self.end - self.start).total_seconds()) if self.end else None}


@dataclass
class Plan:
    id: int
    name: str
    start: datetime
    end: datetime | None = None
    end_reason: str | None = None
    runs: list[int] = field(default_factory=list)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "start": iso(self.start), "end": iso(self.end),
                "end_reason": self.end_reason, "runs": self.runs}


def _af_trigger(reason: str) -> str:
    r = reason.lower()
    if "before autorun" in r:
        return "start"
    if "later" in r:
        return "periodic"
    if "filter" in r:
        return "filter"
    if "meridian" in r:
        return "flip"
    if "temperature" in r:
        return "temperature"
    if "manual" in r:
        return "manual"
    return "other"


def vcurve_fit(points: list[dict]) -> dict | None:
    """Fit two lines to the V-curve (left/right of the minimum) and intersect them.

    Returns the estimated best-focus position, slopes, per-side R² and the minimum sample.
    """
    pts = sorted(((p["pos"], p["size"]) for p in points if p["size"] > 0), key=lambda p: p[0])
    if len(pts) < 4:
        return None
    min_i = min(range(len(pts)), key=lambda i: pts[i][1])
    left = pts[: min_i + 1]
    right = pts[min_i:]
    fl = linfit(left) if len(left) >= 2 else None
    fr = linfit(right) if len(right) >= 2 else None
    out = {"min_pos": pts[min_i][0], "min_size": pts[min_i][1], "n": len(pts)}
    if fl and fr and abs(fl[0] - fr[0]) > 1e-9:
        x = (fr[1] - fl[1]) / (fl[0] - fr[0])
        y = fl[0] * x + fl[1]
        out.update({
            "best_pos": r3(x), "best_size": r3(y),
            "left_slope": r3(fl[0]), "left_r2": r3(fl[2]), "left_n": len(left),
            "right_slope": r3(fr[0]), "right_r2": r3(fr[2]), "right_n": len(right),
            "left_line": [r3(fl[0]), r3(fl[1])], "right_line": [r3(fr[0]), r3(fr[1])],
            "symmetry": r3(abs(fl[0]) / abs(fr[0])) if fr[0] else None,
        })
    return out


class AutorunModel:
    def __init__(self):
        self.plans: list[Plan] = []
        self.runs: list[Run] = []
        self.sequences: list[Sequence] = []
        self.frames: list[Frame] = []
        self.autofocus: list[AutoFocus] = []
        self.autocenter: list[AutoCenter] = []
        self.flips: list[MeridianFlip] = []
        self.settles: list[Settle] = []
        self.filters_seen: list[str] = []

    def to_dict(self):
        return {
            "plans": [p.to_dict() for p in self.plans],
            "runs": [r.to_dict() for r in self.runs],
            "sequences": [s.to_dict() for s in self.sequences],
            "frames": [f.to_dict() for f in self.frames],
            "autofocus": [a.to_dict() for a in self.autofocus],
            "autocenter": [c.to_dict() for c in self.autocenter],
            "flips": [f.to_dict() for f in self.flips],
            "settles": [s.to_dict() for s in self.settles],
            "filters": self.filters_seen,
        }


def build_autorun_model(events: list[Event], initial_filter: str | None = None) -> AutorunModel:
    """Reconstruct runs/frames/AF/etc. from a time-ordered Autorun event list."""
    m = AutorunModel()
    plan: Plan | None = None
    run: Run | None = None
    seq: Sequence | None = None
    cur_filter = initial_filter
    unknown_filter_frames: list[Frame] = []
    unknown_filter_seqs: list[Sequence] = []
    unknown_filter_afs: list[AutoFocus] = []
    af: AutoFocus | None = None
    af_phase: str | None = None
    center: AutoCenter | None = None
    center_group = 0
    flip: MeridianFlip | None = None
    settle: Settle | None = None
    pending_settle: Settle | None = None  # last completed settle, attached to the next frame
    last_target: Run | None = None

    def note_filter(name):
        if name and name not in m.filters_seen:
            m.filters_seen.append(name)

    def close_run(t, reason):
        nonlocal run, seq
        if run and run.end is None:
            run.end = t
            run.end_reason = reason
        run = None
        seq = None

    def close_af(t, result):
        nonlocal af, af_phase
        if af:
            af.end = t
            if af.result == "unknown":
                af.result = result
            if af.vcurve:
                af.fit = vcurve_fit(af.vcurve)
            if af.focus_points and af.final_size is None:
                af.final_size = af.focus_points[-1]["size"]
        af = None
        af_phase = None

    for ev in events:
        k, d, t = ev.kind, ev.data, ev.t

        if k == "plan_start":
            if plan and plan.end is None:
                plan.end = t
                plan.end_reason = "superseded"
            plan = Plan(len(m.plans), d["plan"], t)
            m.plans.append(plan)
        elif k in ("plan_finish", "plan_pause"):
            if plan is None:
                plan = Plan(len(m.plans), d["plan"], t)
                m.plans.append(plan)
            plan.end = t
            plan.end_reason = "finished" if k == "plan_finish" else "paused"
            plan = None

        elif k == "run_begin":
            if run and run.end is None:
                close_run(t, "interrupted")
            run = Run(len(m.runs), d["target"], t, plan.name if plan else None)
            m.runs.append(run)
            last_target = run
            if plan:
                plan.runs.append(run.id)
            seq = None
        elif k == "run_end":
            if run:
                close_run(t, d.get("reason", "ended"))
        elif k == "autorun_stop_manual":
            if run:
                run.stopped_manually = True

        elif k in ("target", "slew"):
            if run:
                if run.ra is None:
                    run.ra, run.dec, run.ra_h, run.dec_deg = d["ra"], d["dec"], d["ra_h"], d["dec_deg"]
                if k == "target":
                    run.pointings.append({"t": iso(t), "ra": d["ra"], "dec": d["dec"], "ra_h": r3(d["ra_h"]),
                                          "dec_deg": r3(d["dec_deg"])})
            if k == "slew" and center:
                center.slew_ra, center.slew_dec = d["ra"], d["dec"]

        elif k == "shooting":
            seq = Sequence(len(m.sequences), run.id if run else None, t, d["type"], d["count"], d["exposure_s"],
                           d["auto"], d["bin"], cur_filter)
            m.sequences.append(seq)
            if run:
                run.sequences.append(seq.id)
            if cur_filter is None:
                unknown_filter_seqs.append(seq)

        elif k == "filter_change":
            # Back-fill anything recorded before the first known filter change.
            if cur_filter is None:
                for fr in unknown_filter_frames:
                    fr.filter = d["from"]
                for s in unknown_filter_seqs:
                    s.filter = d["from"]
                for a in unknown_filter_afs:
                    a.filter = d["from"]
                note_filter(d["from"])
            unknown_filter_frames.clear()
            unknown_filter_seqs.clear()
            unknown_filter_afs.clear()
            cur_filter = d["to"]
            note_filter(cur_filter)
            # A "Shooting" line is followed by its filter change, so the sequence takes the new filter.
            if seq and not seq.frames and seq.t >= t - timedelta(seconds=5):
                seq.filter = cur_filter

        elif k == "exposure":
            exp = d["exposure_s"]
            ftype = seq.type if seq else "light"
            fbin = seq.bin if seq else 1
            fr = Frame(len(m.frames), d["image"], t, exp, ftype, fbin, cur_filter,
                       run.target if run else (last_target.target if last_target else None),
                       run.id if run else None, seq.id if seq else None, t + timedelta(seconds=exp))
            if pending_settle:
                fr.settle_s = (pending_settle.end - pending_settle.start).total_seconds()
                fr.settle_result = pending_settle.result
                fr.settle_kind = pending_settle.kind
                pending_settle = None
            m.frames.append(fr)
            if run:
                run.frames.append(fr.id)
            if seq:
                seq.frames.append(fr.id)
            if cur_filter is None:
                unknown_filter_frames.append(fr)
        elif k == "exposure_single":
            if center and center.exposure_s is None:
                center.exposure_s = d["exposure_s"]

        # ---- Auto-center -------------------------------------------------------------
        elif k == "center_begin":
            if d["attempt"] == 1 or center is None:
                center_group += 1
            center = AutoCenter(len(m.autocenter), center_group, d["attempt"], t, run.id if run else None,
                                run.target if run else None, context="flip" if flip and flip.end is None else "slew")
            m.autocenter.append(center)
            if flip and flip.end is None:
                flip.centers.append(center.id)
                flip.attempts += 1
        elif k == "solve_result":
            if center:
                center.solved = d["ok"]
                if d["ok"]:
                    center.solved_ra, center.solved_dec = d["ra"], d["dec"]
                    center.angle, center.stars = d["angle"], d["stars"]
                    tra = run.ra_h if run else None
                    tdec = run.dec_deg if run else None
                    if center.slew_ra:
                        tra, tdec = parse_ra_hours(center.slew_ra), parse_dec_deg(center.slew_dec)
                    center.error_arcmin = angular_sep_arcmin(tra, tdec, d["ra_h"], d["dec_deg"])
        elif k == "center_end":
            if center:
                center.end = t
                center.ok = d["ok"]
                center.result = d.get("result")
                center.distance_pct = d.get("distance_pct")
                center.distance_deg = d.get("distance_deg")
                center = None

        # ---- Meridian flip -----------------------------------------------------------
        elif k == "flip_begin":
            flip = MeridianFlip(len(m.flips), t, run.id if run else None, run.target if run else None,
                                d.get("wait_s"))
            m.flips.append(flip)
        elif k == "flip_start":
            if flip:
                flip.flip_start = t
        elif k == "flip_end":
            if flip:
                flip.end = t
                flip.ok = d["ok"]
                flip.msg = d.get("msg")
                flip = None

        # ---- Autofocus ---------------------------------------------------------------
        elif k == "af_begin":
            if af:
                close_af(t, "unknown")
            reason = d.get("reason", "")
            af = AutoFocus(len(m.autofocus), t, reason, _af_trigger(reason), d.get("exposure_s"), d.get("bin"),
                           d.get("temperature"), run.id if run else None,
                           run.target if run else (last_target.target if last_target else None), cur_filter)
            m.autofocus.append(af)
            if cur_filter is None:
                unknown_filter_afs.append(af)
            af_phase = "search"
        elif k == "af_manual_start":
            # A manual AF usually produces its own [AutoFocus|Begin]; if not, create a shell.
            pass
        elif k == "af_find_star":
            af_phase = "search"
        elif k == "af_star_measure":
            if af:
                if af.start_pos is None:
                    af.start_pos, af.start_size = d["pos"], d["size"]
                af.search.append({"pos": d["pos"], "size": d["size"], "t": iso(t)})
        elif k == "af_vcurve_begin":
            af_phase = "vcurve"
        elif k == "af_vcurve_point":
            if af:
                af.vcurve.append({"pos": d["pos"], "size": d["size"], "t": iso(t)})
        elif k == "af_focus_begin":
            af_phase = "focus"
        elif k == "af_focus_point":
            if af:
                af.focus_points.append({"pos": d["pos"], "size": d["size"], "t": iso(t)})
        elif k == "af_result":
            if af:
                af.result = "success" if d["ok"] else "failed"
                if d.get("pos") is not None:
                    af.final_pos = d["pos"]
        elif k == "af_manual_cancel":
            if af:
                af.result = "cancelled"
        elif k == "af_end":
            if af:
                close_af(t, "success" if d["ok"] else "failed")

        # ---- Guiding settle ----------------------------------------------------------
        elif k == "dither":
            settle = Settle(len(m.settles), t, "dither")
            m.settles.append(settle)
        elif k == "guide_settle":
            if settle is None or settle.end is not None:
                settle = Settle(len(m.settles), t, "guide")
                m.settles.append(settle)
        elif k in ("settle_done", "settle_timeout", "settle_failed"):
            if settle and settle.end is None:
                settle.end = t
                settle.result = {"settle_done": "done", "settle_timeout": "timeout", "settle_failed": "failed"}[k]
                pending_settle = settle
            settle = None
        elif k == "star_lost":
            if settle and settle.end is None:
                settle.star_lost += 1

    # Close anything left open
    final_t = events[-1].t if events else None
    if run and run.end is None and final_t:
        run.end = final_t
        run.end_reason = "log ended"
    if af and final_t:
        close_af(final_t, "unknown")
    if plan and plan.end is None and final_t:
        plan.end = final_t
        plan.end_reason = "log ended"

    # Star-lost counts per frame (Autorun-reported, during the exposure window)
    lost_times = [e.t for e in events if e.kind == "star_lost"]
    if lost_times:
        for fr in m.frames:
            fr.star_lost = sum(1 for lt in lost_times if fr.t <= lt <= fr.end)

    return m
