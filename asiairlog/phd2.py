"""Parser for PHD2 guide logs as written by ASIAIR (PHD2_GuideLog_YYYY-MM-DD_HHMMSS.txt)."""
from __future__ import annotations

import csv
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from .util import iso, parse_phd2_dt, r3, rms

FRAME_COLS = ["t", "dx", "dy", "ra_raw", "dec_raw", "ra_guide", "dec_guide", "ra_dur", "ra_dir", "dec_dur",
              "dec_dir", "mass", "snr", "err", "drop", "settling", "err_text", "runaway"]
DEFAULT_SEARCH_REGION_PX = 50.0
RUNAWAY_ARCSEC = 30.0      # star this far from the lock position is not being guided on
RUNAWAY_MIN_FRAMES = 3     # ...when it stays there for at least this many consecutive frames


@dataclass
class CalStep:
    direction: str
    step: int
    dx: float
    dy: float
    x: float
    y: float
    dist: float


@dataclass
class Calibration:
    start: datetime
    file: str
    line: int
    settings: dict = field(default_factory=dict)
    raw_header: list[str] = field(default_factory=list)
    steps: dict[str, list[CalStep]] = field(default_factory=dict)
    results: dict[str, dict] = field(default_factory=dict)
    complete: bool = False
    end: datetime | None = None

    @property
    def orthogonality_error(self):
        w = self.results.get("West") or self.results.get("East")
        n = self.results.get("North") or self.results.get("South")
        if not w or not n:
            return None
        diff = (n["angle"] - w["angle"]) % 180
        return abs(diff - 90)

    def to_dict(self):
        return {
            "start": iso(self.start), "end": iso(self.end), "file": self.file, "line": self.line,
            "settings": self.settings, "raw_header": self.raw_header, "complete": self.complete,
            "results": self.results,
            "orthogonality_error": r3(self.orthogonality_error),
            "steps": {d: [[s.step, r3(s.dx), r3(s.dy), r3(s.x), r3(s.y), r3(s.dist)] for s in steps]
                      for d, steps in self.steps.items()},
            "step_counts": {d: len(s) for d, s in self.steps.items()},
        }


@dataclass
class GuideFrame:
    n: int
    t: float
    mount: bool
    dx: float | None = None
    dy: float | None = None
    ra_raw: float | None = None
    dec_raw: float | None = None
    ra_guide: float | None = None
    dec_guide: float | None = None
    ra_dur: int | None = None
    ra_dir: str | None = None
    dec_dur: int | None = None
    dec_dir: str | None = None
    mass: float | None = None
    snr: float | None = None
    err: int | None = None
    err_text: str | None = None
    settling: bool = False
    runaway: bool = False  # star tracked outside the search region (probably the wrong star)

    def row(self):
        return [r3(self.t), r3(self.dx), r3(self.dy), r3(self.ra_raw), r3(self.dec_raw), r3(self.ra_guide),
                r3(self.dec_guide), self.ra_dur, self.ra_dir, self.dec_dur, self.dec_dir, r3(self.mass), r3(self.snr),
                self.err, 0 if self.mount else 1, 1 if self.settling else 0, self.err_text, 1 if self.runaway else 0]


@dataclass
class GuideEvent:
    t: float
    type: str
    text: str
    data: dict = field(default_factory=dict)

    def to_dict(self):
        return {"t": r3(self.t), "type": self.type, "text": self.text, "data": {k: r3(v) for k, v in self.data.items()}}


@dataclass
class GuideSection:
    start: datetime
    file: str
    line: int
    settings: dict = field(default_factory=dict)
    raw_header: list[str] = field(default_factory=list)
    frames: list[GuideFrame] = field(default_factory=list)
    events: list[GuideEvent] = field(default_factory=list)
    end: datetime | None = None
    ended_cleanly: bool = True
    stats: dict = field(default_factory=dict)

    @property
    def pixel_scale(self) -> float:
        return float(self.settings.get("pixel_scale") or 1.0)

    @property
    def duration_s(self) -> float:
        if self.end:
            return (self.end - self.start).total_seconds()
        return self.frames[-1].t if self.frames else 0.0

    def to_dict(self):
        return {
            "start": iso(self.start), "end": iso(self.end), "duration_s": r3(self.duration_s), "file": self.file,
            "line": self.line, "settings": self.settings, "raw_header": self.raw_header,
            "ended_cleanly": self.ended_cleanly, "stats": self.stats,
            "events": [e.to_dict() for e in self.events],
            "frame_cols": FRAME_COLS, "frames": [f.row() for f in self.frames],
        }


@dataclass
class Phd2File:
    path: Path
    version: str | None
    enabled_at: datetime | None
    calibrations: list[Calibration] = field(default_factory=list)
    sections: list[GuideSection] = field(default_factory=list)


_RX_VERSION = re.compile(r"^(PHD2 version[^,]*), Log version ([\d.]+)\. Log enabled at (\S+ \S+)")
_RX_CAL_BEGIN = re.compile(r"^Calibration Begins at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_RX_CAL_DIR_DONE = re.compile(r"^(\w+) calibration complete\. Angle = ([-\d.]+) deg, Rate = ([-\d.]+) px/sec, Parity = (\S+)")
_RX_CAL_DONE = re.compile(r"^Calibration complete, mount = (.+?)\.?$")
_RX_CAL_STEP = re.compile(r"^(West|East|North|South|Backlash),(\d+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)")
_RX_GUIDE_BEGIN = re.compile(r"^Guiding Begins at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_RX_GUIDE_END = re.compile(r"^Guiding Ends at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_RX_FRAME = re.compile(r"^\d+,[\d.]+,\"")
_RX_DITHER = re.compile(r"^INFO: DITHER by ([-\d.]+), ([-\d.]+), new lock pos = ([\d.]+), ([\d.]+)")
_RX_LOCK = re.compile(r"^INFO: SET LOCK POSITION, new lock pos = ([\d.]+), ([\d.]+)")

_SETTING_PATTERNS = [
    (re.compile(r"Dither = ([^,]+), Dither scale = ([\d.]+), Image noise reduction = ([^,]+), Guide-frame time lapse = (\d+)"),
     lambda m: {"dither_axes": m[1], "dither_scale": float(m[2]), "noise_reduction": m[3], "time_lapse": int(m[4])}),
    (re.compile(r"Pixel scale = ([\d.]+) arc-sec/px, Binning = (\d+), Focal length = (\d+) mm"),
     lambda m: {"pixel_scale": float(m[1]), "binning": int(m[2]), "focal_length_mm": int(m[3])}),
    (re.compile(r"Search region = (\d+) px, Star mass tolerance = ([\d.]+)%"),
     lambda m: {"search_region_px": int(m[1]), "mass_tolerance_pct": float(m[2])}),
    (re.compile(r"^Camera = ([^,]+)"), lambda m: {"camera": m[1].strip()}),
    (re.compile(r"gain = (\d+)"), lambda m: {"gain": int(m[1])}),
    (re.compile(r"full size = (\d+) x (\d+)"), lambda m: {"sensor_w": int(m[1]), "sensor_h": int(m[2])}),
    (re.compile(r"pixel size = ([\d.]+) um"), lambda m: {"pixel_size_um": float(m[1])}),
    (re.compile(r"^Exposure = (\d+) ms"), lambda m: {"exposure_ms": int(m[1])}),
    (re.compile(r"^Mount = ([^,]+),\s*Calibration Step = (\d+) ms, Assume orthogonal axes = (\w+)"),
     lambda m: {"mount": m[1].strip(), "cal_step_ms": int(m[2]), "assume_orthogonal": m[3]}),
    (re.compile(r"^Mount = ([^,]+),.*xAngle = ([-\d.]+), xRate = ([\d.]+), yAngle = ([-\d.]+), yRate = ([\d.]+), parity = (\S+)"),
     lambda m: {"mount": m[1].strip(), "x_angle": float(m[2]), "x_rate": float(m[3]), "y_angle": float(m[4]),
                "y_rate": float(m[5]), "parity": m[6].rstrip(",")}),
    (re.compile(r"^X guide algorithm = ([^,]+), (.*)$"), lambda m: {"ra_algo": m[1], "ra_algo_params": m[2].strip()}),
    (re.compile(r"^Y guide algorithm = ([^,]+), (.*)$"), lambda m: {"dec_algo": m[1], "dec_algo_params": m[2].strip()}),
    (re.compile(r"^Backlash comp = (\w+), pulse = (\d+) ms"), lambda m: {"backlash_comp": m[1], "backlash_pulse_ms": int(m[2])}),
    (re.compile(r"Max RA duration = (\d+), Max DEC duration = (\d+), DEC guide mode = (\w+)"),
     lambda m: {"max_ra_ms": int(m[1]), "max_dec_ms": int(m[2]), "dec_guide_mode": m[3]}),
    (re.compile(r"Cal Dec = ([-\d.]+), Last Cal Issue = ([^,]+)"), lambda m: {"cal_dec": float(m[1]), "last_cal_issue": m[2].strip()}),
    (re.compile(r"^Dec = ([-\d.]+) deg, Hour angle = ([-\d.]+) hr, Pier side = (\w+)"),
     lambda m: {"dec": float(m[1]), "hour_angle": float(m[2]), "pier_side": m[3]}),
    (re.compile(r"^Lock position = ([\d.]+), ([\d.]+), Star position = ([\d.]+), ([\d.]+), HFD = ([\d.]+) px"),
     lambda m: {"lock_x": float(m[1]), "lock_y": float(m[2]), "star_x": float(m[3]), "star_y": float(m[4]), "hfd": float(m[5])}),
    (re.compile(r"^Equipment Profile = (.*)$"), lambda m: {"profile": m[1].strip()}),
]

_RX_MINMOVE = re.compile(r"Minimum move = ([\d.]+)")
_RX_AGGR = re.compile(r"Aggression = ([\d.]+%?)")
_RX_HYST = re.compile(r"Hysteresis = ([\d.]+)")


def _parse_setting_line(line: str, settings: dict):
    for rx, fn in _SETTING_PATTERNS:
        m = rx.search(line)
        if m:
            settings.update(fn(m))
    if line.startswith("X guide algorithm"):
        mm, ag, hy = _RX_MINMOVE.search(line), _RX_AGGR.search(line), _RX_HYST.search(line)
        settings["ra_min_move"] = float(mm[1]) if mm else None
        settings["ra_aggression"] = ag[1] if ag else None
        settings["ra_hysteresis"] = float(hy[1]) if hy else None
    if line.startswith("Y guide algorithm"):
        mm, ag = _RX_MINMOVE.search(line), _RX_AGGR.search(line)
        settings["dec_min_move"] = float(mm[1]) if mm else None
        settings["dec_aggression"] = ag[1] if ag else None


def _fnum(s):
    s = s.strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _inum(s):
    v = _fnum(s)
    return int(v) if v is not None else None


def parse_phd2_file(path: Path) -> Phd2File:
    pf = Phd2File(path, None, None)
    cal: Calibration | None = None
    sec: GuideSection | None = None
    in_settle = False
    name = path.name

    def close_cal():
        nonlocal cal
        cal = None

    def close_sec(end: datetime | None, clean: bool):
        nonlocal sec, in_settle
        if sec:
            if end:
                sec.end = end
            elif sec.frames:
                sec.end = sec.start + timedelta(seconds=sec.frames[-1].t)
            else:
                sec.end = sec.start
            sec.ended_cleanly = clean
            sec.stats = compute_section_stats(sec)
        sec = None
        in_settle = False

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for ln, raw in enumerate(fh, 1):
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            if ln == 1:
                m = _RX_VERSION.match(line)
                if m:
                    pf.version = f"{m[1]} (log {m[2]})"
                    pf.enabled_at = parse_phd2_dt(m[3])
                    continue
            m = _RX_CAL_BEGIN.match(line)
            if m:
                close_sec(None, False)
                cal = Calibration(parse_phd2_dt(m[1]), name, ln)
                pf.calibrations.append(cal)
                continue
            m = _RX_GUIDE_BEGIN.match(line)
            if m:
                close_sec(None, False)
                close_cal()
                sec = GuideSection(parse_phd2_dt(m[1]), name, ln)
                pf.sections.append(sec)
                continue
            m = _RX_GUIDE_END.match(line)
            if m:
                close_sec(parse_phd2_dt(m[1]), True)
                continue

            if cal is not None:
                m = _RX_CAL_STEP.match(line)
                if m:
                    cal.steps.setdefault(m[1], []).append(
                        CalStep(m[1], int(m[2]), float(m[3]), float(m[4]), float(m[5]), float(m[6]), float(m[7])))
                    continue
                m = _RX_CAL_DIR_DONE.match(line)
                if m:
                    cal.results[m[1]] = {"angle": float(m[2]), "rate": float(m[3]), "parity": m[4]}
                    continue
                m = _RX_CAL_DONE.match(line)
                if m:
                    cal.complete = True
                    cal.settings.setdefault("mount", m[1])
                    last_steps = [s for steps in cal.steps.values() for s in steps]
                    cal.end = cal.start + timedelta(seconds=len(last_steps) * cal.settings.get("cal_step_ms", 2000) / 1000)
                    close_cal()
                    continue
                if line.startswith("Direction,Step"):
                    continue
                cal.raw_header.append(line)
                _parse_setting_line(line, cal.settings)
                continue

            if sec is not None:
                if _RX_FRAME.match(line):
                    row = next(csv.reader([line]))
                    n = int(row[0])
                    t = float(row[1])
                    mount = row[2] == "Mount"
                    f = GuideFrame(n, t, mount, settling=in_settle)
                    if mount and len(row) >= 18:
                        f.dx, f.dy = _fnum(row[3]), _fnum(row[4])
                        f.ra_raw, f.dec_raw = _fnum(row[5]), _fnum(row[6])
                        f.ra_guide, f.dec_guide = _fnum(row[7]), _fnum(row[8])
                        f.ra_dur, f.ra_dir = _inum(row[9]), (row[10].strip() or None)
                        f.dec_dur, f.dec_dir = _inum(row[11]), (row[12].strip() or None)
                        f.mass, f.snr, f.err = _fnum(row[15]), _fnum(row[16]), _inum(row[17])
                    else:
                        if len(row) >= 18:
                            f.mass, f.snr, f.err = _fnum(row[15]), _fnum(row[16]), _inum(row[17])
                        if len(row) >= 19:
                            f.err_text = row[18].strip()
                    sec.frames.append(f)
                    continue
                if line.startswith("INFO:"):
                    t_rel = sec.frames[-1].t if sec.frames else 0.0
                    if "Settling started" in line:
                        in_settle = True
                        sec.events.append(GuideEvent(t_rel, "settle_start", line))
                    elif "Settling complete" in line:
                        in_settle = False
                        sec.events.append(GuideEvent(t_rel, "settle_done", line))
                    elif "Settling failed" in line:
                        in_settle = False
                        sec.events.append(GuideEvent(t_rel, "settle_failed", line))
                    else:
                        m = _RX_DITHER.match(line)
                        if m:
                            sec.events.append(GuideEvent(t_rel, "dither", line, {
                                "dx": float(m[1]), "dy": float(m[2]), "lock_x": float(m[3]), "lock_y": float(m[4])}))
                        else:
                            m = _RX_LOCK.match(line)
                            if m:
                                sec.events.append(GuideEvent(t_rel, "lock", line,
                                                             {"lock_x": float(m[1]), "lock_y": float(m[2])}))
                            else:
                                sec.events.append(GuideEvent(t_rel, "info", line))
                    continue
                if line.startswith("Frame,Time,mount"):
                    continue
                sec.raw_header.append(line)
                _parse_setting_line(line, sec.settings)
                continue
    close_sec(None, False)
    return pf


def compute_section_stats(sec: GuideSection) -> dict:
    scale = sec.pixel_scale
    region = float(sec.settings.get("search_region_px") or DEFAULT_SEARCH_REGION_PX)
    # "Runaway" frames: the star is far from the lock position for several consecutive frames.
    # That is not guiding error but the guider following the wrong star (or a star that is
    # drifting away after a failed settle), so these frames are excluded from the RMS figures
    # and reported separately.
    thresh_px = min(region, max(3.0, RUNAWAY_ARCSEC / scale))
    run: list[GuideFrame] = []
    for f in sec.frames:
        far = f.mount and f.dx is not None and f.dy is not None and math.hypot(f.dx, f.dy) > thresh_px
        if far:
            run.append(f)
        else:
            if len(run) >= RUNAWAY_MIN_FRAMES:
                for r in run:
                    r.runaway = True
            run = []
    if len(run) >= RUNAWAY_MIN_FRAMES:
        for r in run:
            r.runaway = True
    runaway = [f for f in sec.frames if f.runaway]
    mount = [f for f in sec.frames if f.mount and not f.runaway]
    guided = [f for f in mount if not f.settling]
    drops = [f for f in sec.frames if not f.mount]

    def block(frames):
        ra = rms(f.ra_raw for f in frames)
        dec = rms(f.dec_raw for f in frames)
        tot = math.sqrt(ra * ra + dec * dec) if ra is not None and dec is not None else None
        return {
            "n": len(frames),
            "rms_ra_px": r3(ra), "rms_dec_px": r3(dec), "rms_tot_px": r3(tot),
            "rms_ra": r3(ra * scale) if ra is not None else None,
            "rms_dec": r3(dec * scale) if dec is not None else None,
            "rms_tot": r3(tot * scale) if tot is not None else None,
            "peak_ra": r3(max((abs(f.ra_raw) for f in frames if f.ra_raw is not None), default=None) * scale)
            if frames else None,
            "peak_dec": r3(max((abs(f.dec_raw) for f in frames if f.dec_raw is not None), default=None) * scale)
            if frames else None,
        }

    # star-lost events = runs of consecutive DROP frames
    lost_events = 0
    prev_drop = False
    reasons: dict[str, int] = {}
    for f in sec.frames:
        if not f.mount:
            if not prev_drop:
                lost_events += 1
            prev_drop = True
            if f.err_text:
                reasons[f.err_text] = reasons.get(f.err_text, 0) + 1
        else:
            prev_drop = False

    corr = {"ra_e_ms": 0, "ra_w_ms": 0, "dec_n_ms": 0, "dec_s_ms": 0, "ra_e_n": 0, "ra_w_n": 0, "dec_n_n": 0,
            "dec_s_n": 0}
    for f in mount:
        if f.ra_dur and f.ra_dir:
            key = "ra_e" if f.ra_dir == "E" else "ra_w"
            corr[key + "_ms"] += f.ra_dur
            corr[key + "_n"] += 1
        if f.dec_dur and f.dec_dir:
            key = "dec_n" if f.dec_dir == "N" else "dec_s"
            corr[key + "_ms"] += f.dec_dur
            corr[key + "_n"] += 1

    snrs = [f.snr for f in mount if f.snr]
    masses = [f.mass for f in mount if f.mass]
    stats = {
        "frames": len(sec.frames), "mount_frames": len(mount), "dropped": len(drops),
        "runaway_frames": len(runaway), "search_region_px": region, "runaway_arcsec": RUNAWAY_ARCSEC,
        "settling_frames": len(mount) - len(guided), "star_lost_events": lost_events, "drop_reasons": reasons,
        "guided": block(guided), "all": block(mount),
        "snr_mean": r3(sum(snrs) / len(snrs)) if snrs else None,
        "snr_min": r3(min(snrs)) if snrs else None,
        "mass_mean": r3(sum(masses) / len(masses)) if masses else None,
        "corrections": corr,
        "dithers": sum(1 for e in sec.events if e.type == "dither"),
        "settle_failed": sum(1 for e in sec.events if e.type == "settle_failed"),
        "pixel_scale": scale,
        "duration_s": r3(sec.duration_s),
        "exposure_ms": sec.settings.get("exposure_ms"),
    }
    return stats
