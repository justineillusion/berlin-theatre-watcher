"""Parser pour les Berliner Festspiele (Performing Arts Season, Theatertreffen…).

Le site est une app Next.js : les listes de programme sont rendues côté
navigateur et ne contiennent aucun lien exploitable. En revanche :

- le sitemap de chaque festival liste les pages de spectacle :
      sitemap.xml?type=pages&nodePath=performing-arts-season
      -> /en/<festival>/programm/<année>/spielplan/<slug>
- chaque page de spectacle embarque du JSON-LD schema.org, un
  PerformingArtsEvent PAR représentation : date, lieu, lien de résa et
  disponibilité (offers.availability = InStock / SoldOut) ;
- et, dans __NEXT_DATA__, les langues : audioLanguages (["en", "fr"],
  ["independent"] = sans texte), utLanguages (surtitres) et un libellé
  prêt à l'emploi, languagesOverrideText (« In English and French »).

L'URL à mettre dans config.yaml est donc le sitemap du festival.

La billetterie (tickets.kbb.eu) est derrière une file d'attente queue-it : on
ne s'y fie pas et on ne la contourne pas, la disponibilité vient du JSON-LD.
"""
from __future__ import annotations

import html
import json
import re
import time
from datetime import date, datetime
from typing import List, Optional
from zoneinfo import ZoneInfo

from ..fetch import fetch_html
from ..models import Show

_BERLIN = ZoneInfo("Europe/Berlin")

# Une page de spectacle = exactement un segment après /spielplan/ (les
# sous-pages « besetzung-… », « audiodeskription-… » sont écartées).
_EVENT_URL = re.compile(r"/en/[^/]+/programm/(\d{4})/spielplan/[^/]+$")

# Pages de la rubrique qui ne sont pas des spectacles.
_NOT_EVENTS = ("inhaltshinweise", "content-notes")

_LANG_NAMES = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "ja": "Japanese", "pt": "Portuguese", "ar": "Arabic",
    "ru": "Russian", "pl": "Polish", "nl": "Dutch", "el": "Greek",
}

# On ne garde que le théâtre : le champ « form » vaut Theatre, Dance, Performance,
# Screening, Workshop… (« Theatre, Dance » pour les formes hybrides : gardé).
_KEEP_FORMS = ("theatre", "theater")

_AVAILABILITY = {"InStock": False, "LimitedAvailability": False, "SoldOut": True}


def collect(url: str) -> List[Show]:
    sitemap = fetch_html(url)
    min_year = date.today().year - 1      # une saison déborde sur l'année suivante
    pages = []
    for loc in re.findall(r"<loc>(.*?)</loc>", sitemap):
        loc = html.unescape(loc.strip())
        m = _EVENT_URL.search(loc)
        if m and int(m.group(1)) >= min_year and not loc.endswith(_NOT_EVENTS):
            pages.append(loc)

    shows: List[Show] = []
    for i, page in enumerate(pages):
        if i:
            time.sleep(0.5)               # reste poli : une page par demi-seconde
        try:
            shows.extend(parse(fetch_html(page), page))
        except Exception as exc:  # noqa: BLE001 — une page cassée n'arrête pas le reste
            print(f"   ⚠️  Festspiele — {page} : {exc}")
    return shows


def _json_ld_events(raw: str) -> List[dict]:
    events: List[dict] = []
    for block in re.findall(r'<script[^>]*ld\+json[^>]*>(.*?)</script>', raw, re.S):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                if "Event" in str(node.get("@type", "")):
                    events.append(node)
                else:
                    stack.extend(v for v in node.values() if isinstance(v, (list, dict)))
    return events


def _event_meta(raw: str) -> dict:
    """Bloc de l'événement dans __NEXT_DATA__ (langues, surtitres)."""
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', raw, re.S)
    if not m:
        return {}
    page = json.loads(m.group(1)).get("props", {}).get("pageProps", {}).get("currentPage", {})
    stack = [page]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if "times" in node and "audioLanguages" in node:
                return node
            stack.extend(v for v in node.values() if isinstance(v, (list, dict)))
        elif isinstance(node, list):
            stack.extend(node)
    return {}


def _languages(meta: dict) -> tuple[Optional[str], bool]:
    """-> (libellé, accessible sans parler allemand)."""
    audio = meta.get("audioLanguages") or []
    subs = meta.get("utLanguages") or []
    label = meta.get("languagesOverrideText")
    if not label and audio:
        if audio == ["independent"]:
            label = "No spoken word"
        else:
            names = [_LANG_NAMES.get(a, a) for a in audio if a != "independent"]
            label = "In " + " and ".join(names) if names else None
        if label and "en" in subs:
            label += ", with English surtitles"
    accessible = "en" in audio or "en" in subs or audio == ["independent"]
    return label, accessible


def parse(raw: str, page_url: str) -> List[Show]:
    meta = _event_meta(raw)
    if not any(k in (meta.get("form") or "").lower() for k in _KEEP_FORMS):
        return []
    label, accessible = _languages(meta)
    # Nom de l'artiste (« Gisèle Vienne ») : sert aux mots-clés, le titre seul
    # ne le contient pas.
    artist = re.sub(r"<[^>]+>", " ", html.unescape(meta.get("advertisingLine") or "")).strip() or None
    now = datetime.now(_BERLIN)

    shows: List[Show] = []
    for ev in _json_ld_events(raw):
        start = ev.get("startDate")
        if not start:
            continue
        when = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(_BERLIN)
        if when < now:
            continue
        if "Cancelled" in str(ev.get("eventStatus", "")):
            continue
        offers = ev.get("offers") or {}
        if isinstance(offers, list):
            offers = offers[0] if offers else {}
        availability = str(offers.get("availability", "")).rsplit("/", 1)[-1]
        location = ev.get("location") or {}
        shows.append(
            Show(
                theater="Berliner Festspiele",
                title=html.unescape(ev.get("name") or "").strip(),
                date=when.strftime("%Y-%m-%d"),
                time=when.strftime("%H:%M"),
                venue=location.get("name") if isinstance(location, dict) else None,
                url=page_url,
                languages=label,
                production_type=artist,
                has_english_surtitles=accessible,
                sold_out=_AVAILABILITY.get(availability),
                booking_url=offers.get("url"),
            )
        )
    return shows
