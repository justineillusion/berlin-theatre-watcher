"""Source English Theatre Berlin | International Performing Arts Center (etberlin.de, WordPress).

Le calendrier tient sur UNE page, /calendar/ :

    h4.month-head                      -> « November 2026 »
    article.production-single          (une représentation)
      .date                            -> « 28 »
      .time span                       -> « Sat | 8pm » ; span.stage -> « Main Stage »
      h3.production-title a            -> titre + page production
      .title h4                        -> « The world premiere of … by Opera Lab Berlin »
      .ticket a                        -> billetterie (Eventbrite…)

Langue : tout s'y joue en anglais (« In English ») ; une soirée annoncée « bilingual »
le dit (« In English and German »). Complet : « sold out » / « ausverkauft » dans la
zone billets ; sans lien billets, inconnu (None).
"""
from __future__ import annotations

import re
from typing import List, Optional

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

THEATER = "English Theatre Berlin"
_MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september",
     "october", "november", "december"])}
_TIME = re.compile(r"(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)", re.I)
_SKIP = re.compile(r"\bworkshops?\b|\bschool\b|audition|cancel|abgesagt", re.I)
_SOLD = re.compile(r"sold[\s_-]*out|ausverkauft", re.I)


def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").replace("\xad", "")).strip()


def _hhmm(text: str) -> Optional[str]:
    m = _TIME.search(text or "")
    if not m:
        return None
    h, mi, ap = int(m.group(1)), m.group(2) or "00", m.group(3).lower()
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    return f"{h:02d}:{mi}"


def collect(url: str) -> List[Show]:
    """`url` = https://www.etberlin.de/calendar/"""
    return parse(fetch_html(url))


def parse(html: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    root = soup.select_one(".production-list") or soup
    shows: List[Show] = []
    year = month = None
    for el in root.find_all(["h4", "article"]):
        if el.name == "h4" and "month-head" in (el.get("class") or []):
            m = re.match(r"([A-Za-z]+)\s+(\d{4})", _clean(el.get_text()))
            if m and m.group(1).lower() in _MONTHS:
                month, year = _MONTHS[m.group(1).lower()], int(m.group(2))
            continue
        if el.name != "article" or "production-single" not in (el.get("class") or []) or not year:
            continue
        a = el.select_one("h3.production-title a")
        d = el.select_one(".date")
        if not a or not d or not re.match(r"^\d{1,2}$", _clean(d.get_text())):
            continue
        title = _clean(a.get_text())
        sub = el.select_one(".title h4")
        tagline = _clean(sub.get_text(" ")) if sub else ""
        if _SKIP.search(f"{title} {tagline}"):
            continue
        spans = el.select(".time span")
        stage = el.select_one(".time .stage")
        ticket = el.select_one(".ticket")
        sold: Optional[bool] = None
        booking = None
        if ticket is not None:
            if _SOLD.search(ticket.get_text(" ") + " " + str(ticket)):
                sold = True
            else:
                link = ticket.select_one("a[href^=http]")
                if link:
                    sold, booking = False, link["href"]
        lang = "In English and German" if re.search(r"bilingual|zweisprachig", tagline, re.I) else "In English"
        shows.append(Show(
            theater=THEATER,
            title=title,
            date=f"{year}-{month:02d}-{int(_clean(d.get_text())):02d}",
            time=_hhmm(spans[0].get_text()) if spans else None,
            venue=_clean(stage.get_text()) if stage else None,
            url=a.get("href") or None,
            languages=" · ".join(p for p in (tagline, lang) if p),
            has_english_surtitles=True,          # joué en anglais
            sold_out=sold,
            booking_url=booking,
        ))
    return shows
