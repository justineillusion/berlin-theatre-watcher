"""Calendrier des ouvertures de vente (Vorverkauf) des théâtres.

Règles publiées par les théâtres (vérifiées le 8/11/2026) :
- Schaubühne (seiten/kartenverkauf.html) : « Vorverkaufsbeginn ist jeweils am 1. eines Monats
  für den Folgemonat » — 11:00 (ouverture de la caisse) ; dimanche / jour férié -> jour ouvré suivant
  (le samedi compte : la caisse ouvre du lundi au samedi).
- Berliner Ensemble (/karten) : « startet in der Regel am 3. Kalendertag des Vormonats um 10.00 Uhr » ;
  dimanche / jour férié -> décalé. Blocs d'environ 4 semaines.
- Volksbühne (/en/ticketinfos/) : « the 1st working day of the previous month » — heure non publiée.

Les exceptions existent (2 jan., 15 sept., 2 juin 14:00…) : une annonce sur la page du lieu
(« Vorverkauf … beginnt am 15. August um 14.00 Uhr ») l'emporte sur la règle.

    next_sale("schaubuhne", now) -> Sale(at=datetime Berlin | None, day=date, month="2027-01",
                                         hour_known=True, source="rule" | "page")
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Berlin")

# venue_id -> (jour du mois, heure ou None, jours ouvrés : "mon-sat" | "mon-fri", page d'infos)
RULES = {
    "schaubuhne": (1, time(11, 0), "mon-sat", "https://www.schaubuehne.de/de/seiten/kartenverkauf.html"),
    "berliner-ensemble": (3, time(10, 0), "mon-sat", "https://www.berliner-ensemble.de/karten"),
    "volksbuhne": (1, None, "mon-fri", "https://www.volksbuehne-berlin.de/en/ticketinfos/"),
}

_MONTHS = {m: i + 1 for i, m in enumerate(
    ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november",
     "dezember"])}
_MONTHS.update({m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
     "november", "december"])})
_MONTHS["maerz"] = 3


@dataclass
class Sale:
    venue_id: str
    day: date                    # jour d'ouverture
    at: Optional[datetime]       # jour + heure (Berlin) ; None si l'heure n'est pas publiée
    month: str                   # mois couvert, « 2027-01 »
    hour_known: bool
    source: str                  # "rule" | "page"

    def to_json(self) -> dict:
        d = asdict(self)
        d["day"] = self.day.isoformat()
        d["at"] = self.at.isoformat() if self.at else None
        return d


def _easter(y: int) -> date:
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return date(y, month, ((h + l - 7 * m + 114) % 31) + 1)


def berlin_holidays(y: int) -> set:
    e = _easter(y)
    return {date(y, 1, 1), date(y, 3, 8), date(y, 5, 1), date(y, 10, 3), date(y, 12, 25), date(y, 12, 26),
            e - timedelta(days=2), e + timedelta(days=1), e + timedelta(days=39), e + timedelta(days=50)}


def _workday(d: date, mode: str) -> bool:
    last = 5 if mode == "mon-sat" else 4
    return d.weekday() <= last and d not in berlin_holidays(d.year)


def _shift(d: date, mode: str) -> date:
    while not _workday(d, mode):
        d += timedelta(days=1)
    return d


def _add_month(y: int, m: int, n: int = 1) -> tuple:
    m += n
    return y + (m - 1) // 12, (m - 1) % 12 + 1


def _rule_day(venue_id: str, y: int, m: int) -> date:
    dom, _, mode, _ = RULES[venue_id]
    if venue_id == "volksbuhne":
        return _shift(date(y, m, 1), mode)          # 1er jour ouvré du mois
    return _shift(date(y, m, dom), mode)


_ANN = re.compile(
    r"(?:Vorverkauf\w*|advance (?:sale|booking)s?)[^.]{0,120}?(?:beginnt|startet|starts?|opens?|begins?)\s+"
    r"(?:am|on)\s+(?:\w+,?\s+)?(\d{1,2})\.?\s*(?:(\d{1,2})\.|([A-Za-zäÄ]+))\s*(\d{4})?"
    r"(?:[^.]{0,30}?(?:um|at)\s+(\d{1,2})(?:[.:h](\d{2}))?\s*(?:Uhr|h|a\.?m\.?|p\.?m\.?)?)?",
    re.I)


def parse_announcement(text: str, now: datetime) -> Optional[tuple]:
    """« Der Vorverkauf für September beginnt am 15. August um 14.00 Uhr » -> (date, time | None).
    Seulement une date FUTURE (une annonce passée ne dit rien de la prochaine vente)."""
    for m in _ANN.finditer(text or ""):
        day = int(m.group(1))
        month = int(m.group(2)) if m.group(2) else _MONTHS.get((m.group(3) or "").lower())
        if not month or not 1 <= day <= 31:
            continue
        year = int(m.group(4)) if m.group(4) else now.year
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if not m.group(4) and d < now.date():
            # « 2. Januar » lu en décembre = l'an prochain ; « 15. August » lu le 20 août = passée.
            if (now.date() - d).days < 180:
                continue
            d = date(year + 1, month, day)
        if d < now.date():
            continue
        t = time(int(m.group(5)), int(m.group(6) or 0)) if m.group(5) and int(m.group(5)) < 24 else None
        return d, t
    return None


def next_sale(venue_id: str, now: Optional[datetime] = None, page_texts: Iterable[str] = ()) -> Optional[Sale]:
    """Prochaine ouverture de vente (aujourd'hui compris tant que l'heure n'est pas passée)."""
    if venue_id not in RULES:
        return None
    now = (now or datetime.now(TZ)).astimezone(TZ)
    _, hour, _, _ = RULES[venue_id]
    for text in page_texts:
        ann = parse_announcement(text, now)
        if ann:
            d, t = ann
            t = t or hour
            at = datetime.combine(d, t, TZ) if t else None
            if at is None or at > now:
                y, m = _add_month(d.year, d.month)
                return Sale(venue_id, d, at, f"{y:04d}-{m:02d}", t is not None, "page")
    y, m = now.year, now.month
    for _ in range(3):
        d = _rule_day(venue_id, y, m)
        at = datetime.combine(d, hour, TZ) if hour else None
        upcoming = (at > now) if at else (d >= now.date())
        if upcoming:
            cy, cm = _add_month(d.year, d.month)
            return Sale(venue_id, d, at, f"{cy:04d}-{cm:02d}", hour is not None, "rule")
        y, m = _add_month(y, m)
    return None


def fetch_sales(venue_ids: Iterable[str], now: Optional[datetime] = None) -> dict:
    """{venue_id: Sale.to_json()} ; lit la page d'infos du lieu (annonces d'exceptions)."""
    from bs4 import BeautifulSoup

    from .fetch import fetch_html
    out = {}
    for vid in venue_ids:
        if vid not in RULES:
            continue
        texts = []
        try:
            texts.append(BeautifulSoup(fetch_html(RULES[vid][3]), "html.parser").get_text(" ", strip=True))
        except Exception:  # noqa: BLE001 — la règle suffit
            pass
        sale = next_sale(vid, now, texts)
        if sale:
            out[vid] = sale.to_json()
    return out
