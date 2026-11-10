"""Mise en forme Telegram (HTML) du récap ciné, en français ou en anglais (`lang`)."""
from __future__ import annotations

import html
import re
from collections import OrderedDict
from datetime import date, datetime, timedelta
from typing import List, Optional

from .models import Film, Screening
from .ratings import norm_title

_DAYS = {"fr": ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
         "en": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
_MONTHS = {"fr": ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
           "en": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]}
_DAY_NAMES = {"fr": ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
              "en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]}
_CHUNK = 3500
_SHORT_VERSION = {
    "fr": {"OmeU": "OmeU", "OmU": "OmU", "OV": "VO", "muet": "muet", "DE": "VO all.", None: "version ?"},
    "en": {"OmeU": "OmeU", "OmU": "OmU", "OV": "OV", "muet": "silent", "DE": "German OV", None: "version ?"},
}
# Textes fixes du récap
_T = {
    "fr": {"title": "Ciné de la semaine", "tonight_span": " + ce soir", "tonight": "Ce soir", "or": "ou",
           "ov": "VO", "live": " + musique live", "unrated": "Pas encore notés",
           "nothing": "Rien de fou cette semaine 🤷‍♀️ — rien de bien noté en VO le soir.",
           "known_until": "programme connu jusqu'au", "not_published": "programme pas encore publié",
           "pick": "⭐ <b>Ça te tente ?</b> Touche un film : la bande le verra (et toi, qui d'autre est partant)."},
    "en": {"title": "Films of the week", "tonight_span": " + tonight", "tonight": "Tonight", "or": "or",
           "ov": "original version", "live": " + live music", "unrated": "Not rated yet",
           "nothing": "Nothing great this week 🤷‍♀️ — no well-rated original-version evening shows.",
           "known_until": "programme known until", "not_published": "programme not published yet",
           "pick": "⭐ <b>Fancy one?</b> Tap a film: the gang will see it (and you'll see who else is in)."},
}


def text(lang: str, key: str) -> str:
    return _T.get(lang, _T["fr"])[key]


def esc(text: str) -> str:
    return html.escape(text or "", quote=False)


def _a(url: Optional[str], text: str) -> str:
    return f'<a href="{html.escape(url)}">{text}</a>' if url else text


def evening_day(s: Screening) -> date:
    """Une séance à 00:30 appartient à la soirée de la veille."""
    return (s.start - timedelta(hours=4)).date()


def fmt_day(d: date, lang: str = "fr") -> str:
    return f"{_DAYS[lang][d.weekday()]} {d.day}"


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


def _num(v: float, digits: int, lang: str = "fr") -> str:
    out = f"{v:.{digits}f}"
    return out if lang == "en" else out.replace(".", ",")


def _span(a: date, b: date, lang: str = "fr") -> str:
    m = _MONTHS[lang]
    if lang == "en":
        return f"{a.day}–{b.day} {m[b.month - 1]}" if a.month == b.month else f"{a.day} {m[a.month - 1]} – {b.day} {m[b.month - 1]}"
    if a.month == b.month:
        return f"du {a.day} au {b.day} {m[b.month - 1]}"
    return f"du {a.day} {m[a.month - 1]} au {b.day} {m[b.month - 1]}"


def hours_label(cfg: dict, lang: str = "fr") -> str:
    """« séances 18:00–22:00 en semaine, 18:00+ le week-end »."""
    frm = cfg.get("evening_from", "18:00")
    rule = cfg.get("latest_start") or {}
    en = lang == "en"
    if not rule.get("time"):
        return f"screenings from {frm}" if en else f"séances dès {frm}"
    wd = sorted(set(rule.get("days", [0, 1, 2, 3, 4])))
    if wd == [0, 1, 2, 3, 4]:
        return (f"screenings {frm}–{rule['time']} on weekdays, {frm}+ at weekends" if en
                else f"séances {frm}–{rule['time']} en semaine, {frm}+ le week-end")
    jours = ", ".join(_DAYS[lang][d] for d in wd)
    return (f"screenings from {frm} (until {rule['time']} on {jours})" if en
            else f"séances dès {frm} (jusqu'à {rule['time']} les {jours})")


def header(win: dict, cinemas: List[str], cfg: dict, lang: str = "fr") -> str:
    span = _span(win["first"], win["last"], lang)
    if win.get("tonight"):
        span += text(lang, "tonight_span")
    rc = cfg.get("ratings", {})
    sc_min = f"SC ≥ {_num(rc.get('senscritique_min', 7.0), 1, lang)}"
    lb_min = f"Letterboxd ≥ {_num(rc.get('letterboxd_min', 3.6), 1, lang)}"
    seuil = f"{lb_min} {text(lang, 'or')} {sc_min}" if lang == "en" else f"{sc_min} {text(lang, 'or')} {lb_min}"
    return (f"🎬 <b>{text(lang, 'title')}</b> — {span}\n"
            f"<i>{esc(' · '.join(cinemas))} — {esc(hours_label(cfg, lang))}, {text(lang, 'ov')}, {esc(seuil)}</i>")


def _short_rating(film: Film, link: bool, lang: str = "fr") -> str:
    sc, lb = film.senscritique, film.letterboxd
    # En anglais : Letterboxd (plus parlant hors de France), SensCritique en repli.
    if lang == "en" and lb and lb.value:
        txt, url = f"★ {_num(lb.value, 1, lang)} LB", lb.url
    elif sc and sc.value and (not lb or film.best_score == sc.value):
        txt, url = f"★ {_num(sc.value, 1, lang)} SC", sc.url
    elif lb:
        txt, url = f"★ {_num(lb.value, 1, lang)} LB", lb.url
    else:
        return "★ ?"
    return _a(url, txt) if link else txt


def _names(film: Film, full: bool, lang: str = "fr") -> str:
    sc = film.senscritique
    orig = (sc.original_title if sc and sc.original_title else None) or film.original_title or film.title
    out = f"<b>{esc(orig)}</b>" if full else esc(orig)
    # Titre français (SensCritique) : seulement pour qui lit en français.
    if lang == "fr" and full and sc and sc.title and norm_title(sc.title) != norm_title(orig):
        out += f" — <i>{esc(sc.title)}</i>"
    dirs = film.directors[:2]
    if not full:
        dirs = [d.split()[-1] for d in dirs[:1]]          # compact : nom de famille seul
    meta = ", ".join(p for p in [str(film.year) if film.year else "", ", ".join(dirs)] if p)
    return out + (f" ({esc(meta)})" if meta else "")


def _times(items: List[Screening]) -> str:
    return ", ".join(_a(s.booking_url, _fmt_time(s)) for s in items)


def _where(items: List[Screening], lang: str = "fr") -> str:
    s = items[0]
    ver = _SHORT_VERSION[lang].get(s.version, s.version or "?")
    if s.live_music:
        ver += text(lang, "live")
    return f"{_a(s.url, esc(s.cinema))} · {esc(ver)}"


def day_sections(films: List[Film], tonight: Optional[date] = None, lang: str = "fr") -> List[str]:
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
        label = f"{_DAY_NAMES[lang][d.weekday()]} {d.day}"
        if d == tonight:
            label = f"{text(lang, 'tonight')} ({label if lang == 'en' else label.lower()})"
        lines = [f"📅 <b>{label}</b>"]
        for _, f, items in sorted(by_day[d], key=lambda x: x[0]):
            if id(f) not in seen:
                seen[id(f)] = d
                lines.append(f"🕗 {_times(items)} · {_names(f, True, lang)}")
                lines.append(f"     {_short_rating(f, True, lang)} · 📍 {_where(items, lang)}")
                pitch = f.pitch_en if lang == "en" else f.pitch
                if pitch:
                    lines.append(f"     📝 {esc(pitch)}")
            else:
                first = seen[id(f)]
                lines.append(f"🕗 {_times(items)} · {_names(f, False, lang)} · {_short_rating(f, False, lang)}"
                             f" · {_where(items, lang)} <i>(↑ {fmt_day(first, lang)})</i>")
        sections.append("\n".join(lines))
    return sections


def format_week(kept: List[Film], unrated: List[Film], rejected_count: int,
                win: dict, cinemas: List[str], cfg: dict, coverage: Optional[List[str]] = None,
                lang: str = "fr") -> List[str]:
    head = header(win, cinemas, cfg, lang)
    cov = f"<i>⏳ {esc(' · '.join(coverage))}</i>" if coverage else ""
    unr = unrated_line(unrated, lang=lang) if unrated else ""
    if not kept:
        body = "\n\n" + text(lang, "nothing")
        if unr:
            body += "\n\n" + unr
        if cov:
            body += "\n\n" + cov
        return [head + body]

    blocks = day_sections(kept, win.get("tonight"), lang)
    tail = []
    if cov:
        tail.append(cov)
    if unr:
        tail.append(unr)
    n, k = rejected_count, len(kept)
    if lang == "en":
        tail.append(f"<i>{k} film{'s' if k > 1 else ''} picked, {n} left out "
                    f"(rating, dubbed, kids, blockbuster, cap…)</i>")
    else:
        tail.append(f"<i>{k} film{'s' if k > 1 else ''} retenu{'s' if k > 1 else ''}, "
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


def unrated_line(films: List[Film], limit: int = 5, lang: str = "fr") -> str:
    """Une ligne courte : 5 titres max (raccourcis), sans les programmes de courts."""
    import re
    films = [f for f in films if not re.search(r"short ?films?|kurzfilm", f.title, re.I)]
    items = []
    for f in sorted(films, key=lambda f: min(s.start for s in f.screenings)):
        first = min(f.screenings, key=lambda s: s.start)
        title = re.split(r" [–—-] |: ", f.title)[0]
        title = title if len(title) <= 28 else title[:27] + "…"
        items.append(f"{_a(first.url, esc(title))} ({esc(first.cinema)})")
    if not items:
        return ""
    extra = len(items) - limit
    txt = " · ".join(items[:limit]) + (f" · +{extra}" if extra > 0 else "")
    return f"🆕 <i>{text(lang, 'unrated')}</i>{'' if lang == 'en' else ' '}: " + txt


# ---------------------------------------------------------------------------
# Fiche d'un film pour le bot (items kind='film' : ⭐ ✅ 🔕, annonces du groupe)
# ---------------------------------------------------------------------------
def _sessions(film: Film, lang: str, limit: int = 6) -> List[str]:
    """['<a>Babylon</a> (OmU) : lun. 9 20:00 · jeu. 12 18:30', …] (heures = liens de réservation)."""
    by_cinema: "OrderedDict[tuple, List[Screening]]" = OrderedDict()
    for s in sorted(film.screenings, key=lambda x: x.start):
        by_cinema.setdefault((s.cinema, s.version, s.live_music), []).append(s)
    out = []
    for (cin, ver, live), items in by_cinema.items():
        v = _SHORT_VERSION[lang].get(ver, ver or "?") + (text(lang, "live") if live else "")
        shown = " · ".join(_a(s.booking_url, f"{fmt_day(evening_day(s), lang)} {_fmt_time(s)}") for s in items[:limit])
        more = f" (+{len(items) - limit})" if len(items) > limit else ""
        colon = ":" if lang == "en" else " :"
        out.append(f"{_a(items[0].url, esc(cin))} ({esc(v)}){colon} {shown}{more}")
    return out


def _buzz(film: Film, lang: str) -> str:
    """Buzz presse du film (cache seul) — seulement s'il y a eu des articles."""
    try:
        from ..press import format_buzz, press_for
        cinema = film.screenings[0].cinema if film.screenings else ""
        b = press_for("film", cinema, film.original_title or film.title, film.screenings[0].url if film.screenings else "",
                      aliases=[t for t in {film.title} if t != film.original_title])
        return esc(format_buzz(b, lang)) if b["status"] == "verdict" else ""
    except Exception:  # noqa: BLE001
        return ""


def film_card(film: Film, lang: str = "fr") -> str:
    """Un message par film : titre (original + titre FR), année, réalisateur, ★ note liée,
    pitch, puis les séances de la semaine par cinéma."""
    lines = [f"🎬 {_names(film, True, lang)}"]
    lines += [f"📍 {x}" for x in _sessions(film, lang)]
    rating = _short_rating(film, True, lang)
    if rating != "★ ?":                    # pas de note connue : pas de ligne
        lines.append(rating)
    buzz = _buzz(film, lang)
    if buzz:
        lines.append(buzz)
    pitch = film.pitch_en if lang == "en" else film.pitch
    if pitch:
        lines.append(f"\n<blockquote expandable>📝 {esc(pitch)}</blockquote>")
    return "\n".join(lines)


def week_header(win: dict, cinemas: List[str], cfg: dict, n: int, unrated: List[Film],
                coverage: List[str], lang: str = "fr") -> str:
    """Message d'en-tête du dimanche (avant un message par film)."""
    head = header(win, cinemas, cfg, lang)
    picks = (f"{n} film{'s' if n > 1 else ''}" if lang == "en"
             else f"{n} film{'s' if n > 1 else ''} retenu{'s' if n > 1 else ''}")
    first, rest = head.split("\n", 1)
    parts = [f"{first} · {picks}", rest]
    if coverage:
        parts.append(f"<i>⏳ {esc(' · '.join(coverage))}</i>")
    unr = unrated_line(unrated, lang=lang) if unrated else ""
    if unr:
        parts.append(unr)
    return "\n".join(parts)


def film_line(film: Film, lang: str = "fr") -> str:
    head = f"• {_names(film, False, lang)} · {_short_rating(film, True, lang)}"
    return head + "".join(f"\n   📍 {x}" for x in _sessions(film, lang, limit=3))
