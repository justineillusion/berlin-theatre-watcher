"""Fourchette de prix d'une pièce, seulement quand le site du lieu l'affiche.

Rien n'est deviné : pas de prix sur la page -> pas de ligne 💶 sur la fiche.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional, Tuple

_N = r"(\d{1,3}(?:[.,]\d{2})?)"
_CUR = r"(?:€|EUR\b|Euro\b|&euro;)"
# « 14 - 110 € », « 28 to 89 € », « 23,00 € - 98,00 € », « € 28 », « 18€ »
_RANGE = re.compile(_N + r"\s*" + _CUR + r"?\s*(?:-|–|—|to|bis|à)\s*" + _N + r"\s*" + _CUR, re.I)
_ONE = re.compile(_N + r"\s*" + _CUR + r"|" + _CUR + r"\s*" + _N, re.I)
_FREE = re.compile(r"admission free|free admission|eintritt frei|freier eintritt|entrée libre|kostenlos", re.I)

Range = Tuple[Optional[float], Optional[float]]


def parse_range(text: Optional[str]) -> Range:
    """« Tickets: 14 - 110 € » -> (14, 110) ; « 23,00 € » -> (23, 23) ; « Admission free » -> (0, 0).
    Sans « € » / « EUR » dans le texte : (None, None)."""
    if not text:
        return None, None
    if _FREE.search(text):
        return 0.0, 0.0
    vals = []
    for m in _RANGE.finditer(text):
        vals += [_f(m.group(1)), _f(m.group(2))]
    if not vals:
        vals = [_f(a or b) for a, b in _ONE.findall(text)]
    vals = [v for v in vals if 0 < v <= 1000]
    return (min(vals), max(vals)) if vals else (None, None)


def _f(x: str) -> float:
    return float(x.replace(",", "."))


def from_numbers(nums: Iterable[float]) -> Range:
    vals = [v for v in nums if 0 < v <= 1000]
    return (min(vals), max(vals)) if vals else (None, None)


def merge(ranges: Iterable[Range]) -> Range:
    ranges = list(ranges)
    los = [lo for lo, _ in ranges if lo is not None]
    his = [hi for _, hi in ranges if hi is not None]
    return (min(los) if los else None, max(his) if his else None)


def _eur(v: float) -> str:
    return f"{v:.0f}" if v == int(v) else f"{v:.2f}".replace(".", ",")


def label(lo: Optional[float], hi: Optional[float], lang: str = "fr", only_min: bool = False) -> Optional[str]:
    """« 14–110 € », « dès 28 € » (le site ne donne que le minimum), « Entrée libre »."""
    if lo is None and hi is None:
        return None
    lo = lo if lo is not None else hi
    hi = hi if hi is not None else lo
    if hi == 0:
        return "Free admission" if lang == "en" else "Entrée libre"
    if only_min:
        return f"from {_eur(lo)} €" if lang == "en" else f"dès {_eur(lo)} €"
    if lo == hi:
        return f"{_eur(lo)} €"
    return f"{_eur(lo)}–{_eur(hi)} €"
