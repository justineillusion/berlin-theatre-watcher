"""Source Schaubühne.

Le programme n'est pas dans le HTML de la page : il est chargé en AJAX (POST)
page par page via  programme.html?ajax=1&offset=N&letzterTermin=0  jusqu'à ce que
la réponse soit "ende erreicht.". Chaque représentation est un <div> portant une
seule classe date-DDMMYY et contenant un lien vers /produktionen/ (+ Eventim).
Le marqueur de surtitres est le texte "With English surtitles".
"""
from __future__ import annotations

import re
from typing import List
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from ..models import Show

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_DATE_RE = re.compile(r"^date-(\d{2})(\d{2})(\d{2})$")
_TIME_RE = re.compile(r"(\d{1,2})\.(\d{2})")
_VENUE_RE = re.compile(r"(Stage [A-Za-z]+|Globe|Studio|Saal|Foyer)")
_MAX_PAGES = 20


def collect(url: str) -> List[Show]:
    headers = {"User-Agent": _UA, "Accept-Language": "en", "X-Requested-With": "XMLHttpRequest"}
    shows: List[Show] = []
    with httpx.Client(follow_redirects=True, headers=headers, timeout=30.0) as client:
        client.get(url)  # amorce les cookies
        for page in range(1, _MAX_PAGES + 1):
            resp = client.post(f"{url}?ajax=1&offset={page}&letzterTermin=0", data={})
            body = resp.text
            if body.strip() == "ende erreicht." or len(body) < 50:
                break
            shows.extend(_parse_page(body, url))
    return shows


def _parse_page(html: str, base: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    out: List[Show] = []
    for div in soup.find_all("div"):
        date_classes = [c for c in (div.get("class") or []) if c.startswith("date-")]
        if len(date_classes) != 1:
            continue                       # les en-têtes ont plusieurs classes date-
        m = _DATE_RE.match(date_classes[0])
        if not m:
            continue
        prod = div.select_one('a[href*="produktionen"]')
        if not prod:
            continue

        day, month, yy = m.groups()
        date = f"20{yy}-{month}-{day}"
        title = prod.get_text(strip=True)
        # les liens sont "./produktionen/..." relatifs à /en/ (pas /en/schedule/)
        href = (prod.get("href") or "").lstrip("./")
        prod_url = urljoin("https://www.schaubuehne.de/en/", href)

        full = div.get_text(" ", strip=True)
        details = full.split("Mit dem Aufruf")[0]   # retire le disclaimer YouTube

        time_m = _TIME_RE.search(details)
        time_str = f"{int(time_m.group(1)):02d}:{time_m.group(2)}" if time_m else None

        venue_m = _VENUE_RE.search(details)
        venue = venue_m.group(1) if venue_m else None

        subtitle = re.sub(r"\s+", " ", details.replace(title, " "))
        # retire le bruit de tête « Sat Sat 19 20.00–21.30 20.00–21.30 »
        subtitle = re.sub(
            r"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|\d{1,2}[:.]\d{2}|\d{1,2}|[–\-.\s])+",
            "",
            subtitle,
        )
        subtitle = subtitle.replace("Ticket", "").strip(" .|")[:200] or None

        ticket = div.select_one('a[href*="eventim"]')
        sold_out = "ausverkauft" in full.lower() or ticket is None

        out.append(
            Show(
                theater="Schaubühne",
                title=title,
                date=date,
                time=time_str,
                venue=venue,
                url=prod_url,
                languages=subtitle,          # auteur / metteur·se en scène
                has_english_surtitles="english surtitles" in full.lower(),
                sold_out=sold_out,
                booking_url=ticket.get("href") if ticket else None,
            )
        )
    return out
