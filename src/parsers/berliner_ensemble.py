"""Parser pour la page 'English surtitles' du Berliner Ensemble.

Toutes les représentations listées sur cette page ont, par définition, des
surtitres anglais. Structure (server-rendered) :

    li.s-schedule-performance__group-list-item   (un jour)
      time[datetime="YYYY-MM-DD"]                (date du jour)
      ul.s-schedule-performance__list
        li.s-schedule-performance__list-item     (une représentation)
          h2 a                -> titre + lien détail
          p.s-color--primary  -> auteur / metteur·se en scène
          time[datetime="HH:MM"] -> horaire
          .s-performance__time-location-wrapper p -> lieu
          a.ticket            -> lien de résa (absent si complet)
"""
from __future__ import annotations

import re
from typing import List

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

_BASE = "https://www.berliner-ensemble.de"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def collect(url: str) -> List[Show]:
    return parse(fetch_html(url))


def parse(html: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []

    for group in soup.select("li.s-schedule-performance__group-list-item"):
        day = ""
        for t in group.find_all("time"):
            dt = (t.get("datetime") or "").strip()
            if _DATE_RE.match(dt):
                day = dt
                break

        for item in group.select("li.s-schedule-performance__list-item"):
            title_a = item.select_one("h2 a")
            if not title_a:
                continue
            title = title_a.get_text(strip=True)
            href = title_a.get("href") or ""
            url = href if href.startswith("http") else _BASE + href

            subtitle_el = item.select_one("p.s-color--primary")
            subtitle = subtitle_el.get_text(strip=True) if subtitle_el else None

            time_el = item.select_one(".s-performance__time-location-wrapper time")
            time_str = time_el.get_text(strip=True).replace(".", ":") if time_el else None

            venue = None
            loc_ps = item.select(".s-performance__time-location-wrapper p")
            if len(loc_ps) >= 2:
                venue = loc_ps[-1].get_text(strip=True)

            ticket = item.select_one("a.ticket")
            booking_url = ticket.get("href") if ticket else None

            shows.append(
                Show(
                    theater="Berliner Ensemble",
                    title=title,
                    date=day,
                    time=time_str,
                    venue=venue,
                    url=url,
                    languages=subtitle,   # souvent l'auteur / metteur·se en scène
                    has_english_surtitles=True,
                    sold_out=ticket is None,
                    booking_url=booking_url,
                )
            )
    return shows
