"""Babylon (Rosa-Luxemburg-Str. 30, Mitte) — site Joomla babylonberlin.eu.

La page ``/programm`` liste TOUTES les séances à venir (une vignette par
séance) sous la forme :

    <li class="mix cat-FILM tag-english-ov tag-highlight" data-date="2026-11-09 22:30:00">
      … <a class="mix-title" href="/film/3781-blue-velvet">Blue Velvet [OmU]</a>
        <p class="mix-introtext">Blue Velvet [OmU] USA, 1986, R: David Lynch mit …</p>
        <span class="mix-category">In <a>FILM</a></span>

Le texte d'intro est tronqué (« … ») : on lit la 1re ligne de la page du film
pour avoir pays / année / réalisateur complets. Les rubriques (cat-*) et tags
(tag-stummfilm-live, tag-Orchester, tag-literatur…) servent à repérer les
ciné-concerts et à écarter ce qui n'est pas du cinéma (lectures, concerts…).
Les billets sont vendus via kinoheld (cinéma 670), mais les métadonnées de
kinoheld y sont pauvres/fausses : on préfère le site.
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta
from typing import Dict, List
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from ..http import get_text
from ..models import Screening
from ..version import parse_version
from .common import parse_credit_line

_TZ = ZoneInfo("Europe/Berlin")
_BASE = "https://babylonberlin.eu"
_BRACKETS = re.compile(r"\s*[\[(]\s*([^\])]+?)\s*[\])]")
_VERSIONISH = re.compile(r"^(om\s*e?\s*u|omdu|omu|ov.*|.*engl.*|english.*|original.*|.*\bUT\b.*|tamil|hindi|stummfilm)$", re.I)
_SUFFIXES = re.compile(
    r"\s*(?::|–|-)\s*(premiere.*|live shadow cast|preview.*|with guests.*|mit gästen.*|\+ ?q&a.*)$", re.I)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _clean_title(raw: str, category: str, series: List[str]) -> tuple[str, List[str]]:
    """'Clockwork Kubrick: Eyes Wide Shut [OmU]' -> ('Eyes Wide Shut', [])."""
    title = raw.replace("\\[", "[").replace("\\]", "]").replace("…", "").strip()
    if ":" in title:
        prefix, rest = title.split(":", 1)
        np = _norm(prefix)
        if np and (np == _norm(category) or any(np == _norm(s) for s in series)
                   or np.startswith(("cinemaperitivo", "metfilm", "indogerman", "clockwork", "lasurreal",
                                     "cinebrasil", "kinderwagenkino", "berlatin", "cineespanol"))):
            title = rest.strip()
    alts = [b for b in _BRACKETS.findall(title) if not _VERSIONISH.match(b.strip())]
    title = _BRACKETS.sub("", title)
    title = _SUFFIXES.sub("", title).strip(" ,:–-")
    return title, alts


def _details(url: str, cache: Dict[str, dict]) -> dict:
    if url in cache:
        return cache[url]
    info: dict = {}
    try:
        soup = BeautifulSoup(get_text(url), "html.parser")
        body = soup.select_one("[itemprop=articleBody]") or soup.select_one(".item-page") or soup
        for tag in body(["script", "style"]):
            tag.decompose()
        lines = [ln.strip() for ln in body.get_text("\n").splitlines() if ln.strip()]
        credit = next((ln for ln in lines[:6] if re.search(r"\b(18|19|20)\d{2}\b", ln)), lines[0] if lines else "")
        info["credit"] = credit
        info.update(parse_credit_line(credit))
        # résumé : 1er paragraphe long (souvent allemand, parfois ES puis EN)
        info["description"] = next((ln for ln in lines[1:12] if len(ln) > 120), None)
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    cache[url] = info
    time.sleep(0.3)
    return info


def fetch(cfg: dict, start: date, days: int) -> List[Screening]:
    url = cfg.get("url", f"{_BASE}/programm")
    series = cfg.get("series_prefixes", [])
    evening_from = cfg.get("_evening_from", "00:00")
    soup = BeautifulSoup(get_text(url), "html.parser")
    end = start + timedelta(days=days)
    cache: Dict[str, dict] = {}
    out: List[Screening] = []
    for li in soup.select("li.mix"):
        try:
            dt = datetime.strptime(li.get("data-date", ""), "%Y-%m-%d %H:%M:%S").replace(tzinfo=_TZ)
        except ValueError:
            continue
        if not (start <= dt.date() < end):
            continue
        right = li.select_one(".right-mix") or li
        a = right.select_one("a.mix-title")
        if not a:
            continue
        classes = li.get("class") or []
        cat_el = right.select_one(".mix-category a")
        category = cat_el.get_text(strip=True) if cat_el else next(
            (c[4:] for c in classes if c.startswith("cat-")), "")
        tags = [c[4:].lower() for c in classes if c.startswith("tag-")]
        raw_title = a.get_text(" ", strip=True)
        intro_el = right.select_one(".mix-introtext")
        intro = intro_el.get_text(" ", strip=True) if intro_el else ""
        link = urljoin(_BASE, a.get("href", ""))
        title, alts = _clean_title(raw_title, category, series)
        _, intro_alts = _clean_title(intro.split(",")[0], category, series)

        # La page détaillée n'est utile que pour les séances qu'on gardera (soirée).
        info: dict = {}
        if dt.strftime("%H:%M") >= evening_from or dt.hour < 4:
            info = _details(link, cache)
        meta = info if info.get("year") else parse_credit_line(intro)

        version = parse_version(raw_title, intro, info.get("credit"))
        if not version:
            if "english-subtitles" in tags:
                version = "OmeU"
            elif "english-ov" in tags:
                version = "OV"
        live = any(t in tags for t in ("stummfilm-live", "orchester", "kino-orgel")) or category.upper() == "ORCHESTER"
        if "stummfilm" in tags and version in (None, "OV"):
            version = "muet"

        out.append(Screening(
            cinema=cfg["name"],
            start=dt,
            title=title,
            url=link,
            booking_url=link,
            version=version,
            original_title=title,
            alt_titles=list(dict.fromkeys(alts + intro_alts)),
            year=meta.get("year"),
            directors=meta.get("directors") or [],
            countries=meta.get("countries") or [],
            description=info.get("description"),
            category=category,
            tags=tags + [raw_title],
            live_music=live,
        ))
    return out
