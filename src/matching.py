from __future__ import annotations

from typing import List

from .models import Show


def _find(keywords: List[str], hay: str) -> List[str]:
    return [kw for kw in keywords if kw.strip() and kw.strip().lower() in hay]


def select(shows: List[Show], config: dict) -> List[Show]:
    """Applique les filtres durs + le matching par mots-clés.

    Filtres durs : surtitres anglais requis, on écarte les complets.
    Mots-clés : 'keywords_avoid' exclut ; 'keywords_love' tague (et filtre si
    require_keyword_match=true).
    """
    love = config.get("keywords_love") or []
    avoid = config.get("keywords_avoid") or []
    require_match = bool(config.get("require_keyword_match", False))

    kept: List[Show] = []
    for show in shows:
        if not show.has_english_surtitles:
            continue
        if show.sold_out is True:
            continue

        hay = show.haystack()
        if _find(avoid, hay):
            continue

        matched = _find(love, hay)
        if require_match and love and not matched:
            continue

        show.matched_keywords = matched
        kept.append(show)

    # Les correspondances de goût d'abord, puis par date.
    kept.sort(key=lambda s: (-len(s.matched_keywords), s.date or "9999"))
    return kept
