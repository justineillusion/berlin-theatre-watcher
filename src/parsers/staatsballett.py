"""Source Staatsballett Berlin (staatsballett-berlin.de, TYPO3).

Tout le calendrier tient sur UNE page, /en/schedule.html (~550 ko, la saison) :

    div.frame-spielplan[data-ts=<unix>][data-staette=DOP|SUL|…]   (une date)
      .ni-schedule-date .ni-schedule-dm      -> « 27.11. »
      span.time                              -> « 7:30 pm »
      .ni-venue                              -> Deutsche Oper Berlin / Staatsoper Unter den Linden
      .ni-info-badges .badge                 -> Premiere, Revival, Education, Free entry, Family…
      .ni-teaser-title a.ni-link-title h3    -> titre + page production
      .ni-event-schedule-teaser              -> « Ballet by Christian Spuck … »
      .ticketblock a                         -> btn_normal / btn_remaining_tickets (Eventim),
                                                btn_ausverkauft (« Sold out »)

Langue : la danse se passe de langue -> « No language needed (dance) », que
language.detect rend « Aucune langue requise (danse) ». On écarte ce qui n'est pas
un spectacle : cours et ateliers (badge Education, TanzTanz), rencontres et
« Premiere Talk » / « Ballettgespräch » (parlés en allemand), séances familles.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import List, Optional

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show
from ..price import parse_range

THEATER = "Staatsballett Berlin"
NO_LANGUAGE = "No language needed (dance)"
_NOT_SHOW = re.compile(r"talk|gespr(?:ä|ae)ch|einf(?:ü|ue)hrung|introduction|workshop|tanztanz", re.I)
_SKIP_BADGE = re.compile(r"education|famil|ferien|fortbildung|tanztanz", re.I)
_TIME = re.compile(r"(\d{1,2})[:.](\d{2})\s*(am|pm)?", re.I)


def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").replace("\xad", "")).strip()


def _hhmm(text: str) -> Optional[str]:
    m = _TIME.search(text or "")
    if not m:
        return None
    h, mi, ap = int(m.group(1)), m.group(2), (m.group(3) or "").lower()
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    return f"{h:02d}:{mi}"


def collect(url: str) -> List[Show]:
    """`url` = https://www.staatsballett-berlin.de/en/schedule.html"""
    return parse(fetch_html(url))


def parse(html: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []
    for f in soup.select("div.frame-spielplan"):
        badges = [_clean(b.get_text()) for b in f.select(".ni-info-badges .badge")]
        if any(_SKIP_BADGE.search(b) for b in badges):
            continue
        a = f.select_one(".ni-teaser-title a.ni-link-title")
        if not a:
            continue
        title = _clean(a.get_text())
        if not title or _NOT_SHOW.search(title):
            continue
        # « 18.11. – 20.1. » = un cours sur plusieurs semaines, pas une représentation.
        dm = [_clean(x.get_text()) for x in f.select(".ni-schedule-date.d-lg-block .ni-schedule-dm")]
        if len(dm) != 1:
            continue
        m = re.match(r"(\d{1,2})\.(\d{1,2})\.", dm[0])
        try:
            year = datetime.fromtimestamp(int(f.get("data-ts") or 0), timezone.utc).year
        except ValueError:
            continue
        if not m or year < 2000:
            continue
        day = f"{year}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
        t = f.select_one("span.time")
        venue = f.select_one(".ni-venue")
        teaser = f.select_one(".ni-event-schedule-teaser")
        blocks = f.select(".ticketblock")
        tb = blocks[-1] if blocks else None
        sold: Optional[bool] = None
        booking = None
        if tb is not None:
            if tb.select_one(".btn_ausverkauft") or re.search(r"sold\s*out|ausverkauft", tb.get_text(" "), re.I):
                sold = True
            else:
                link = tb.select_one("a.btn_normal[href^=http], a.btn_remaining_tickets[href^=http]")
                if link:
                    sold, booking = False, link["href"]
        pr = f.select_one(".ni-price-range")
        lo, hi = parse_range(_clean(pr.get_text(" ")) if pr else "")
        credits = _clean(teaser.get_text(" ")) if teaser else ""
        shows.append(Show(
            theater=THEATER,
            title=title,
            date=day,
            time=_hhmm(t.get_text()) if t else None,
            venue=_clean(venue.get_text()) if venue else None,
            url=(a.get("href") or "").split("#")[0] or None,
            languages=" · ".join(p for p in (credits, NO_LANGUAGE) if p),
            production_type=", ".join(b for b in badges if b) or None,
            has_english_surtitles=True,          # danse : accessible sans allemand
            sold_out=sold,
            booking_url=booking,
            price_min=lo, price_max=hi,
        ))
    return shows
