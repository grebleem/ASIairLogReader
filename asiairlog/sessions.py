"""Discover log files, group them into imaging sessions and correlate Autorun with PHD2 data."""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from .autorun import AutorunModel, Event, build_autorun_model, parse_autorun_file
from .phd2 import Calibration, GuideSection, Phd2File, parse_phd2_file
from .util import iso, median, r3, rms


@dataclass
class Block:
    start: datetime
    end: datetime
    kind: str  # autorun | cal | guide
    payload: object


@dataclass
class Session:
    index: int
    start: datetime
    end: datetime
    autorun_events: list[Event] = field(default_factory=list)
    calibrations: list[Calibration] = field(default_factory=list)
    sections: list[GuideSection] = field(default_factory=list)
    autorun_files: list[str] = field(default_factory=list)
    phd2_files: list[str] = field(default_factory=list)
    model: AutorunModel | None = None
    events: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)
    issues: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.start.strftime("%Y%m%d-%H%M")

    def to_dict(self):
        return {
            "id": self.id, "index": self.index, "start": iso(self.start), "end": iso(self.end),
            "duration_s": r3((self.end - self.start).total_seconds()),
            "files": {"autorun": self.autorun_files, "phd2": self.phd2_files},
            "autorun": self.model.to_dict() if self.model else None,
            "guiding": {"calibrations": [c.to_dict() for c in self.calibrations],
                        "sections": [s.to_dict() for s in self.sections]},
            "events": self.events, "summary": self.summary, "issues": self.issues, "meta": self.meta,
        }


def discover(log_dir: Path) -> tuple[list[Path], list[Path]]:
    autorun, phd2 = [], []
    for p in sorted(log_dir.iterdir()):
        if not p.is_file() or p.name.startswith("._") or p.name.startswith("."):
            continue
        n = p.name
        if n.startswith("Autorun_Log_") and n.endswith(".txt") and not n.endswith("_CHN.txt"):
            autorun.append(p)
        elif n.startswith("PHD2_GuideLog_") and n.endswith(".txt"):
            phd2.append(p)
    return autorun, phd2


def _autorun_blocks(events: list[Event]) -> list[list[Event]]:
    blocks: list[list[Event]] = []
    cur: list[Event] = []
    for ev in events:
        if ev.kind == "log_enabled" and cur:
            blocks.append(cur)
            cur = []
        cur.append(ev)
    if cur:
        blocks.append(cur)
    return blocks


def group_sessions(autorun_paths: list[Path], phd2_paths: list[Path], gap_hours: float = 5.0,
                   log=print) -> list[Session]:
    blocks: list[Block] = []
    for p in autorun_paths:
        evs = parse_autorun_file(p)
        for b in _autorun_blocks(evs):
            blocks.append(Block(b[0].t, b[-1].t, "autorun", b))
        log(f"  autorun  {p.name}: {len(evs)} lines")
    phd2_files: list[Phd2File] = []
    for p in phd2_paths:
        pf = parse_phd2_file(p)
        phd2_files.append(pf)
        for c in pf.calibrations:
            blocks.append(Block(c.start, c.end or c.start, "cal", c))
        for s in pf.sections:
            blocks.append(Block(s.start, s.end or s.start, "guide", s))
        log(f"  phd2     {p.name}: {len(pf.calibrations)} calibrations, {len(pf.sections)} guiding sections, "
            f"{sum(len(s.frames) for s in pf.sections)} frames")

    blocks.sort(key=lambda b: b.start)
    gap = timedelta(hours=gap_hours)
    sessions: list[Session] = []
    cur: Session | None = None
    for b in blocks:
        if cur is None or b.start - cur.end > gap:
            cur = Session(len(sessions), b.start, b.end)
            sessions.append(cur)
        cur.end = max(cur.end, b.end)
        if b.kind == "autorun":
            cur.autorun_events.extend(b.payload)
            fname = b.payload[0].file
            if fname not in cur.autorun_files:
                cur.autorun_files.append(fname)
        elif b.kind == "cal":
            cur.calibrations.append(b.payload)
            if b.payload.file not in cur.phd2_files:
                cur.phd2_files.append(b.payload.file)
        else:
            cur.sections.append(b.payload)
            if b.payload.file not in cur.phd2_files:
                cur.phd2_files.append(b.payload.file)

    carried_filter: str | None = None
    for s in sessions:
        s.autorun_events.sort(key=lambda e: (e.t, e.file, e.line))
        s.model = build_autorun_model(s.autorun_events, initial_filter=carried_filter)
        changes = [e for e in s.autorun_events if e.kind == "filter_change"]
        s.meta["filter_carried"] = carried_filter is not None and not changes
        if changes:
            carried_filter = changes[-1].data["to"]
        s.meta["phd2_version"] = next((pf.version for pf in phd2_files if pf.path.name in s.phd2_files), None)
        _correlate_guiding(s)
        s.events = _merge_events(s)
        s.summary = _summarize(s)
        s.issues = _issues(s)
    return sessions


# --------------------------------------------------------------------------------------
# Correlation: guiding quality during each exposure
# --------------------------------------------------------------------------------------
def _correlate_guiding(s: Session):
    if not s.model or not s.sections:
        return
    ts: list[float] = []
    rows: list[tuple] = []  # (ra_raw, dec_raw, drop, settling, section_index)
    for si, sec in enumerate(s.sections):
        base = sec.start.timestamp()
        for f in sec.frames:
            ts.append(base + f.t)
            rows.append((f.ra_raw, f.dec_raw, not f.mount, f.settling, si, f.runaway))
    order = sorted(range(len(ts)), key=lambda i: ts[i])
    ts = [ts[i] for i in order]
    rows = [rows[i] for i in order]

    for fr in s.model.frames:
        t0, t1 = fr.t.timestamp(), fr.end.timestamp()
        i0, i1 = bisect.bisect_left(ts, t0), bisect.bisect_right(ts, t1)
        if i1 <= i0:
            fr.guide = None
            continue
        win = rows[i0:i1]
        guided = [r for r in win if not r[2] and not r[3] and not r[5]]
        drops = [r for r in win if r[2]]
        runaway = sum(1 for r in win if r[5])
        secs = sorted({r[4] for r in win})
        scale = s.sections[secs[0]].pixel_scale if secs else 1.0
        ra = rms(r[0] for r in guided)
        dec = rms(r[1] for r in guided)
        tot = math.sqrt(ra * ra + dec * dec) if ra is not None and dec is not None else None
        lost_events, prev = 0, False
        for r in win:
            if r[2] and not prev:
                lost_events += 1
            prev = r[2]
        exp_ms = s.sections[secs[0]].settings.get("exposure_ms") or 500
        coverage = min(1.0, (len(win) * exp_ms / 1000) / fr.exposure_s) if fr.exposure_s > 0 else None
        fr.guide = {
            "n": len(win), "guided_n": len(guided), "dropped": len(drops), "runaway": runaway,
            "star_lost_events": lost_events,
            "rms_ra": r3(ra * scale) if ra is not None else None,
            "rms_dec": r3(dec * scale) if dec is not None else None,
            "rms_tot": r3(tot * scale) if tot is not None else None,
            "peak_ra": r3(max((abs(r[0]) for r in guided), default=0) * scale) if guided else None,
            "peak_dec": r3(max((abs(r[1]) for r in guided), default=0) * scale) if guided else None,
            "coverage": r3(coverage), "sections": secs,
        }


# --------------------------------------------------------------------------------------
# Merged event log
# --------------------------------------------------------------------------------------
def _merge_events(s: Session) -> list[dict]:
    out = [e.to_dict() for e in s.autorun_events]

    def add(t, kind, cat, level, text, file, data=None):
        out.append({"t": iso(t), "kind": kind, "cat": cat, "level": level, "text": text, "src": "phd2",
                    "file": file, "line": 0, "data": data or {}})

    for c in s.calibrations:
        add(c.start, "cal_begin", "calibration", "info", "Calibration begins", c.file)
        if c.complete:
            w = c.results.get("West") or c.results.get("East") or {}
            n = c.results.get("North") or c.results.get("South") or {}
            add(c.end or c.start, "cal_done", "calibration", "success",
                f"Calibration complete: RA angle {w.get('angle')}°, rate {w.get('rate')} px/s · "
                f"DEC angle {n.get('angle')}°, rate {n.get('rate')} px/s", c.file)
        else:
            add(c.start, "cal_incomplete", "calibration", "warn", "Calibration not completed (aborted or restarted)",
                c.file)
    for i, sec in enumerate(s.sections):
        st = sec.stats.get("guided", {})
        add(sec.start, "guide_begin", "phd2", "info", f"Guiding begins (section {i + 1})", sec.file,
            {"section": i})
        base = sec.start
        prev_drop, run_start, run_n, run_reason = False, None, 0, None
        for f in sec.frames:
            if not f.mount:
                if not prev_drop:
                    run_start, run_n, run_reason = f.t, 0, f.err_text
                run_n += 1
                prev_drop = True
            else:
                if prev_drop:
                    add(base + timedelta(seconds=run_start), "phd2_star_lost", "phd2", "warn",
                        f"Star lost for {run_n} frame{'s' if run_n != 1 else ''} ({run_reason or 'unknown'})",
                        sec.file, {"section": i, "frames": run_n})
                prev_drop = False
        if prev_drop:
            add(base + timedelta(seconds=run_start), "phd2_star_lost", "phd2", "warn",
                f"Star lost for {run_n} frame{'s' if run_n != 1 else ''} ({run_reason or 'unknown'})", sec.file,
                {"section": i, "frames": run_n})
        for e in sec.events:
            if e.type == "dither":
                add(base + timedelta(seconds=e.t), "phd2_dither", "phd2", "info",
                    f"Dither by {e.data['dx']:+.2f}, {e.data['dy']:+.2f} px", sec.file, {"section": i})
            elif e.type == "settle_failed":
                add(base + timedelta(seconds=e.t), "phd2_settle_failed", "phd2", "error", "Settling failed",
                    sec.file, {"section": i})
        rms_txt = f" · RMS RA {st.get('rms_ra')}\" DEC {st.get('rms_dec')}\" total {st.get('rms_tot')}\"" \
            if st.get("rms_tot") is not None else ""
        add(sec.end or sec.start, "guide_end", "phd2", "info",
            f"Guiding ends (section {i + 1}, {sec.stats.get('mount_frames', 0)} frames{rms_txt})", sec.file,
            {"section": i})
    out.sort(key=lambda e: (e["t"], e["src"] != "autorun", e["line"]))
    return out


# --------------------------------------------------------------------------------------
# Summary & issues
# --------------------------------------------------------------------------------------
def _summarize(s: Session) -> dict:
    m = s.model
    frames = m.frames if m else []
    by_type: dict[str, int] = {}
    integ: dict[tuple, dict] = {}
    for f in frames:
        by_type[f.type] = by_type.get(f.type, 0) + 1
        if f.type == "light":
            key = (f.target or "?", f.filter or "?")
            d = integ.setdefault(key, {"target": key[0], "filter": key[1], "frames": 0, "seconds": 0.0})
            d["frames"] += 1
            d["seconds"] += f.exposure_s
    light = [f for f in frames if f.type == "light"]
    lights_guided = [f for f in light if f.guide and f.guide.get("rms_tot") is not None]

    afs = m.autofocus if m else []
    af_ok = [a for a in afs if a.result == "success"]
    settles = [x for x in (m.settles if m else []) if x.kind == "dither" and x.end]
    settle_d = [(x.end - x.start).total_seconds() for x in settles]

    # Overall guiding RMS weighted over all guided frames (excluding settling) in the session
    ra_sq, dec_sq, n = 0.0, 0.0, 0
    peak_ra = peak_dec = 0.0
    for sec in s.sections:
        sc = sec.pixel_scale
        for f in sec.frames:
            if f.mount and not f.settling and not f.runaway and f.ra_raw is not None and f.dec_raw is not None:
                ra_sq += (f.ra_raw * sc) ** 2
                dec_sq += (f.dec_raw * sc) ** 2
                n += 1
                peak_ra = max(peak_ra, abs(f.ra_raw * sc))
                peak_dec = max(peak_dec, abs(f.dec_raw * sc))
    g_ra = math.sqrt(ra_sq / n) if n else None
    g_dec = math.sqrt(dec_sq / n) if n else None
    g_tot = math.sqrt(g_ra ** 2 + g_dec ** 2) if n else None

    temps = [a.temperature for a in afs if a.temperature is not None]
    targets = []
    for r in (m.runs if m else []):
        if r.target not in targets:
            targets.append(r.target)
    plans = []
    for p in (m.plans if m else []):
        if p.name not in plans:
            plans.append(p.name)

    return {
        "targets": targets, "plans": plans,
        "frames_by_type": by_type,
        "light_frames": len(light),
        "light_integration_s": r3(sum(f.exposure_s for f in light)),
        "integration": sorted(integ.values(), key=lambda d: -d["seconds"]),
        "filters": m.filters_seen if m else [],
        "autofocus": {
            "runs": len(afs), "success": len(af_ok),
            "failed": sum(1 for a in afs if a.result == "failed"),
            "cancelled": sum(1 for a in afs if a.result == "cancelled"),
            "avg_duration_s": r3(sum((a.end - a.start).total_seconds() for a in afs if a.end) / len(afs))
            if afs else None,
            "positions": [a.final_pos for a in af_ok if a.final_pos is not None],
            "temp_min": min(temps) if temps else None, "temp_max": max(temps) if temps else None,
            "best_size": r3(min((a.final_size for a in af_ok if a.final_size is not None), default=None))
            if af_ok else None,
        },
        "guiding": {
            "sections": len(s.sections), "calibrations": len(s.calibrations),
            "calibrations_incomplete": sum(1 for c in s.calibrations if not c.complete),
            "guided_s": r3(sum(sec.duration_s for sec in s.sections)),
            "frames": sum(len(sec.frames) for sec in s.sections),
            "guided_frames": n,
            "dropped": sum(sec.stats.get("dropped", 0) for sec in s.sections),
            "star_lost_events": sum(sec.stats.get("star_lost_events", 0) for sec in s.sections),
            "rms_ra": r3(g_ra), "rms_dec": r3(g_dec), "rms_tot": r3(g_tot),
            "peak_ra": r3(peak_ra) if n else None, "peak_dec": r3(peak_dec) if n else None,
            "pixel_scale": s.sections[0].pixel_scale if s.sections else None,
            "median_frame_rms": r3(median(f.guide["rms_tot"] for f in lights_guided)) if lights_guided else None,
            "best_frame_rms": r3(min(f.guide["rms_tot"] for f in lights_guided)) if lights_guided else None,
            "worst_frame_rms": r3(max(f.guide["rms_tot"] for f in lights_guided)) if lights_guided else None,
        },
        "dithers": {
            "n": len(settles), "avg_settle_s": r3(sum(settle_d) / len(settle_d)) if settle_d else None,
            "max_settle_s": r3(max(settle_d)) if settle_d else None,
            "timeouts": sum(1 for x in settles if x.result == "timeout"),
            "failed": sum(1 for x in settles if x.result == "failed"),
        },
        "autocenter": {
            "attempts": len(m.autocenter) if m else 0,
            "groups": len({c.group for c in m.autocenter}) if m else 0,
            "failed": sum(1 for c in (m.autocenter if m else []) if c.ok is False),
            "avg_error_arcmin": r3(sum(c.error_arcmin for c in (m.autocenter if m else []) if c.error_arcmin is not None)
                                   / max(1, sum(1 for c in (m.autocenter if m else []) if c.error_arcmin is not None)))
            if m and any(c.error_arcmin is not None for c in m.autocenter) else None,
        },
        "flips": {"n": len(m.flips) if m else 0, "ok": sum(1 for f in (m.flips if m else []) if f.ok)},
        "star_lost_autorun": sum(1 for e in s.autorun_events if e.kind == "star_lost"),
        "runs": len(m.runs) if m else 0,
        "stopped_manually": sum(1 for r in (m.runs if m else []) if r.stopped_manually),
    }


def _issues(s: Session) -> list[dict]:
    out: list[dict] = []
    m = s.model

    def add(t, level, cat, text, ref=None):
        out.append({"t": iso(t), "level": level, "cat": cat, "text": text, "ref": ref})

    if m:
        for a in m.autofocus:
            if a.result == "failed":
                add(a.start, "error", "autofocus", f"Autofocus failed ({a.reason})", {"af": a.id})
            elif a.result == "cancelled":
                add(a.start, "warn", "autofocus", f"Autofocus cancelled manually ({a.reason})", {"af": a.id})
            elif a.result == "unknown":
                add(a.start, "warn", "autofocus", "Autofocus run did not report a result", {"af": a.id})
            elif a.fit and a.fit.get("best_pos") is not None and a.final_pos is not None \
                    and abs(a.fit["best_pos"] - a.final_pos) > 40:
                add(a.start, "info", "autofocus",
                    f"Autofocus chose {a.final_pos} but the V-curve fit suggests ~{round(a.fit['best_pos'])}",
                    {"af": a.id})
        for st in m.settles:
            if st.result == "timeout":
                add(st.start, "warn", "guide", f"Dither settle timed out after {(st.end - st.start).total_seconds():.0f}s")
            elif st.result == "failed":
                add(st.start, "error", "guide", "Settle failed" + (" (guide star lost)" if st.star_lost else ""))
        for c in m.autocenter:
            if c.ok is False:
                add(c.start, "warn", "autocenter",
                    f"Auto-center attempt {c.attempt}: {c.result}"
                    + (f" ({c.distance_deg}° off)" if c.distance_deg else ""))
            if c.solved is False:
                add(c.start, "error", "autocenter", f"Plate solve failed (attempt {c.attempt})")
        for f in m.flips:
            if f.ok is False:
                add(f.start, "error", "flip", f"Meridian flip failed: {f.msg or ''}")
        for r in m.runs:
            if r.end_reason == "interrupted":
                add(r.start, "warn", "autorun", f"Run '{r.target}' was interrupted by a new run")
            if r.stopped_manually:
                add(r.end or r.start, "info", "autorun", f"Run '{r.target}' was stopped manually")
        for ev in s.autorun_events:
            if ev.kind == "select_star_failed":
                add(ev.t, "error", "guide", "Guide star selection failed: no star found")
        # Cluster star-lost events
        lost = [e.t for e in s.autorun_events if e.kind == "star_lost"]
        if lost:
            cl_start, cl_end, cnt = lost[0], lost[0], 1
            for t in lost[1:]:
                if t - cl_end <= timedelta(minutes=10):
                    cl_end, cnt = t, cnt + 1
                else:
                    add(cl_start, "warn", "guide", _lost_text(cnt, cl_start, cl_end))
                    cl_start, cl_end, cnt = t, t, 1
            add(cl_start, "warn", "guide", _lost_text(cnt, cl_start, cl_end))
    for c in s.calibrations:
        if not c.complete:
            add(c.start, "warn", "calibration", "Calibration did not complete")
        else:
            oe = c.orthogonality_error
            if oe is not None and oe > 10:
                add(c.start, "warn", "calibration", f"Calibration axes are {oe:.1f}° from orthogonal")
            if c.settings.get("last_cal_issue") not in (None, "None"):
                add(c.start, "info", "calibration", f"Last calibration issue: {c.settings.get('last_cal_issue')}")
    for i, sec in enumerate(s.sections):
        st = sec.stats.get("guided", {})
        if st.get("rms_tot") is not None and st.get("n", 0) > 30 and st["rms_tot"] > 2.0:
            add(sec.start, "warn", "phd2", f"Guiding section {i + 1}: total RMS {st['rms_tot']:.2f}\" is high",
                {"section": i})
        if sec.stats.get("star_lost_events", 0) >= 5:
            add(sec.start, "warn", "phd2",
                f"Guiding section {i + 1}: star lost {sec.stats['star_lost_events']} times", {"section": i})
        if sec.stats.get("runaway_frames", 0) > 0:
            add(sec.start, "warn", "phd2",
                f"Guiding section {i + 1}: guide star was more than {sec.stats['runaway_arcsec']:.0f}\" from the lock "
                f"position for {sec.stats['runaway_frames']} frames (star drifted away or the wrong star was tracked); "
                f"those frames are excluded from RMS", {"section": i})
        if not sec.ended_cleanly:
            add(sec.end or sec.start, "info", "phd2", f"Guiding section {i + 1} ended without a 'Guiding Ends' record",
                {"section": i})
    out.sort(key=lambda d: d["t"])
    return out


def _lost_text(cnt, a, b):
    if cnt == 1:
        return f"Guide star lost at {a.strftime('%H:%M:%S')}"
    return f"Guide star lost {cnt} times between {a.strftime('%H:%M')} and {b.strftime('%H:%M')}"


def build_dataset(log_dir: Path, gap_hours: float = 5.0, log=print) -> dict:
    autorun_paths, phd2_paths = discover(log_dir)
    log(f"Scanning {log_dir}: {len(autorun_paths)} Autorun logs, {len(phd2_paths)} PHD2 guide logs")
    sessions = group_sessions(autorun_paths, phd2_paths, gap_hours, log=log)
    return {
        "generated_at": iso(datetime.now()),
        "source_dir": str(log_dir),
        "gap_hours": gap_hours,
        "files": {"autorun": [p.name for p in autorun_paths], "phd2": [p.name for p in phd2_paths]},
        "sessions": [s.to_dict() for s in sessions],
    }
