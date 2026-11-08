"""Lichtblick-Kino (Kastanienallee 77) — site WordPress maison.

Chaque page du site embarque le calendrier complet des séances à venir :

    <div class="kal_tag">
      <h4 class="kal_datum">Mo <span>09<span>.11.</span></span></h4>
      <a class="kal_zeile" href="https://lichtblick-kino.org/naza/">
        <div class="kal_uhrzeit">17<span>:</span>30</div>
        <div class="kal_uebertitel"><em>Mathieu Kassovitz:</em></div>   (optionnel)
        <div class="kal_titel">Naza <span class="omu">(<span>OmeU</span>)</span></div>
        <div class="tickets" data-ticket="3682465085">…               (id de séance kinoheld)

Les métadonnées (pays, année, réalisateur) viennent de la page du film :

    <div class="film_credits"><p>Hongkong 1989, 110 min, Regie: John Woo, mit: …</p>

Le cinéma ne marque pas la version des films en allemand : séance sans
mention = version allemande (paramètre ``unmarked_version`` dans cinema.yaml).
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta
from typing import Dict, List
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from ..http import get_text
from ..models import Screening
from ..version import parse_version
from .common import parse_credit_line

_TZ = ZoneInfo("Europe/Berlin")
_DATE_RE = re.compile(r"(\d{1,2})\.(\d{1,2})\.")
_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")


def _infer_year(day: int, month: int, today: date) -> int:
    year = today.year
    if month < today.month - 6:          # calendrier qui enjambe le Nouvel An
        year += 1
    return year


def _film_details(url: str, cache: Dict[str, dict]) -> dict:
    if url in cache:
        return cache[url]
    info: dict = {}
    try:
        soup = BeautifulSoup(get_text(url), "html.parser")
        film = soup.select_one("#programm .film") or soup
        credits = film.select_one(".film_credits")
        if credits:
            info.update(parse_credit_line(credits.get_text(" ", strip=True)))
        genre = film.select_one(".titelblock .genre")
        if genre:
            info["category"] = genre.get_text(" ", strip=True)
        h2 = film.select_one(".titelblock .titel")
        if h2:
            info["version_text"] = h2.get_text(" ", strip=True)
        # 1er vrai paragraphe de texte après les crédits = résumé
        for p in film.find_all("p"):
            txt = p.get_text(" ", strip=True)
            if len(txt) > 120 and "Regie" not in txt:
                info["description"] = txt
                break
    except Exception as exc:  # noqa: BLE001 — une page film cassée ne doit pas tout bloquer
        info["error"] = str(exc)
    cache[url] = info
    time.sleep(0.3)
    return info


def fetch(cfg: dict, start: date, days: int) -> List[Screening]:
    base = cfg.get("url", "https://lichtblick-kino.org/")
    slug = cfg.get("kinoheld_slug", "lichtblick-kino-berlin")
    unmarked = cfg.get("unmarked_version")
    end = start + timedelta(days=days)
    soup = BeautifulSoup(get_text(base), "html.parser")

    seen = set()
    details: Dict[str, dict] = {}
    out: List[Screening] = []
    for day in soup.select("div.kal_tag"):
        head = day.select_one(".kal_datum")
        m = _DATE_RE.search(head.get_text("", strip=True) if head else "")
        if not m:
            continue
        d, mth = int(m.group(1)), int(m.group(2))
        try:
            the_day = date(_infer_year(d, mth, start), mth, d)
        except ValueError:
            continue
        if not (start <= the_day < end):
            continue
        for row in day.select("a.kal_zeile"):
            tm = _TIME_RE.search(row.select_one(".kal_uhrzeit").get_text("", strip=True)
                                 if row.select_one(".kal_uhrzeit") else "")
            title_el = row.select_one(".kal_titel")
            if not tm or not title_el:
                continue
            ver_el = title_el.select_one(".omu")
            ver_text = ver_el.get_text("", strip=True) if ver_el else ""
            if ver_el:
                ver_el.decompose()
            title = title_el.get_text(" ", strip=True).replace("\xa0", " ").strip(" –-")
            # « 24:00 » / « 00:30 » après minuit : on reste sur la soirée affichée
            start_dt = datetime(the_day.year, the_day.month, the_day.day, tzinfo=_TZ) + timedelta(
                hours=int(tm.group(1)), minutes=int(tm.group(2)))
            url = row.get("href")
            key = (start_dt, title)
            if key in seen:                      # le calendrier est dupliqué (mobile/desktop)
                continue
            seen.add(key)
            ticket = row.select_one("[data-ticket]")
            booking = (f"https://www.kinoheld.de/kino/berlin/{slug}/vorstellung/{ticket['data-ticket']}"
                       if ticket else url)
            info = _film_details(url, details) if url else {}
            over = row.select_one(".kal_uebertitel")
            above = over.get_text(" ", strip=True) if over else ""
            directors = info.get("directors") or []
            if not directors and above.endswith(":"):     # « Sofia Coppola: » au-dessus du titre
                directors = [above.rstrip(":").strip()]
            parts = [p.strip() for p in re.split(r"\s[–-]\s", title) if p.strip()]
            out.append(Screening(
                cinema=cfg["name"],
                start=start_dt,
                title=title,
                url=url,
                booking_url=booking,
                version=parse_version(ver_text, info.get("version_text")) or unmarked,
                alt_titles=parts if len(parts) > 1 else [],
                year=info.get("year"),
                directors=directors,
                countries=info.get("countries") or [],
                description=info.get("description"),
                category=info.get("category"),
                tags=[t for t in (row.select_one(".kal_haupttitel").get_text(" ", strip=True)
                                  if row.select_one(".kal_haupttitel") else "",) if t],
            ))
    return out
