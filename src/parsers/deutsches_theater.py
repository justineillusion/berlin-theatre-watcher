"""Source Deutsches Theater Berlin (deutschestheater.de/en/programme/).

Le spielplan anglais est rendu côté serveur, une ligne par représentation :

    li.WeekDay                                  (un jour, p.tag#weekday-YYYYMMDD)
      li.singleEntryWrapper--event[data-filter='{"subtitles":true,…}']
        h3 a[href="/en/program/productions/<slug>"]  -> titre + page production
        p.description                                -> auteur / mise en scène
        .place-time-ticket-wrapper
          p.place  -> salle (Deutsches Theater, Kammerspiele, Box…)
          p.date   -> « 21/11/2026 »
          p.time   -> « 7:30 pm → 9:10 pm »
          .…__ticket__buy -> a (Eventim) « buy tickets now », ou « sold out »

Surtitres anglais : drapeau `subtitles` du data-filter (le filtre « English
surtitles » du site), confirmé par l'icône « English surtitles ». Les pièces
jouées en anglais (« in English » dans les étiquettes / la description)
comptent aussi.
"""
from __future__ import annotations

import json
import re
from typing import List, Optional

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

_BASE = "https://www.deutschestheater.de"
_DATE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")
_TIME = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", re.I)
_IN_EN = re.compile(r"\bin english\b|\bauf englisch\b", re.I)


def collect(url: str) -> List[Show]:
    return parse(fetch_html(url))


def _time(txt: str) -> Optional[str]:
    m = _TIME.search(txt or "")
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    return f"{h:02d}:{mi:02d}"


def _flags(el) -> dict:
    try:
        return json.loads(el.get("data-filter") or "{}")
    except ValueError:
        return {}


def parse(html: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []
    for e in soup.select("li.singleEntryWrapper--event"):
        a = e.select_one("h3 a")
        date_el = e.select_one("p.date")
        if not a or not date_el:
            continue
        m = _DATE.search(date_el.get_text(" ", strip=True))
        if not m:
            continue
        day = f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
        title = a.get_text(" ", strip=True)
        href = a.get("href") or ""
        desc_el = e.select_one("p.description")
        desc = re.sub(r"\s+", " ", desc_el.get_text(" ", strip=True)) if desc_el else ""
        tags = " ".join(t.get_text(" ", strip=True) for t in e.select("li.tag"))
        icons = " ".join(i.get("data-bs-title") or "" for i in e.select("[data-bs-title]"))
        subtitled = bool(_flags(e).get("subtitles")) or "english surtitles" in icons.lower()
        english = bool(_IN_EN.search(f"{tags} {desc}"))
        buy = e.select_one(".place-time-ticket-wrapper__ticket__buy")
        buy_txt = buy.get_text(" ", strip=True).lower() if buy else ""
        links = [x.get("href") for x in (buy.select("a[href]") if buy else [])
                 if "downloadEvent" not in (x.get("href") or "")]
        place = e.select_one("p.place")
        lang = "In German with English surtitles" if subtitled else ("In English" if english else None)
        shows.append(Show(
            theater="Deutsches Theater",
            title=title,
            date=day,
            time=_time(e.select_one("p.time").get_text(" ", strip=True) if e.select_one("p.time") else ""),
            venue=place.get_text(" ", strip=True) if place else None,
            url=href if href.startswith("http") else _BASE + href,
            languages=" · ".join(p for p in (desc, lang) if p) or None,
            has_english_surtitles=subtitled or english,
            sold_out=True if "sold out" in buy_txt or "ausverkauft" in buy_txt else (False if links else None),
            booking_url=links[0] if links else None,
        ))
    return shows
