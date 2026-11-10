"""Les trois maisons d'opéra berlinoises.

Comme pour les théâtres, un Show = UNE représentation (date + heure, heure de
Berlin) ; matching.select() les regroupe ensuite en une entrée par production.

Surtitres anglais — ce que disent les sites (vérifié le 2026-11-10) :

- Staatsoper Unter den Linden : chaque DATE porte sa ligne « Language: In
  Italian language with German and English surtitles » sur la page de la
  production (parfois « Englisch », coquille du site). On ne garde comme
  « surtitré anglais » que les dates qui le disent ; les spectacles pour
  enfants (« In German language ») et la retransmission sur Bebelplatz (pas de
  ligne de langue) ne passent donc pas.
- Deutsche Oper Berlin : l'info est donnée PAR PRODUCTION (encadré « Language »
  de la page production : « In Italian with German and English surtitles »).
  Pas partout : « Hamed & Sherifa » est « In German » sans surtitres. Le
  calendrier vient de l'API JSON du site (event.json), la langue des pages
  production (une requête par production). La locale en_EN marche ; en_GB
  répond 503 sur les pages production.
- Komische Oper Berlin (au Schillertheater pendant les travaux) : le site
  n'annonce aucune langue de surtitres, ni par date ni par production (seule
  la langue chantée : « Russian »). La maison est connue pour ses écrans de
  traduction au dos des sièges (allemand, anglais, français, turc), pour tout
  le répertoire lyrique : on garde donc toutes les dates d'opéra / opérette /
  comédie musicale. Les visites guidées, concerts, formats du foyer et le
  programme jeune public « Jung für alle » (en allemand) sont écartés.
"""
from __future__ import annotations

import html as _html
import json
import re
from datetime import date, datetime
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from ..fetch import fetch_html, fetch_many
from ..models import Show

_MONTHS = {
    name: i + 1
    for i, names in enumerate(
        [
            ("january", "januar", "jan"), ("february", "februar", "feb"), ("march", "märz", "mar"),
            ("april", "apr"), ("may", "mai"), ("june", "juni", "jun"), ("july", "juli", "jul"),
            ("august", "aug"), ("september", "sep", "sept"), ("october", "oktober", "oct", "okt"),
            ("november", "nov"), ("december", "dezember", "dec", "dez"),
        ]
    )
    for name in names
}


def _clean(text: Optional[str]) -> str:
    """Espaces normalisés, césures conditionnelles (&shy;) retirées."""
    return re.sub(r"\s+", " ", (text or "").replace("\xad", "")).strip()


def _has_english(language_line: Optional[str]) -> bool:
    """« … with German and English surtitles », « Englisch », « In English »…"""
    return bool(language_line and re.search(r"\bengl", language_line, re.I))


# ---------------------------------------------------------------------------
# Staatsoper Unter den Linden
# ---------------------------------------------------------------------------
_SO_BASE = "https://www.staatsoper-berlin.de"
_SO_PROD = re.compile(r"/(?:de|en)/veranstaltungen/([a-z0-9-]+\.\d+)/")
_SO_WHEN = re.compile(
    r"(\d{1,2})\.?\s+([A-Za-zäÄ]+)\s+(\d{4})(?:\D+?(\d{1,2})[.:](\d{2})\s*([AP]M)?)?", re.I
)


def staatsoper(url: str) -> List[Show]:
    """`url` = page « Operas » (/en/programme/operas/, redirige vers la liste
    des œuvres de la saison) ; puis une page par production."""
    links = staatsoper_links(fetch_html(url))
    shows: List[Show] = []
    for link, page in fetch_many(links).items():
        shows.extend(parse_staatsoper(page, link))
    return shows


def staatsoper_links(html: str) -> List[str]:
    """Pages production (en anglais) listées sur la page des œuvres."""
    out: List[str] = []
    for m in _SO_PROD.finditer(html):
        link = f"{_SO_BASE}/en/veranstaltungen/{m.group(1)}/"
        if link not in out:
            out.append(link)
    return out


def _so_when(text: str) -> Tuple[str, Optional[str]]:
    """'Thursday, 12 November 2026 7.30 PM' -> ('2026-11-12', '19:30')."""
    m = _SO_WHEN.search(text)
    if not m:
        return "", None
    d, mon, y, hh, mm, ampm = m.groups()
    month = _MONTHS.get(mon.lower())
    if not month:
        return "", None
    try:
        day = date(int(y), month, int(d)).isoformat()
    except ValueError:
        return "", None
    if hh is None:
        return day, None
    h = int(hh)
    if ampm:
        h = h % 12 + (12 if ampm.upper() == "PM" else 0)
    return day, f"{h:02d}:{mm}"


def parse_staatsoper(html: str, url: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    title = _clean(h1.get_text(" ")) if h1 else ""
    if not title:
        return []
    composer = None
    werk = soup.select_one(".werkinfo")
    if werk:
        lines = [_clean(x) for x in werk.get_text("\n").split("\n") if _clean(x)]
        composer = next((ln for ln in lines if ln.lower().startswith(("music by", "musik von"))), None)

    shows: List[Show] = []
    for panel in soup.select("div.tabs__panel.js-tabs-panel"):
        when = panel.find("time")
        day, clock = _so_when(_clean(when.get_text(" "))) if when else ("", None)
        if not day:
            continue
        ticket = panel.select_one(".termin__ticket-button a[href]")
        sold_out_el = panel.select_one(".termin__ausverkauft")
        if not ticket and not sold_out_el and panel.select_one(".termin__buchungshinweis"):
            continue                    # représentation scolaire (« Beratung und Anmeldung »)
        lang_el = panel.select_one(".termin__sprache")
        lang = _clean(lang_el.get_text(" ")) if lang_el else None
        if lang:
            lang = re.sub(r"^(?:Language|Sprache)\s*:\s*", "", lang).replace("Englisch ", "English ")
        venue_el = panel.select_one('[itemprop~="location"]')
        shows.append(
            Show(
                theater="Staatsoper Unter den Linden",
                title=title,
                date=day,
                time=clock,
                venue=_clean(venue_el.get_text(" ")) if venue_el else None,
                url=url,
                languages=lang,
                production_type=composer,
                has_english_surtitles=_has_english(lang),
                sold_out=True if sold_out_el else (False if ticket else None),
                booking_url=ticket.get("href") if ticket else None,
            )
        )
    return shows


# ---------------------------------------------------------------------------
# Deutsche Oper Berlin
# ---------------------------------------------------------------------------
_DOB_OPERA_CATEGORY = "7024"      # filtre « Opera » du calendrier
_DOB_MAX_PAGES = 20               # 20 dates par page ; ~150 dates par saison


def deutsche_oper(url: str) -> List[Show]:
    """`url` = https://deutscheoperberlin.de/en_EN/calendar"""
    parts = urlsplit(url)
    root = f"{parts.scheme}://{parts.netloc}"
    locale = parts.path.strip("/").split("/")[0] or "en_EN"
    events: List[dict] = []
    for page in range(1, _DOB_MAX_PAGES + 1):
        api = (f"{root}/{locale}/event.json?current_page=calendar&category={_DOB_OPERA_CATEGORY}"
               f"&location=alle&status=&q=&date_from={date.today().isoformat()}&p={page}")
        data = json.loads(fetch_html(api))
        events.extend(data.get("EventOverview") or [])
        if (data.get("Pager") or {}).get("IsLastPage", True):
            break
    prod_urls = {deutsche_oper_production_url(e, root) for e in events}
    pages = fetch_many(sorted(u for u in prod_urls if u))
    langs = {u: deutsche_oper_language(h) for u, h in pages.items()}
    return parse_deutsche_oper(events, langs, root)


def deutsche_oper_production_url(event: dict, root: str = "https://deutscheoperberlin.de") -> str:
    slug = (event.get("Slug") or "").split("?")[0]
    return urljoin(root + "/", slug) if slug else ""


def deutsche_oper_language(html: str) -> Optional[str]:
    """Encadré de la page production : 'Language' -> 'In Italian with German and English surtitles'."""
    soup = BeautifulSoup(html, "html.parser")
    for box in soup.select(".info-box div"):
        label, text = box.select_one(".info-label"), box.select_one(".info-text")
        if label and text and _clean(label.get_text()).lower() in ("language", "sprache"):
            return _clean(text.get_text(" ")) or None
    return None


def parse_deutsche_oper(events: Iterable[dict], langs: Dict[str, Optional[str]],
                        root: str = "https://deutscheoperberlin.de") -> List[Show]:
    shows: List[Show] = []
    for e in events:
        if e.get("IsCancled"):
            continue
        year = (e.get("DateMonthYear") or "").split()[-1:] or [""]
        try:
            day = date(int(year[0]), int(e["DateMonthNum"]), int(e["DateDayNum"])).isoformat()
        except (KeyError, TypeError, ValueError):
            continue
        clock = _clean(e.get("DateTimeStart")) or None
        prod = deutsche_oper_production_url(e, root)
        lang = langs.get(prod)
        shows.append(
            Show(
                theater="Deutsche Oper Berlin",
                title=_clean(_html.unescape(e.get("Title") or "")),
                date=day,
                time=clock,
                venue=_clean(e.get("Location")) or None,
                url=prod or None,
                languages=lang,
                production_type=_clean(e.get("OpusInfoShort")) or None,
                has_english_surtitles=_has_english(lang),
                sold_out=bool(e.get("IsSoldOut")),
                booking_url=e.get("PriceUrl") or None,
            )
        )
    return [s for s in shows if s.title]


# ---------------------------------------------------------------------------
# Komische Oper Berlin
# ---------------------------------------------------------------------------
_KO_SKIP_ATTR = re.compile(r"jung für alle|concert|konzert", re.I)
_KO_SKIP_TITLE = re.compile(r"guided tour|führung|matinee|concert|konzert|sing along", re.I)


def komische_oper(url: str) -> List[Show]:
    """`url` = https://www.komische-oper-berlin.de/en/what/schedule/
    (la 1re page couvre ~2 mois ; puis une page par mois jusqu'à la fin de saison)."""
    first = fetch_html(url)
    shows = parse_komische_oper(first, url)
    for page in fetch_many(komische_oper_months(first, url)).values():
        shows.extend(parse_komische_oper(page, url))
    seen, out = set(), []
    for s in shows:
        k = (s.title, s.date, s.time)
        if k not in seen:
            seen.add(k)
            out.append(s)
    return out


def komische_oper_months(html: str, base: str) -> List[str]:
    """Pages /schedule/AAAA-MM/ après celles déjà affichées, jusqu'à data-load-forward-until."""
    m_to = re.search(r'data-dates-to="(\d{4})-(\d{2})', html)
    m_end = re.search(r'data-load-forward-until="(\d{4})-(\d{2})', html)
    m_base = re.search(r'data-base-url="([^"]+)"', html)
    if not (m_to and m_end):
        return []
    root = urljoin(base, m_base.group(1) if m_base else "/en/what/schedule/")
    y, mo = int(m_to.group(1)), int(m_to.group(2))
    end = (int(m_end.group(1)), int(m_end.group(2)))
    out: List[str] = []
    while True:
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
        if (y, mo) > end or len(out) >= 12:
            return out
        out.append(f"{root}{y:04d}-{mo:02d}/")


def parse_komische_oper(html: str, base: str) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []
    for perf in soup.select('div.performance[itemscope]'):
        link = perf.select_one("h3.headline__headline a[href]")
        start = perf.select_one('meta[itemprop="startDate"]')
        if not link or not start:
            continue                       # visites (petit titre), cases vides
        title = _clean(link.get_text(" "))
        attrs = _clean(perf.select_one(".performance__attributes").get_text(" ")) \
            if perf.select_one(".performance__attributes") else ""
        if _KO_SKIP_TITLE.search(title) or _KO_SKIP_ATTR.search(attrs):
            continue
        try:
            when = datetime.fromisoformat(start.get("content", ""))
        except ValueError:
            continue
        href = urljoin(base, link.get("href", ""))
        # /en/what/schedule/eugene-onegin/1254/ (une date) -> /en/what/a-z/eugene-onegin/ (la production)
        m = re.match(r"(https?://[^/]+/(?:en/what|spielplan)/)(?:schedule|kalender)/([^/]+)/\d+/?$", href)
        prod_url = f"{m.group(1)}a-z/{m.group(2)}/" if m else href
        author = perf.select_one(".performance__author")
        venue = perf.select_one(".performance__location")
        if venue and re.search(r"foyer|infocenter", venue.get_text(), re.I):
            continue                       # récitals / formats annexes hors grande salle
        ticket = perf.select_one(".performance__ticketbutton a.ticketbutton[href]")
        sold_out = True if perf.select_one(".performance__soldoutinfo") else (False if ticket else None)
        shows.append(
            Show(
                theater="Komische Oper Berlin",
                title=title,
                date=when.date().isoformat(),
                time=when.strftime("%H:%M"),
                venue=_clean(venue.get_text(" ")) if venue else None,
                url=prod_url,
                production_type=_clean(author.get_text(" ")) if author else None,
                has_english_surtitles=True,     # écrans de traduction (voir docstring du module)
                sold_out=sold_out,
                booking_url=urljoin(base, ticket["href"]) if ticket else None,
            )
        )
    return shows
