"""Mise en forme Telegram (HTML) du récap ciné, en français."""
from __future__ import annotations

import html
import re
from collections import OrderedDict
from datetime import date, datetime, timedelta
from typing import List, Optional

from .models import Film, Screening
from .ratings import norm_title

_DAYS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]
_MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
_CHUNK = 3500
_SHORT_VERSION = {"OmeU": "OmeU", "OmU": "OmU", "OV": "VO", "muet": "muet", "DE": "VO all.", None: "version ?"}


def esc(text: str) -> str:
    return html.escape(text or "", quote=False)


def _a(url: Optional[str], text: str) -> str:
    return f'<a href="{html.escape(url)}">{text}</a>' if url else text


def evening_day(s: Screening) -> date:
    """Une séance à 00:30 appartient à la soirée de la veille."""
    return (s.start - timedelta(hours=4)).date()


def _fmt_day(d: date) -> str:
    return f"{_DAYS[d.weekday()]} {d.day}"


def _fmt_time(s: Screening) -> str:
    t = s.start.strftime("%H:%M")
    if s.start.date() != evening_day(s):          # après minuit : 24:15 plutôt que 00:15
        t = f"{s.start.hour + 24}:{s.start.minute:02d}"
    return t


def first_sentence(text: Optional[str], limit: int = 170) -> Optional[str]:
    if not text:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    m = re.match(r"(.+?[.!?…])(\s|$)", text)
    out = m.group(1) if m and len(m.group(1)) >= 40 else text
    if len(out) > limit:
        out = out[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return out


def _num(v: float, digits: int) -> str:
    return f"{v:.{digits}f}".replace(".", ",")


_DAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]


def header(start: date, days: int, cinemas: List[str], cfg: dict) -> str:
    end = start + timedelta(days=days - 1)
    span = (f"du {start.day} au {end.day} {_MONTHS[end.month - 1]}" if start.month == end.month
            else f"du {start.day} {_MONTHS[start.month - 1]} au {end.day} {_MONTHS[end.month - 1]}")
    rc = cfg.get("ratings", {})
    seuil = f"SC ≥ {_num(rc.get('senscritique_min', 7.0), 1)} ou Letterboxd ≥ {_num(rc.get('letterboxd_min', 3.6), 1)}"
    return (f"🎬 <b>Ciné de la semaine</b> — {span}\n"
            f"<i>{esc(' · '.join(cinemas))} — séances dès {esc(cfg.get('evening_from', '18:00'))}, "
            f"VO, {esc(seuil)}</i>")


def _short_rating(film: Film, link: bool) -> str:
    sc, lb = film.senscritique, film.letterboxd
    if sc and sc.value and (not lb or film.best_score == sc.value):
        txt, url = f"★ {_num(sc.value, 1)} SC", sc.url
    elif lb:
        txt, url = f"★ {_num(lb.value, 1)} LB", lb.url
    else:
        return "★ ?"
    return _a(url, txt) if link else txt


def _names(film: Film, full: bool) -> str:
    sc = film.senscritique
    orig = (sc.original_title if sc and sc.original_title else None) or film.original_title or film.title
    out = f"<b>{esc(orig)}</b>" if full else esc(orig)
    if full and sc and sc.title and norm_title(sc.title) != norm_title(orig):
        out += f" — <i>{esc(sc.title)}</i>"
    dirs = film.directors[:2]
    if not full:
        dirs = [d.split()[-1] for d in dirs[:1]]          # compact : nom de famille seul
    meta = ", ".join(p for p in [str(film.year) if film.year else "", ", ".join(dirs)] if p)
    return out + (f" ({esc(meta)})" if meta else "")


def _times(items: List[Screening]) -> str:
    return ", ".join(_a(s.booking_url, _fmt_time(s)) for s in items)


def _where(items: List[Screening]) -> str:
    s = items[0]
    ver = _SHORT_VERSION.get(s.version, s.version or "?")
    if s.live_music:
        ver += " + musique live"
    return f"{_a(s.url, esc(s.cinema))} · {esc(ver)}"


def day_sections(films: List[Film]) -> List[str]:
    """Une section par soirée ; séances triées par heure.
    1re apparition d'un film = bloc complet (titre, note liée, pitch),
    apparitions suivantes = une ligne compacte."""
    # (jour) -> [(heure de la 1re séance, film, séances du même cinéma/version)]
    by_day: "dict[date, list]" = {}
    for f in films:
        groups: "OrderedDict[tuple, List[Screening]]" = OrderedDict()
        for s in sorted(f.screenings, key=lambda x: x.start):
            groups.setdefault((evening_day(s), s.cinema, s.version, s.live_music), []).append(s)
        for (d, *_), items in groups.items():
            by_day.setdefault(d, []).append((items[0].start, f, items))

    seen: dict = {}
    sections: List[str] = []
    for d in sorted(by_day):
        lines = [f"📅 <b>{_DAY_NAMES[d.weekday()]} {d.day}</b>"]
        for _, f, items in sorted(by_day[d], key=lambda x: x[0]):
            if id(f) not in seen:
                seen[id(f)] = d
                lines.append(f"🕗 {_times(items)} · {_names(f, True)}")
                lines.append(f"     {_short_rating(f, True)} · 📍 {_where(items)}")
                if f.pitch:
                    lines.append(f"     📝 {esc(f.pitch)}")
            else:
                first = seen[id(f)]
                lines.append(f"🕗 {_times(items)} · {_names(f, False)} · {_short_rating(f, False)}"
                             f" · {_where(items)} <i>(↑ {_fmt_day(first)})</i>")
        sections.append("\n".join(lines))
    return sections


def format_week(kept: List[Film], unrated: List[Film], rejected_count: int,
                start: date, days: int, cinemas: List[str], cfg: dict) -> List[str]:
    head = header(start, days, cinemas, cfg)
    if not kept:
        body = "\n\nRien de fou cette semaine 🤷‍♀️ — rien de bien noté en VO le soir."
        if unrated:
            body += "\n\n" + unrated_line(unrated)
        return [head + body]

    blocks = day_sections(kept)
    tail = []
    if unrated:
        tail.append(unrated_line(unrated))
    n = rejected_count
    tail.append(f"<i>{len(kept)} film{'s' if len(kept) > 1 else ''} retenu{'s' if len(kept) > 1 else ''}, "
                f"{n} écarté{'s' if n > 1 else ''} (note, VF, jeunesse, blockbuster, plafond…)</i>")
    blocks.append("\n\n".join(tail))
    messages: List[str] = []
    current = head
    for block in blocks:
        if len(current) + len(block) + 2 > _CHUNK:
            messages.append(current)
            current = block
        else:
            current += "\n\n" + block
    messages.append(current)
    return messages


def unrated_line(films: List[Film], limit: int = 10) -> str:
    items = []
    for f in sorted(films, key=lambda f: min(s.start for s in f.screenings)):
        first = min(f.screenings, key=lambda s: s.start)
        items.append(f"{_a(first.url, esc(f.title))} · {esc(first.cinema)} · {_fmt_day(evening_day(first))}")
    extra = len(items) - limit
    txt = " ; ".join(items[:limit]) + (f" ; +{extra}" if extra > 0 else "")
    return "🆕 <b>Pas encore notés</b> : " + txt
