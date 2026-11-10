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

L'URL à mettre dans config.yaml est donc le sitemap du festival. Un seul lieu
« Berliner Festspiele » couvre plusieurs programmes : nodePath accepte une liste
séparée par des virgules (…&nodePath=performing-arts-season,theatertreffen),
un sitemap est lu par programme.

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
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
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

# On garde le théâtre et la performance : le champ « form » vaut Theatre, Dance,
# Performance, Screening, Workshop, Talk, Award Ceremony… (« Theatre, Dance » pour
# les formes hybrides : gardé). Danse seule, projections, ateliers, débats : écartés.
_KEEP_FORMS = ("theatre", "theater", "performance")

_AVAILABILITY = {"InStock": False, "LimitedAvailability": False, "SoldOut": True}


def sitemap_urls(url: str) -> List[str]:
    """…&nodePath=a,b -> [sitemap de a, sitemap de b] (un seul si pas de liste)."""
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    nodes = [n.strip() for k, v in query if k == "nodePath" for n in v.split(",") if n.strip()]
    if len(nodes) <= 1:
        return [url]
    rest = [(k, v) for k, v in query if k != "nodePath"]
    return [urlunsplit(parts._replace(query=urlencode(rest + [("nodePath", n)]))) for n in nodes]


def event_pages(sitemap: str, min_year: int) -> List[str]:
    pages = []
    for loc in re.findall(r"<loc>(.*?)</loc>", sitemap):
        loc = html.unescape(loc.strip())
        m = _EVENT_URL.search(loc)
        if m and int(m.group(1)) >= min_year and not loc.endswith(_NOT_EVENTS) and loc not in pages:
            pages.append(loc)
    return pages


def collect(url: str) -> List[Show]:
    min_year = date.today().year - 1      # une saison déborde sur l'année suivante
    pages: List[str] = []
    for sm in sitemap_urls(url):
        try:
            pages.extend(p for p in event_pages(fetch_html(sm), min_year) if p not in pages)
        except Exception as exc:  # noqa: BLE001 — un programme en panne n'arrête pas l'autre
            print(f"   ⚠️  Festspiele — {sm} : {exc}")

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
        return _flight_event_meta(raw)
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


_FLIGHT_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')


def _flight_event_meta(raw: str) -> dict:
    """Depuis l'automne 2026 le site est passé à l'App Router de Next.js : plus de
    __NEXT_DATA__, les données de la page sont dans les morceaux
    `self.__next_f.push([1, "…"])` (flux RSC). On recolle le flux et on prend le
    1er objet JSON qui porte « audioLanguages » et « times » (l'événement)."""
    try:
        text = "".join(json.loads(c) for c in _FLIGHT_CHUNK.findall(raw))
    except ValueError:
        return {}
    dec = json.JSONDecoder()
    for m in re.finditer(r'"audioLanguages"\s*:', text):
        pos = m.start()
        j = pos
        for _ in range(4000):              # remonte jusqu'à l'accolade de l'objet englobant
            j = text.rfind("{", 0, j)
            if j < 0:
                break
            try:
                obj, end = dec.raw_decode(text, j)
            except ValueError:
                continue
            if end > pos and isinstance(obj, dict) and "audioLanguages" in obj:
                if "times" in obj:
                    return obj
                break
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
