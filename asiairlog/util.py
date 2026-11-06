"""Small helpers shared by the parsers."""
from __future__ import annotations

import math
import re
from datetime import datetime

_RA_RE = re.compile(r"(-?\d+)h(\d+)m([\d.]+)s")
_DEC_RE = re.compile(r"([+-]?)(\d+)°(\d+)'([\d.]+)\"?")
_DUR_RE = re.compile(r"(?:(\d+)h)?(?:(\d+)min)?(?:([\d.]+)s)?")


def parse_autorun_dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y/%m/%d %H:%M:%S")


def parse_phd2_dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def parse_ra_hours(s: str) -> float | None:
    m = _RA_RE.match(s or "")
    if not m:
        return None
    h, mi, se = m.groups()
    return int(h) + int(mi) / 60 + float(se) / 3600


def parse_dec_deg(s: str) -> float | None:
    m = _DEC_RE.match(s or "")
    if not m:
        return None
    sign, d, mi, se = m.groups()
    v = int(d) + int(mi) / 60 + float(se) / 3600
    return -v if sign == "-" else v


def angular_sep_arcmin(ra1_h, dec1, ra2_h, dec2) -> float | None:
    """Great-circle separation between two equatorial positions, in arcminutes."""
    if None in (ra1_h, dec1, ra2_h, dec2):
        return None
    a1, d1 = math.radians(ra1_h * 15), math.radians(dec1)
    a2, d2 = math.radians(ra2_h * 15), math.radians(dec2)
    x = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2)
    x = max(-1.0, min(1.0, x))
    return math.degrees(math.acos(x)) * 60


def parse_duration_s(s: str) -> float | None:
    """'12min20s' / '1h5min' / '30s' -> seconds."""
    m = _DUR_RE.fullmatch(s.strip())
    if not m or not any(m.groups()):
        return None
    h, mi, se = m.groups()
    return (int(h or 0) * 3600) + (int(mi or 0) * 60) + float(se or 0)


def exposure_to_seconds(value: str, unit: str) -> float:
    v = float(value)
    return v / 1000 if unit == "ms" else v


def r3(x):
    """Round floats to 3 decimals for compact JSON; pass through None/ints."""
    if x is None:
        return None
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        return round(x, 3)
    return x


def linfit(points):
    """Least-squares line through (x, y) pairs -> (slope, intercept, r2) or None."""
    n = len(points)
    if n < 2:
        return None
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    den = n * sxx - sx * sx
    if abs(den) < 1e-12:
        return None
    slope = (n * sxy - sx * sy) / den
    intercept = (sy - slope * sx) / n
    ybar = sy / n
    ss_tot = sum((p[1] - ybar) ** 2 for p in points)
    ss_res = sum((p[1] - (slope * p[0] + intercept)) ** 2 for p in points)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 1.0
    return slope, intercept, r2


def rms(values) -> float | None:
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return math.sqrt(sum(v * v for v in vals) / len(vals))


def median(values) -> float | None:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    mid = n // 2
    return vals[mid] if n % 2 else (vals[mid - 1] + vals[mid]) / 2
