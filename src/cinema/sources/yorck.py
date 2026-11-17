"""Source Yorck (delphi LUX, FaF, Passage, Odeon, Kino International…).

Les cinémas Yorck vendent sur leur propre site (yorck.de, Next.js) : kinoheld ne
les liste plus, ou sans version. La page d'un cinéma porte dans ``__NEXT_DATA__``
tous ses films avec leurs séances et le format de chacune :

    pageProps.filmsSpecials[].fields = { title, slug, releaseDate, mainLabel,
        sessions[].fields = { startTime: "2026-11-18T20:00:00+01:00", formats: ["OmU"] } }

La page d'un film (``/de/filme/<slug>``) ajoute titre original, année,
réalisateur, pays, langue : de quoi trouver la bonne note SensCritique.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

import httpx

from ..models import Screening
from ..version import parse_version

_BASE = "https://www.yorck.de/de"
_UA = {"User-Agent": "Mozilla/5.0 (compatible; berlin-encore)"}
_NEXT = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_FORMATS = {"omu": "OmU", "omdu": "OmU", "omeu": "OmeU", "ov": "OV", "df": "DF"}
_LANG = {"englisch": "en", "französisch": "fr", "spanisch": "es", "italienisch": "it", "deutsch": "de",
         "japanisch": "ja", "koreanisch": "ko", "portugiesisch": "pt", "polnisch": "pl", "dänisch": "da",
         "schwedisch": "sv", "norwegisch": "no", "russisch": "ru", "türkisch": "tr", "persisch": "fa",
         "arabisch": "ar", "chinesisch": "zh", "mandarin": "zh", "hindi": "hi", "ukrainisch": "uk"}
_films: Dict[str, dict] = {}          # fiches film partagées entre cinémas Yorck (même run)


def _page(url: str) -> dict:
    r = httpx.get(url, headers=_UA, follow_redirects=True, timeout=30)
    r.raise_for_status()
    m = _NEXT.search(r.text)
    if not m:
        raise RuntimeError(f"yorck: pas de __NEXT_DATA__ sur {url}")
    return json.loads(m.group(1))["props"]["pageProps"]


def _film(slug: str) -> dict:
    if slug not in _films:
        try:
            _films[slug] = (_page(f"{_BASE}/filme/{slug}").get("film") or {}).get("fields") or {}
        except Exception:  # noqa: BLE001 — sans fiche, on garde le titre allemand
            _films[slug] = {}
    return _films[slug]


def _version(formats: List[str]) -> Optional[str]:
    for f in formats or []:
        code = _FORMATS.get(f.lower().replace(" ", ""))
        if code:
            return code
    return parse_version(" ".join(formats or []))


def _strip(html: Optional[str]) -> Optional[str]:
    return re.sub(r"<[^>]+>", " ", html).strip() if html else None


def _special(slug: str) -> list:
    """Séances d'une « special » (Filmreihe, festival…), tous cinémas Yorck : chacune dit SON film."""
    key = "special:" + slug
    if key not in _films:
        try:
            _films[key] = {"sessions": _page(f"{_BASE}/specials/{slug}").get("sessions") or []}
        except Exception:  # noqa: BLE001
            _films[key] = {"sessions": []}
    return _films[key]["sessions"]


def fetch(cfg: dict, start: date, days: int) -> List[Screening]:
    pp = _page(f"{_BASE}/kinos/{cfg['yorck_slug']}")
    here = ((pp.get("cinema") or {}).get("fields") or {}).get("name") or ""
    end = start + timedelta(days=days)
    entries = [x.get("fields") or {} for x in (pp.get("filmsSpecials") or []) + (pp.get("presaleFilms") or [])]
    in_window = lambda t: start <= datetime.fromisoformat(t).date() < end + timedelta(days=1)   # +1 : après minuit
    wanted = []      # (slug du film, titre affiché, rubrique, début, formats)
    for f in entries:
        if "assignedFilms" in f:
            # Une « special » regroupe plusieurs films : on la déplie en séances, chacune avec son film
            # (page de la special, filtrée sur CE cinéma). Le nom de la série devient la rubrique.
            for s in _special(f.get("slug") or ""):
                sf = s.get("fields") or {}
                film = (sf.get("film") or {}).get("fields") or {}
                cin = ((sf.get("cinema") or {}).get("fields") or {}).get("name")
                if sf.get("startTime") and film.get("title") and cin == here and in_window(sf["startTime"]):
                    wanted.append((film.get("slug") or "", film["title"], f.get("title"),
                                   datetime.fromisoformat(sf["startTime"]), sf.get("formats") or []))
            continue
        for s in f.get("sessions") or []:
            sf = s.get("fields") or {}
            if sf.get("startTime") and in_window(sf["startTime"]):
                wanted.append((f.get("slug") or "", f.get("title") or "", None,
                               datetime.fromisoformat(sf["startTime"]), sf.get("formats") or []))
    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(_film, sorted({w[0] for w in wanted if w[0]})))

    out: List[Screening] = []
    dup = set()
    for slug, title, series, when, formats in wanted:
        if (slug or title, when) in dup:
            continue
        dup.add((slug or title, when))
        info = _film(slug) if slug else {}
        year = info.get("year") or (info.get("releaseDate") or "")[:4]
        lang = (info.get("originalLanguage") or "").split(",")[0].strip().lower()
        labels = [info.get("mainLabel")] + list(info.get("additionalLabels") or [])
        url = f"{_BASE}/filme/{slug}" if slug else f"{_BASE}/kinos/{cfg['yorck_slug']}"
        out.append(Screening(
            cinema=cfg["name"],
            start=when,
            title=re.sub(r"\s*\((?:19|20)\d\d\)\s*$", "", (info.get("title") or title).strip()),
            alt_titles=[title] if info.get("title") and info.get("title") != title else [],
            category=series,
            url=url,
            booking_url=url,
            version=_version(formats),
            original_title=(info.get("originalTitle") or "").strip() or None,
            year=int(year) if str(year).isdigit() else None,
            directors=[d.strip() for d in (info.get("director") or "").split(",") if d.strip()],
            countries=list(info.get("countries") or []),
            original_language=_LANG.get(lang),
            genres=[g for g in labels if g],
            description=_strip(info.get("about")),
            tags=[x.lower() for x in formats],
        ))
    return out
