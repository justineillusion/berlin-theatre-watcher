"""Berliner Philharmoniker — concerts à la Philharmonie (grande salle + salle de musique de chambre).

Le calendrier du site est une appli Vue qui interroge un moteur de recherche
(Typesense) : rien dans le HTML. On passe donc par les pages d'abonnements,
rendues côté serveur :

    /en/concerts/subscriptions-and-flex-packages/            (index)
      -> …/symphonic-subscriptions/2026-27/                  (saison en cours)
      -> …/chamber-music-jazz-world/2026-27/
         -> …/series-a/ … series-z/                         (une page par série)
            -> /en/concert/calendar/57079/                  (un programme)

La page d'un programme donne le titre (JSON-LD MusicEvent) et TOUTES ses
dates (blocs .ticket__info : date, heure, salle). Couverture : les concerts
d'abonnement de l'orchestre + les séries de musique de chambre / jazz /
musiques du monde (dont des ensembles invités : Chamber Orchestra of Europe…).
Les concerts « invités » hors abonnement (organisateurs extérieurs) ne sont
visibles que via la recherche JS : pas couverts.

Pas de filtre de langue (has_english_surtitles=True pour passer le filtre
commun) ; production_type="Concert" pour que l'enrichissement n'affiche pas de
« surtitres ». « Complet » : chargé en JS (bouton de prévente) -> inconnu (None).
"""
from __future__ import annotations

import html as _html
import json
import re
from datetime import datetime
from typing import List, Optional
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from ..fetch import fetch_html, fetch_many
from ..models import Show

_BASE = "https://www.berliner-philharmoniker.de"
_CATEGORY = re.compile(
    r'href="(/en/concerts/subscriptions-and-flex-packages/'
    r'(?:symphonic-subscriptions|chamber-music-jazz-world)/\d{4}-\d{2}/)"'
)
_CONCERT = re.compile(r'href="(?:https://www\.berliner-philharmoniker\.de)?(/en/concert/calendar/\d+/)"')
_HALLS = ("Main Auditorium", "Chamber Music Hall")
_TZ = ZoneInfo("Europe/Berlin")


def collect(url: str) -> List[Show]:
    """`url` = https://www.berliner-philharmoniker.de/en/concerts/subscriptions-and-flex-packages/"""
    series: List[str] = []
    for page in fetch_many(category_links(fetch_html(url))).values():
        series.extend(s for s in series_links(page) if s not in series)
    concerts: List[str] = []
    for page in fetch_many(series).values():
        concerts.extend(c for c in concert_links(page) if c not in concerts)
    shows: List[Show] = []
    for link, page in fetch_many(concerts, workers=8).items():
        shows.extend(parse_concert(page, link))
    return shows


def category_links(html: str) -> List[str]:
    return list(dict.fromkeys(_BASE + m for m in _CATEGORY.findall(html)))


def series_links(html: str) -> List[str]:
    """…/2026-27/series-a/ etc. depuis la page d'une catégorie d'abonnement."""
    pat = re.compile(
        r'href="(/en/concerts/subscriptions-and-flex-packages/'
        r'(?:symphonic-subscriptions|chamber-music-jazz-world)/\d{4}-\d{2}/series-[a-z0-9-]+/)"'
    )
    return list(dict.fromkeys(_BASE + m for m in pat.findall(html)))


def concert_links(html: str) -> List[str]:
    return list(dict.fromkeys(_BASE + m for m in _CONCERT.findall(html)))


def _title(soup: BeautifulSoup, html: str) -> str:
    for tag in soup.find_all("script", type="application/ld+json"):
        raw = tag.string or ""
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("@type") == "MusicEvent" and data.get("name"):
                return _html.unescape(data["name"]).strip()
        except ValueError:
            # JSON-LD parfois invalide (virgule en trop) : on lit le nom à la main.
            m = re.search(r'"@type"\s*:\s*"MusicEvent"\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
            if m:
                return _html.unescape(json.loads(f'"{m.group(1)}"')).strip()
    og = soup.find("meta", property="og:title")
    return _html.unescape(og.get("content", "")).strip() if og else ""


def _performers(html: str) -> Optional[str]:
    """Les 3 premiers interprètes du JSON-LD : 'Berliner Philharmoniker, Maxime Pascal (conductor), …'."""
    names = re.findall(r'"name"\s*:\s*"([^"]+)"(?:\s*,\s*"jobTitle"\s*:\s*"([^"]+)")?', html.split('"performer"', 1)[-1]) \
        if '"performer"' in html else []
    out = [f"{n} ({j})" if j else n for n, j in names[:3]]
    return _html.unescape(", ".join(out)) or None


def parse_concert(html: str, url: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    title = _title(soup, html)
    if not title:
        return []
    performers = _performers(html)
    shows: List[Show] = []
    for info in soup.select(".ticket__info"):
        p = info.find("p")
        text = re.sub(r"\s+", " ", p.get_text(" ")) if p else ""
        hall = next((h for h in _HALLS if h in text), None)
        if not hall:
            continue                     # tournée, autre lieu
        # Heure fiable : l'horodatage du bouton de prévente, sinon le texte « …, 20:00 ».
        start = None
        body = info.find_parent(class_="ticket__body")
        btn = body.find_next("button", attrs={"data-performance-start": True}) if body else None
        if btn:
            try:
                start = datetime.fromtimestamp(int(btn["data-performance-start"]), _TZ)
            except (ValueError, OverflowError):
                start = None
        t = info.find("time")
        day = (t.get("datetime") or "") if t else ""
        m = re.search(r",\s*(\d{1,2}):(\d{2})", text)
        clock = f"{int(m.group(1)):02d}:{m.group(2)}" if m else None
        if start and start.date().isoformat() == day:
            clock = start.strftime("%H:%M")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
            continue
        shows.append(
            Show(
                theater="Berliner Philharmoniker",
                title=title,
                date=day,
                time=clock,
                venue=hall,
                url=url,
                languages=performers,
                production_type="Concert",
                has_english_surtitles=True,     # pas de filtre de langue pour les concerts
                sold_out=None,                  # disponibilité chargée en JS : inconnue
                booking_url=None,               # bouton de prévente en JS : la page du concert fait foi
            )
        )
    return shows
