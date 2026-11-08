"""Filtre « cinéphile snob » : vrai film, VO, pas grand public, bien noté."""
from __future__ import annotations

import re
from datetime import date
from typing import List, Optional

from . import ratings as R
from .models import Film, Screening
from .version import is_german_original

_SC_GERMAN = {"allemagne", "autriche", "rda", "rfa", "allemagne de l'ouest", "allemagne de l'est"}


def _ci_in(needle: str, hay: str) -> bool:
    return re.search(r"(?<!\w)" + re.escape(needle.lower()) + r"(?!\w)", hay.lower()) is not None


def _haystack(film: Film) -> str:
    parts: List[str] = []
    for s in film.screenings:
        parts += [s.title, s.original_title or "", s.category or ""] + s.alt_titles + s.tags
    return " | ".join(p for p in parts if p)


def _genres(film: Film) -> List[str]:
    g = {x for s in film.screenings for x in s.genres}
    if film.senscritique:
        g |= set(film.senscritique.genres)
    return sorted(g)


def _german_original(film: Film) -> Optional[bool]:
    for s in film.screenings:
        v = is_german_original(s.countries, s.original_language)
        if v is not None:
            return v
    if film.senscritique and film.senscritique.countries:
        return film.senscritique.countries[0].lower() in _SC_GERMAN
    return None


def pre_filter(film: Film, cfg: dict) -> Optional[str]:
    """Filtres qui ne demandent pas de note. Renvoie la raison d'exclusion ou None."""
    bl = cfg.get("blocklist", {})
    hay = _haystack(film)
    title_l = film.title.lower()

    if any(t.lower() == title_l for t in cfg.get("always_exclude") or []):
        return "dans always_exclude"
    live = any(s.live_music for s in film.screenings)
    for s in film.screenings:
        if s.category and s.category.upper() in {c.upper() for c in bl.get("categories", [])}:
            return f"pas un film (rubrique {s.category})"
    if not live:
        for kw in bl.get("non_film_keywords", []):
            if any(_ci_in(kw, t) for s in film.screenings for t in [s.title] + s.tags):
                return f"pas un film (« {kw} »)"
    for kw in bl.get("keywords", []):
        if _ci_in(kw, hay):
            return f"mot-clé bloqué « {kw} »"
    flags = {t.lower() for s in film.screenings for t in s.tags}
    for f in bl.get("flags", []):
        if f.lower() in flags:
            return f"flag cinéma « {f} » (jeunesse/famille)"
    return None


def genre_filter(film: Film, cfg: dict) -> Optional[str]:
    bl = cfg.get("blocklist", {})
    genres = _genres(film)
    for g in bl.get("genres", []):
        if any(g.lower() == x.lower() for x in genres):
            return f"genre « {g} »"
    bb = cfg.get("blockbuster") or {}
    sc = film.senscritique
    year = film.year or (sc.year if sc else None)
    if sc and bb and year and year >= date.today().year - bb.get("max_age_years", 3) \
            and sc.count >= bb.get("min_votes", 8000) \
            and any(g.lower() in {x.lower() for x in genres} for g in bb.get("genres", [])):
        return f"blockbuster récent ({sc.count} votes SC, {', '.join(genres[:3])})"
    return None


def wide_release_filter(film: Film, cfg: dict) -> Optional[str]:
    """Sortie grand public : le cinéma propose AUSSI une VF allemande d'un film
    étranger récent de genre « spectacle » (ex. animation familiale, fantasy).
    À appeler après version_filter (qui remplit dropped_screenings)."""
    bb = cfg.get("blockbuster") or {}
    genres = {g.lower() for g in _genres(film)}
    dubbed = film.dubbed_release or any("VF" in d for d in film.dropped_screenings)
    year = film.year
    if dubbed and not _german_original(film) and year and year >= date.today().year - bb.get("max_age_years", 3) \
            and genres & {g.lower() for g in bb.get("genres", [])}:
        return "sortie grand public (aussi en VF) + genre spectacle"
    return None


def version_filter(film: Film, cfg: dict) -> Optional[str]:
    """Écarte les séances doublées ; renvoie une raison si plus rien ne reste."""
    german = _german_original(film)
    keep: List[Screening] = []
    accepted = cfg.get("accept_versions") or ["OmeU", "OmU", "OV", "muet", None]
    for s in film.screenings:
        if s.version in ("DF", "DE"):
            if german:
                s.version = "DE"              # VO allemande : parfait
                keep.append(s)
            elif cfg.get("exclude_dubbed", True):
                film.dropped_screenings.append(f"{s.cinema} {s.start:%a %d %H:%M} (VF allemande)")
            else:
                keep.append(s)
        elif s.version in accepted or s.version is None:
            keep.append(s)
        else:
            film.dropped_screenings.append(f"{s.cinema} {s.start:%a %d %H:%M} ({s.version})")
    if not keep:
        return "seulement en version allemande doublée"
    film.screenings = keep
    return None


def _titles(film: Film) -> List[str]:
    out: List[str] = []
    for s in film.screenings:
        for t in [s.original_title, s.title] + list(s.alt_titles):
            if t and t not in out:
                out.append(t)
    return out


def rate(film: Film, cfg: dict) -> None:
    years = [s.year for s in film.screenings if s.year]
    year = years[0] if years else None
    dirs = film.directors
    film.senscritique = R.senscritique(_titles(film), year, dirs)


def rating_filter(film: Film, cfg: dict) -> Optional[str]:
    rc = cfg.get("ratings", {})
    sc = film.senscritique
    sc_ok = bool(sc and sc.count >= rc.get("senscritique_min_votes", 30)
                 and sc.value >= rc.get("senscritique_min", 7.0))
    if sc_ok:
        return None
    sc_reliable = bool(sc and sc.value and sc.count >= rc.get("senscritique_min_votes", 30))
    if sc_reliable and rc.get("letterboxd_when", "fallback") == "fallback":
        # SensCritique a tranché (assez de votes) : Letterboxd ne sert pas de 2e chance
        return f"note sous le seuil : SC {sc.value:.1f} ({sc.count} votes)"
    # repli Letterboxd : film introuvable sur SC ou trop peu de votes (ou mode « any »)
    years = [s.year for s in film.screenings if s.year] or ([sc.year] if sc and sc.year else [])
    lb_titles = ([sc.original_title] if sc and sc.original_title else []) + _titles(film)
    film.letterboxd = R.letterboxd(lb_titles, years[0] if years else None, film.directors)
    lb = film.letterboxd
    lb_reliable = bool(lb and lb.count >= rc.get("letterboxd_min_votes", 300))
    if lb_reliable and lb.value >= rc.get("letterboxd_min", 3.6):
        return None
    # ni SC ni Letterboxd n'ont assez de votes : film « pas encore noté »
    film.unrated = not lb_reliable
    bits = []
    if sc:
        bits.append(f"SC {sc.value:.1f} ({sc.count} votes)" if sc.value else f"SC sans moyenne ({sc.count} votes)")
    if lb:
        bits.append(f"LB {lb.value:.2f} ({lb.count} votes)")
    if not bits:
        return "aucune note trouvée (SC/Letterboxd)"
    if film.unrated:
        return "pas assez de votes : " + ", ".join(bits)
    return "note sous le seuil : " + ", ".join(bits)
