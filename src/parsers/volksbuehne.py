"""Parser pour le programme de la Volksbühne.

Structure (server-rendered) :

    li.activity
      time[datetime="YYYY-MM-DDTHH:MM:SS+..."] -> date + horaire
      p.activity__stage                        -> lieu
      h3.activity__title a                     -> titre + lien détail
      p.activity__production-type-label        -> type (Lecture Performance, ...)
      .ticket-status                           -> statut (classe --sold-out si complet)
      a.ticket-button                          -> lien de résa

L'info de langue apparaît dans le texte : "with English surtitles",
"In German and English", "In English", "With German and English surtitles".
"""
from __future__ import annotations

from typing import List

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

_BASE = "https://www.volksbuehne-berlin.de"


def collect(url: str) -> List[Show]:
    return parse(fetch_html(url))


def _has_english(text: str) -> tuple[bool, str | None]:
    low = text.lower()
    markers = [
        "with english surtitles",
        "german and english surtitles",
        "in german and english",
        "german and english",
        "in english",
        "english surtitles",
    ]
    for m in markers:
        if m in low:
            return True, m
    return False, None


def parse(html: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []

    for act in soup.select("li.activity"):
        title_a = act.select_one("h3.activity__title a")
        if not title_a:
            continue
        title = title_a.get_text(strip=True)
        href = title_a.get("href") or ""
        url = href if href.startswith("http") else _BASE + href

        full_text = act.get_text(" ", strip=True)
        is_en, marker = _has_english(full_text)

        date, time_str = "", None
        time_el = act.select_one("time[datetime]")
        if time_el:
            dt = (time_el.get("datetime") or "").strip()
            if "T" in dt:
                date, clock = dt.split("T", 1)
                time_str = clock[:5]
            else:
                date = dt

        stage_el = act.select_one("p.activity__stage")
        venue = stage_el.get_text(strip=True) if stage_el else None

        type_el = act.select_one("p.activity__production-type-label")
        prod_type = type_el.get_text(strip=True) if type_el else None

        status = act.select_one(".ticket-status")
        sold_out = bool(status and "ticket-status--sold-out" in (status.get("class") or []))

        button = act.select_one("a.ticket-button")
        booking_url = button.get("href") if button else None

        shows.append(
            Show(
                theater="Volksbühne",
                title=title,
                date=date,
                time=time_str,
                venue=venue,
                url=url,
                languages=marker,
                production_type=prod_type,
                has_english_surtitles=is_en,
                sold_out=sold_out,
                booking_url=booking_url,
            )
        )
    return shows
