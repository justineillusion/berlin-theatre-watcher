"""Parsers pour les lieux d'exposition.

Une expo n'a ni représentations, ni surtitres, ni « complet » : on en extrait
juste le titre, la période (début -> fin) et le lien. Une expo = un Show avec
kind="expo", date = début (vide si inconnu) et end_date = fin.

Les collections permanentes (« until further notice », « Permanent
Exhibition ») sont écartées : ce ne sont pas des événements.

Sites gérés (HTML rendu côté serveur, pas d'API) :
    - smb.museum (Hamburger Bahnhof, Neue Nationalgalerie…) : pages
      /exhibitions/current/ et /exhibitions/preview/ de chaque musée
    - kw-berlin.de/en/exhibitions
    - co-berlin.org/en/program/exhibitions
    - berlinischegalerie.de/en/exhibitions/
    - berlin.fotografiska.com/en/exhibition (payload Next.js)
"""
from __future__ import annotations

import re
from datetime import date
from typing import List, Optional, Tuple
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    )
}


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _iso(d: int, m: int, y: int) -> str:
    if y < 100:
        y += 2000
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return ""


def _dotted_dates(text: str) -> List[str]:
    """'09.10.2026 to 27.06.2027' / '05.12.26–10.01.27' / '26.2.27 – 9.8.27'."""
    return [
        iso
        for d, m, y in re.findall(r"\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b", text)
        if (iso := _iso(int(d), int(m), int(y)))
    ]


_PARTIAL_START = re.compile(
    r"\b(\d{1,2})\.(\d{1,2})\.\s*[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b"
)


def _period(text: str) -> Tuple[str, Optional[str]]:
    """Texte de dates -> (début ISO ou "", fin ISO ou None)."""
    # « 12.02.–02.05.27 » (KW) : l'année n'est donnée qu'une fois, à la fin.
    m = _PARTIAL_START.search(text)
    if m:
        d1, m1, d2, m2, y = (int(x) for x in m.groups())
        y = y + 2000 if y < 100 else y
        end = _iso(d2, m2, y)
        start = _iso(d1, m1, y - 1 if m1 > m2 else y)
        if start and end:
            return start, end
    found = _dotted_dates(text)
    if not found:
        return "", None
    if len(found) == 1:          # « until 10.01.27 » : déjà ouverte
        return "", found[0]
    return found[0], found[-1]


def _lines(el) -> List[str]:
    """Lignes d'un élément HTML, coupées sur les <br>."""
    if el is None:
        return []
    return [_clean(x) for x in el.get_text("\n").split("\n") if _clean(x)]


def _expo(title: str, url: str, start: str, end: Optional[str], subtitle: str = "") -> Show:
    return Show(
        theater="",              # renseigné par main.collect_shows (nom du lieu)
        title=_clean(title),
        date=start,
        end_date=end,
        url=url,
        languages=_clean(subtitle) or None,   # sous-titre / artistes (affiché ✍️)
        kind="expo",
        sold_out=False,
    )


# ---------------------------------------------------------------------------
# Staatliche Museen zu Berlin (Hamburger Bahnhof, Neue Nationalgalerie, …)
# ---------------------------------------------------------------------------
def smb(url: str) -> List[Show]:
    """`url` = page /exhibitions/current/ d'un musée ; on lit aussi /preview/."""
    urls = [url]
    if "/exhibitions/current" in url:
        urls.append(url.replace("/exhibitions/current", "/exhibitions/preview"))
    shows: List[Show] = []
    for page in urls:
        shows.extend(parse_smb(fetch_html(page), page))
    return shows


def parse_smb(html: str, base: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    out: List[Show] = []
    for card in soup.select("div.smbExhibitionsList"):
        link = card.select_one("h4 a")
        if not link:
            continue
        spans = [s.get_text(" ", strip=True) for s in link.find_all("span")]
        title = spans[0] if spans else link.get_text(" ", strip=True)
        subtitle = " ".join(spans[1:])
        when = card.select_one("p")
        when_txt = when.get_text(" ", strip=True) if when else ""
        if "further notice" in when_txt.lower():
            continue                         # collection permanente
        start, end = _period(when_txt)
        out.append(_expo(title, urljoin(base, link["href"]), start, end, subtitle))
    return out


# ---------------------------------------------------------------------------
# KW Institute for Contemporary Art
# ---------------------------------------------------------------------------
def kw(url: str) -> List[Show]:
    return parse_kw(fetch_html(url), url)


def parse_kw(html: str, base: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, Show] = {}
    for a in soup.select("a.teaser__inner[href*='/exhibitions/']"):
        href = urljoin(base, a["href"])
        title_el = a.select_one(".teaser__title p")
        if not title_el or href in out:
            continue
        # « Artiste <br> <em>Titre</em> » -> « Artiste — Titre ». Les lignes
        # en plus (« The Schering Stiftung Award … <br> Collectif – <em>…») vont
        # en sous-titre ; seule la ligne juste avant l'<em> sert d'artiste.
        em = title_el.find("em")
        work = _clean(em.get_text(" ", strip=True)) if em else ""
        if em:
            em.extract()
        lines = [ln.strip(" –-") for ln in _lines(title_el)]
        lines = [ln for ln in lines if ln]
        artist = lines[-1] if lines else ""
        extra = " · ".join(lines[:-1])
        title = f"{artist} — {work}" if artist and work else (work or artist)
        label = a.select_one(".teaser__label")
        start, end = _period(label.get_text(" ", strip=True) if label else "")
        out[href] = _expo(title, href, start, end, extra)
    return list(out.values())


# ---------------------------------------------------------------------------
# C/O Berlin
# ---------------------------------------------------------------------------
_CO_RANGE = re.compile(
    r"([A-Z][a-z]{2})[a-z]*\.? (\d{1,2})(?:, (\d{4}))?\s*[–-]\s*([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})"
)


def co_berlin(url: str) -> List[Show]:
    return parse_co_berlin(fetch_html(url), url)


def parse_co_berlin(html: str, base: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, Show] = {}
    for art in soup.select("article.node--type-exhibition"):
        a = art.find("a", href=True)
        if not a:
            continue
        href = urljoin(base, a["href"])
        if href in out:
            continue
        name_el = art.select_one(".field--name-title")
        sub_el = art.select_one(".field--name-field-subtitle")
        when_el = art.select_one(".date-display-range, .field--name-field-date-and-time")
        if name_el and when_el:
            parts = [name_el.get_text(" ", strip=True)]
            if sub_el:
                # « Cliffs Among Dreams . After Nature Prize 26 » -> 2 parties
                parts += [x for x in re.split(r"\s+\.\s+", sub_el.get_text(" ", strip=True)) if x]
            parts.append(when_el.get_text(" ", strip=True))
        else:
            parts = [p for p in art.get_text("|", strip=True).split("|") if p.strip()]
        text = " ".join(parts)
        m = _CO_RANGE.search(text)
        if not m:
            continue
        m1, d1, y1, m2, d2, y2 = m.groups()
        mo1, mo2 = _MONTHS.get(m1.lower()), _MONTHS.get(m2.lower())
        if not mo1 or not mo2:
            continue
        y2i = int(y2)
        start = _iso(int(d1), mo1, int(y1) if y1 else y2i)
        end = _iso(int(d2), mo2, y2i)
        # Titre = textes qui précèdent la ligne de dates, hors crédits photo
        # (« © … », « …, 1990; from the … »).
        head: List[str] = []
        for p in parts:
            if _CO_RANGE.search(p):
                break
            if "©" in p or re.search(r",\s*(19|20)\d{2}\s*;", p):
                continue
            head.append(p.strip(" ."))
        if not head:
            continue
        title = " — ".join(head[:2])
        subtitle = " · ".join(head[2:])
        out[href] = _expo(title, href, start, end, subtitle)
    return list(out.values())


# ---------------------------------------------------------------------------
# Berlinische Galerie
# ---------------------------------------------------------------------------
def berlinische_galerie(url: str) -> List[Show]:
    return parse_berlinische_galerie(fetch_html(url), url)


def parse_berlinische_galerie(html: str, base: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, Show] = {}
    for a in soup.select("a[href*='/exhibitions/current/'], a[href*='/exhibitions/preview/']"):
        href = urljoin(base, a["href"])
        if href in out:
            continue
        box = a.select_one(".o-grid-floaty__text, .cards__text") or a
        h3 = box.find("h3")
        if not h3:
            continue
        name = " ".join(_lines(h3))
        paras = [
            ln
            for p in box.find_all("p")
            if not p.find("time") and not p.find_parent(class_=re.compile("date"))
            for ln in _lines(p)
        ]
        paras = [p for p in paras if p and not _dotted_dates(p) and p not in ("until", "–")]
        title = f"{name} — {paras[0]}" if paras else name
        times = [t.get("datetime", "")[:10] for t in box.find_all("time") if t.get("datetime")]
        if times:
            start, end = (times[0], times[-1]) if len(times) > 1 else ("", times[0])
        else:
            start, end = _period(box.get_text(" ", strip=True))
        if not end:
            # Sans date de fin, c'est un lieu/une installation permanente.
            continue
        out[href] = _expo(title, href, start, end, " · ".join(paras[1:]))
    return list(out.values())


# ---------------------------------------------------------------------------
# Fotografiska Berlin (Oranienburger Str.)
# ---------------------------------------------------------------------------
# Site Next.js (CMS Sanity) : la page /en/exhibition embarque dans son payload
# « flight » (self.__next_f.push) les listes currentExhibitions et
# upcomingExhibitions avec date de début/fin exactes. Repli : les cartes HTML
# (« Until 14 Mar 2027 », « From 5 Dec 2026 »).
_FOTO_FLIGHT = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
_FOTO_DATE = re.compile(r"(\d{1,2}) ([A-Z][a-z]{2})[a-z]* (\d{4})")


def fotografiska(url: str) -> List[Show]:
    return parse_fotografiska(fetch_html(url), url)


def _foto_flight_lists(html: str) -> Optional[List[dict]]:
    import json

    try:
        flight = "".join(json.loads(f'"{c}"') for c in _FOTO_FLIGHT.findall(html))
    except ValueError:
        return None
    dec = json.JSONDecoder()
    found: Optional[List[dict]] = None
    for key in ("currentExhibitions", "upcomingExhibitions"):
        for m in re.finditer(rf'"{key}":\s*(?=\[)', flight):
            try:
                arr, _ = dec.raw_decode(flight, m.end())
            except ValueError:
                continue
            found = (found or []) + [e for e in arr if isinstance(e, dict)]
    return found


def _foto_title(name: str, sub: str) -> Tuple[str, str]:
    name = _clean((name or "").replace(" ", " "))
    sub = _clean((sub or "").replace(" ", " "))
    return (f"{name} — {sub}" if name and sub else name or sub), name


def parse_fotografiska(html: str, base: str) -> List[Show]:
    out: dict[str, Show] = {}
    root = re.sub(r"/exhibition[s]?(/.*)?$", "", base.rstrip("/"))  # …/en
    for e in _foto_flight_lists(html) or []:
        slug = e.get("href") or ""
        if not slug or e.get("pageType") not in (None, "exhibition"):
            continue
        if e.get("market") not in (None, "berlin"):
            continue
        href = slug if slug.startswith("http") else f"{root}/exhibitions/{slug.strip('/')}"
        title, _ = _foto_title(e.get("title", ""), e.get("subtitle", ""))
        if title and href not in out:
            out[href] = _expo(title, href, (e.get("date") or "")[:10], (e.get("endDate") or "")[:10] or None)
    if out:
        return list(out.values())

    # Repli HTML : cartes <a href="/en/exhibitions/slug">
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select("a[href*='/exhibitions/']"):
        href = urljoin(base, a["href"])
        h3 = a.find(["h3", "h2"])
        if not h3 or href in out:
            continue
        sub = a.select_one("p em") or a.select_one("p[class*='subtitle']")
        title, _ = _foto_title(h3.get_text(" ", strip=True), sub.get_text(" ", strip=True) if sub else "")
        label = a.find("p")
        label_txt = label.get_text(" ", strip=True) if label else ""
        dates = []
        for d, mon, y in _FOTO_DATE.findall(label_txt):
            if (mo := _MONTHS.get(mon.lower())) and (iso := _iso(int(d), mo, int(y))):
                dates.append(iso)
        low = label_txt.lower()
        if low.startswith("until") and dates:
            start, end = "", dates[0]
        elif low.startswith("from") and dates:
            start, end = dates[0], None
        elif len(dates) >= 2:
            start, end = dates[0], dates[-1]
        else:
            start, end = "", None
        out[href] = _expo(title, href, start, end)
    return list(out.values())
