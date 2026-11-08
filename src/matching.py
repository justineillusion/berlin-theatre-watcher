from __future__ import annotations

from collections import OrderedDict
from datetime import date
from typing import List

from .models import Show


def _find(keywords: List[str], hay: str) -> List[str]:
    return [kw for kw in keywords if kw.strip() and kw.strip().lower() in hay]


def _fmt_date(show: Show) -> str:
    """'2026-09-19' + '20:00' -> '19/09 · 20:00'."""
    d = show.date
    label = f"{d[8:10]}/{d[5:7]}" if len(d) >= 10 and d[4] == "-" else d
    return f"{label} · {show.time}" if show.time else label


def select(shows: List[Show], config: dict) -> List[Show]:
    """Filtres durs + matching mots-clés + regroupement par pièce.

    Filtres durs : surtitres anglais requis, on écarte les complets.
    Mots-clés : 'keywords_avoid' exclut ; 'keywords_love' tague (et filtre si
    require_keyword_match=true).
    Regroupement : une seule entrée par pièce (prochaine date + nb d'autres dates).
    """
    love = config.get("keywords_love") or []
    avoid = config.get("keywords_avoid") or []
    require_match = bool(config.get("require_keyword_match", False))

    today = date.today().isoformat()
    kept: List[Show] = []
    for show in shows:
        if show.kind == "expo":
            # Pas de surtitres ni de « complet » : on écarte juste les expos finies.
            if show.end_date and show.end_date < today:
                continue
        elif not show.has_english_surtitles or show.sold_out is True:
            continue
        hay = show.haystack()
        if _find(avoid, hay):
            continue
        matched = _find(love, hay)
        if require_match and love and not matched:
            continue
        show.matched_keywords = matched
        kept.append(show)

    # Regroupe les multiples dates d'une même pièce en une seule entrée.
    groups: "OrderedDict[str, List[Show]]" = OrderedDict()
    for show in kept:
        groups.setdefault(show.key(), []).append(show)

    reps: List[Show] = []
    for members in groups.values():
        if members[0].kind == "expo":
            reps.append(members[0])
            continue
        members.sort(key=lambda s: s.date or "9999")
        rep = members[0]                       # la prochaine date à venir
        rep.other_dates_count = len(members) - 1
        # toutes les dates avec places libres (les complètes sont déjà écartées)
        rep.available_dates = [_fmt_date(m) for m in members]
        # Forme brute (AAAA-MM-JJ HH:MM) : c'est elle qu'on stocke dans l'état,
        # car _fmt_date perd l'année et deux saisons pourraient se confondre.
        rep.available_iso = [
            f"{m.date} {m.time}".strip() for m in members if m.date
        ]
        reps.append(rep)

    # Les correspondances de goût d'abord, puis par date.
    reps.sort(key=lambda s: (-len(s.matched_keywords), s.date or "9999"))
    return reps


def sold_out_dates(shows: List[Show], config: dict) -> dict:
    """Dates COMPLÈTES des pièces surtitrées en anglais (même filtres que select) :
    {item_id: ["AAAA-MM-JJ HH:MM", ...]}. La mini-app les montre grisées « Complet »
    au lieu de les cacher ; les annonces et alertes, elles, ne les reçoivent jamais."""
    avoid = config.get("keywords_avoid") or []
    today = date.today().isoformat()
    out: dict = {}
    for show in shows:
        if show.kind == "expo" or not show.has_english_surtitles or show.sold_out is not True:
            continue
        if not show.date or show.date < today or _find(avoid, show.haystack()):
            continue
        out.setdefault(show.item_id(), set()).add(f"{show.date} {show.time}".strip())
    return {k: sorted(v) for k, v in out.items()}
