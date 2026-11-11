"""Source Chamäleon Berlin (chamaeleonberlin.com, WordPress) : cirque
contemporain dans les Hackesche Höfe (Mitte).

Tout le calendrier tient sur UNE page, /en/schedule/ (~1 Mo, dix mois
d'avance, ~240 représentations) :

    section.Schedule__month[data-month-label="November 2026"]
      article.Schedule__show                       (une représentation)
        .Schedule__date time[datetime="2026-11-11"]
        time.Schedule__time[datetime="2026-11-11T20:00:00+01:00"] -> horaire
        a.Schedule__titleLink[href=/en/shows/<slug>/]           -> titre + page
        .Schedule__informationLine--primary  -> compagnie (« by Circa »,
                                                « Machine de Cirque »)
        .Schedule__informationLine           -> « Preview », « Schulklassentag /
                                                Schools Day », audiodescription…
        .Schedule__booking a.Schedule__ticketButton -> « Tickets » / « Limited
                                                tickets » (lien Eventim)

Langue : le cirque contemporain se passe de langue, donc chaque date est
« accessible sans parler allemand ». On le dit honnêtement dans la note
(« No language needed (circus) », rendue « Aucune langue requise (cirque) »
par language.detect) plutôt que d'inventer des surtitres. La page de chaque
spectacle (3–4 pages, lues en parallèle) porte un champ « Language: none » ou
« Language note: few english dialogues » : si un spectacle y est annoncé en
allemand (pièce parlée), il n'est PAS compté comme accessible.

Complet : aucun exemple au 2026-11-11 (le bouton dit « Tickets » ou « Limited
tickets ») ; on lit « Sold out » / « Ausverkauft » dans la zone billets, et
une date sans lien billets reste « inconnue » (None).
"""
from __future__ import annotations

import re
from datetime import date
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..fetch import fetch_html, fetch_many
from ..models import Show

THEATER = "Chamäleon Berlin"
VENUE = "Hackesche Höfe"
NO_LANGUAGE = "No language needed (circus)"
_BASE = "https://chamaeleonberlin.com"
_SKIP = re.compile(r"schulklassen|schools? day|cancel|abgesagt|entf(?:ä|ae)llt", re.I)
_SOLD = re.compile(r"sold\s*out|ausverkauft", re.I)
_GERMAN = re.compile(r"\b(?:german|deutsch)", re.I)
_ENGLISH = re.compile(r"\b(?:english|englisch)", re.I)
_LITTLE = re.compile(r"\b(?:few|some|little|minimal|hardly|wenige?|kaum)\b", re.I)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\xad", "")).strip()


def collect(url: str) -> List[Show]:
    """`url` = https://chamaeleonberlin.com/en/schedule/"""
    shows = parse(fetch_html(url))
    pages = fetch_many(sorted({s.url for s in shows if s.url}), timeout=15.0)
    langs = {u: page_language(h) for u, h in pages.items()}
    return [apply_language(s, langs.get(s.url)) for s in shows]


def page_language(html: str) -> Optional[str]:
    """Valeur du champ « Language: … » / « Language note: … » de la page du
    spectacle (« none », « few english dialogues »), None s'il n'y en a pas."""
    text = _clean(BeautifulSoup(html, "html.parser").get_text(" "))
    m = re.search(r"\b(?:Language(?:\s+note)?|Sprache)\s*:\s*(.{1,60}?)(?=\s+(?:Duration|Dauer|Age|Alter|Content)\b|$)",
                  text, re.I)
    return _clean(m.group(1)) if m else None


def language_label(field: Optional[str]) -> Tuple[str, bool]:
    """Champ langue de la page -> (libellé pour la note, accessible sans allemand).

    « none », « few english dialogues », absent -> pas de barrière de langue ;
    « German » -> pièce parlée en allemand (non accessible) ; « English » ->
    jouée en anglais."""
    f = (field or "").strip()
    if not f or re.fullmatch(r"(?:none|keine|no(?:ne)?|-|–)\.?", f, re.I) or _LITTLE.search(f):
        return NO_LANGUAGE, True
    if _ENGLISH.search(f):
        return ("In English and German" if _GERMAN.search(f) else "In English"), True
    if _GERMAN.search(f):
        return "In German", False
    return NO_LANGUAGE, True


def apply_language(show: Show, field: Optional[str]) -> Show:
    label, ok = language_label(field)
    credit = [p for p in (show.languages or "").split(" · ") if p and p != NO_LANGUAGE]
    show.languages = " · ".join([*credit, label])
    show.has_english_surtitles = ok
    return show


def parse(html: str, today: Optional[date] = None) -> List[Show]:
    """Toutes les représentations du calendrier, en « No language needed »
    par défaut (collect() corrige ensuite d'après la page du spectacle)."""
    today_iso = (today or date.today()).isoformat()
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []
    seen = set()
    for art in soup.select("article.Schedule__show"):
        show = _parse_show(art)
        if not show or show.date < today_iso:
            continue
        k = (show.title, show.date, show.time)
        if k not in seen:
            seen.add(k)
            shows.append(show)
    # Date avec audiodescription en ligne « primaire » : la compagnie manque ;
    # on la reprend d'une autre date du même spectacle.
    credit = {s.title: s.languages for s in shows if s.languages != NO_LANGUAGE}
    for s in shows:
        if s.languages == NO_LANGUAGE and s.title in credit:
            s.languages = credit[s.title]
    return shows


def _parse_show(art) -> Optional[Show]:
    link = art.select_one("a.Schedule__titleLink") or art.select_one(".Schedule__title a")
    title = _clean(link.get_text(" ")) if link else ""
    if not title:
        return None
    t = art.select_one("time.Schedule__time[datetime]")
    d = art.select_one(".Schedule__date time[datetime]")
    stamp = (t.get("datetime") if t else None) or (d.get("datetime") if d else "")
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?", stamp or "")
    if not m:
        return None
    iso = m.group(1)
    time_str = f"{m.group(2)}:{m.group(3)}" if m.group(2) else (_clean(t.get_text()) if t else None)

    lines = [_clean(x.get_text(" ")) for x in art.select(".Schedule__informationLine")]
    if any(_SKIP.search(x) for x in lines):
        return None                            # journée scolaire / annulée : pas pour le public
    primary = art.select_one(".Schedule__informationLine--primary")
    company = _clean(primary.get_text(" ")) if primary else ""
    # « mit Audiodeskription… » peut être la ligne « primaire » : ce n'est pas la compagnie.
    if re.match(r"(?:mit|with|und|and|ergänzt)\b", company, re.I):
        company = ""
    if company and not re.match(r"(?:by|von)\b", company, re.I):
        company = f"by {company}"

    booking = art.select_one(".Schedule__booking")
    btn = booking.select_one("a[href]") if booking else None
    btext = _clean(booking.get_text(" ")) if booking else ""
    if _SOLD.search(btext):
        sold_out: Optional[bool] = True
    elif btn is not None:
        sold_out = False
    else:
        sold_out = None

    return Show(
        theater=THEATER,
        title=title,
        date=iso,
        time=time_str,
        venue=VENUE,
        url=urljoin(_BASE, link["href"]) if link.get("href") else None,
        languages=" · ".join(p for p in (company or None, NO_LANGUAGE) if p),
        has_english_surtitles=True,
        sold_out=sold_out,
        booking_url=btn["href"] if btn is not None and not _SOLD.search(btext) else None,
    )
