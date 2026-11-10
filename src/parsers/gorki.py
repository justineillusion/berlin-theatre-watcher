"""Source Maxim Gorki Theater (gorki.de, Next.js + Payload CMS).

Le spielplan anglais (/en/schedule) est rendu côté serveur, une ligne par
représentation (les jours d'expo répétés sont déjà dépliés) :

    li.DateList-module__…__row[data-day="YYYY-MM-DD"]
      span.…__time span            -> « 19:30 – » (début, puis fin éventuelle)
      a.…__what[href="/en/<slug>"] -> page production
        span.…__who                -> artiste(s) / metteur·se en scène
        span.…__work               -> titre de la date (+ span.…__premiere)
      span.…__where                -> lieu (Stage, Studio, Gallery…)
      span.…__tickets              -> a.…__ticketLink (Eventim) ou
                                      span.…__ticketStatus (« Sold out », « Free entry »)

Les classes CSS sont hachées (« DateList-module__akU_AG__row ») : on ne s'appuie
que sur leur suffixe (« __row », « __work »…).

Langue / surtitres : RIEN dans le spielplan. L'info vit dans le champ
`language` de la production (Payload), souvent rempli seulement en allemand :
« Deutsch + eng. ÜT » pour « Das Hörrohr / The Hearing Trumpet » (vérifié le
2026-11-11). On la lit dans l'API publique du site, toutes locales d'un coup
(/api/projects?locale=all, ~2 ko), et on la ramène à la formulation anglaise
(« In German, with English surtitles ») que comprend language.detect().
Elle ne s'applique qu'aux dates dont le titre est celui de la production :
l'expo « Ottinger - Exhibition » rattachée à « The Hearing Trumpet » ne devient
pas surtitrée pour autant. Les rencontres annoncées « (in English) » ou les
« English Workshop » comptent comme accessibles en anglais (jouées en anglais).
"""
from __future__ import annotations

import json
import re
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

_BASE = "https://www.gorki.de"
_PROJECTS_API = (
    _BASE + "/api/projects?depth=0&limit=200&locale=all"
    "&select%5Bslug%5D=true&select%5Blanguage%5D=true&select%5Btitle%5D=true"
)
_TIME_RE = re.compile(r"(\d{1,2})[:.](\d{2})")

# Mentions dans le titre d'une date : « … (in English) », « English Workshop ».
_EN_TITLE = re.compile(r"\bin english\b|\benglish\s+(?:workshop|version|tour|talk|edition)\b", re.I)

# Champ `language` en allemand (« Deutsch + eng. ÜT », « Türkisch mit dt. und engl. Übertiteln »).
_DE_LANGS = [
    (r"deutsch\w*|dt\.", "German"), (r"englisch\w*|engl?\.", "English"),
    (r"t(?:ü|ue)rkisch\w*", "Turkish"), (r"arabisch\w*", "Arabic"), (r"russisch\w*", "Russian"),
    (r"ukrainisch\w*", "Ukrainian"), (r"hebr(?:ä|ae)isch\w*", "Hebrew"), (r"kurdisch\w*", "Kurdish"),
    (r"persisch\w*|farsi", "Persian"), (r"franz(?:ö|oe)sisch\w*", "French"),
    (r"spanisch\w*", "Spanish"), (r"polnisch\w*", "Polish"),
]
_SURTITLE_WORD = re.compile(r"(?:ü|ue)t\b|(?:ü|ue)bertitel\w*|surtitles?|subtitles?", re.I)


def collect(url: str) -> List[Show]:
    """`url` = https://www.gorki.de/en/schedule"""
    html = fetch_html(url)
    try:
        langs = project_languages(json.loads(fetch_html(_PROJECTS_API, timeout=20.0)))
    except Exception:  # noqa: BLE001 — sans l'API : programme sans info de langue
        langs = {}
    return parse(html, langs)


def _join(names: List[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _names(fragment: str) -> List[str]:
    found: List[Tuple[int, str]] = []
    for pattern, name in _DE_LANGS:
        m = re.search(rf"(?<!\w){pattern}", fragment, re.I)
        if m:
            found.append((m.start(), name))
    out: List[str] = []
    for _, name in sorted(found):
        if name not in out:
            out.append(name)
    return out


def normalize_language(raw: Optional[str]) -> Optional[str]:
    """'Deutsch + eng. ÜT' -> 'In German, with English surtitles'.
    Un texte déjà en anglais (« In English ») est rendu tel quel."""
    raw = re.sub(r"\s+", " ", raw or "").strip()
    if not raw:
        return None
    if re.search(r"\b(?:in|with)\b.*\b(?:english|german)\b|surtitles", raw, re.I):
        return raw
    spoken: List[str] = []
    titles: List[str] = []
    # « Deutsch + eng. ÜT » / « Deutsch mit engl. Übertiteln »
    for part in re.split(r"\s*(?:\+|,|;|/|\bmit\b)\s*", raw, flags=re.I):
        target = titles if _SURTITLE_WORD.search(part) else spoken
        for n in _names(part):
            if n not in target:
                target.append(n)
    bits = []
    if spoken:
        bits.append(f"In {_join(spoken)}")
    if titles:
        bits.append(f"with {_join(titles)} surtitles")
    if not bits:
        return raw
    text = ", ".join(bits)
    return text[0].upper() + text[1:]


def project_languages(api: dict) -> Dict[str, Tuple[str, Optional[str]]]:
    """{slug anglais: (titre anglais, langue normalisée)} depuis /api/projects?locale=all."""
    out: Dict[str, Tuple[str, Optional[str]]] = {}
    for doc in api.get("docs") or []:
        slug, title, lang = doc.get("slug") or {}, doc.get("title") or {}, doc.get("language") or {}
        if not isinstance(slug, dict):
            continue
        language = normalize_language(lang.get("en") or lang.get("de")) if isinstance(lang, dict) else None
        en_title = (title.get("en") or title.get("de") or "") if isinstance(title, dict) else str(title)
        for s in {slug.get("en"), slug.get("de")} - {None, ""}:
            out[s] = (en_title.strip(), language)
    return out


def _part(el, suffix: str):
    """Premier descendant dont une classe finit par `__<suffix>` (classes CSS hachées)."""
    return el.find(class_=lambda c: bool(c) and c.endswith("__" + suffix))


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower().replace("’", "'")).strip()


def parse(html: str, langs: Optional[Dict[str, Tuple[str, Optional[str]]]] = None) -> List[Show]:
    langs = langs or {}
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []
    for row in soup.find_all("li", attrs={"data-day": True}):
        what = _part(row, "what")
        work = _part(row, "work")
        if not what or not work:
            continue
        premiere = _part(work, "premiere")
        if premiere:
            premiere.extract()
        title = re.sub(r"\s+", " ", work.get_text(" ", strip=True)).strip()
        if not title:
            continue
        href = what.get("href") or ""
        url = urljoin(_BASE, href)
        slug = href.rstrip("/").rsplit("/", 1)[-1]

        time_el = _part(row, "time")
        tm = _TIME_RE.search(time_el.get_text(" ", strip=True)) if time_el else None
        time_str = f"{int(tm.group(1)):02d}:{tm.group(2)}" if tm else None

        who_el, where_el = _part(row, "who"), _part(row, "where")
        who = who_el.get_text(" ", strip=True) if who_el else None
        venue = where_el.get_text(" ", strip=True) if where_el else None

        link = _part(row, "ticketLink")
        status_el = _part(row, "ticketStatus")
        status = status_el.get_text(" ", strip=True).lower() if status_el else ""
        if "sold out" in status or "ausverkauft" in status:
            sold_out: Optional[bool] = True
        elif link is not None or status:
            sold_out = False                   # billetterie, entrée libre, réservation
        else:
            sold_out = None

        # Langue : celle de la production, si cette date EST la production.
        language = None
        prod_title, prod_lang = langs.get(slug, ("", None))
        if prod_lang and prod_title:
            a, b = _norm(title), _norm(prod_title)
            if a.startswith(b) or b.startswith(a):
                language = prod_lang
        if not language and _EN_TITLE.search(title):
            language = "In English"
        is_en = bool(language and re.search(r"\benglish\b", language, re.I))

        note = " · ".join(p for p in (who, language) if p) or None
        shows.append(
            Show(
                theater="Maxim Gorki Theater",
                title=title,
                date=row.get("data-day", ""),
                time=time_str,
                venue=venue,
                url=url,
                languages=note,                 # artiste(s) · langue / surtitres
                has_english_surtitles=is_en,
                sold_out=sold_out,
                booking_url=link.get("href") if link is not None else None,
            )
        )
    return shows
