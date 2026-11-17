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


def fetch(cfg: dict, start: date, days: int) -> List[Screening]:
    pp = _page(f"{_BASE}/kinos/{cfg['yorck_slug']}")
    end = start + timedelta(days=days)
    films = [x.get("fields") or {} for x in (pp.get("filmsSpecials") or []) + (pp.get("presaleFilms") or [])]
    wanted = []
    for f in films:
        for s in f.get("sessions") or []:
            sf = s.get("fields") or {}
            t = sf.get("startTime")
            if not t:
                continue
            when = datetime.fromisoformat(t)
            if start <= when.date() < end + timedelta(days=1):   # +1 : séances après minuit
                wanted.append((f, when, sf.get("formats") or []))
    slugs = sorted({f.get("slug") for f, _, _ in wanted if f.get("slug")})
    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(_film, slugs))

    out: List[Screening] = []
    dup = set()
    for f, when, formats in wanted:
        slug = f.get("slug") or ""
        key = (slug, when)
        if key in dup:
            continue
        dup.add(key)
        info = _film(slug) if slug else {}
        year = info.get("year") or (f.get("releaseDate") or "")[:4]
        lang = (info.get("originalLanguage") or "").split(",")[0].strip().lower()
        labels = [info.get("mainLabel") or f.get("mainLabel")] + list(info.get("additionalLabels") or [])
        url = f"{_BASE}/filme/{slug}" if slug else f"{_BASE}/kinos/{cfg['yorck_slug']}"
        out.append(Screening(
            cinema=cfg["name"],
            start=when,
            title=(f.get("title") or "").strip(),
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
