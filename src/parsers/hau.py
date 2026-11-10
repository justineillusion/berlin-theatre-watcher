"""Source HAU Hebbel am Ufer (hebbel-am-ufer.de, TYPO3).

hau4.de n'est que la scène numérique du HAU (aucune date en cours) : le vrai
programme des trois salles (HAU1, HAU2, HAU3, + WAU) est sur
hebbel-am-ufer.de/en/programme/schedule-tickets/, un mois par page :

    …/schedule-tickets/                   -> mois en cours
    …/schedule-tickets/prodMonth/MM-YYYY/ -> mois suivants (sans cHash, ça marche)

Les mois proposés sont ceux du <select name="prodMonth">. Structure :

    div.month > .month-box h3 « November 2026 »
      li.day[data-filterDate="D-M"]
        .item[data-filterFormats=",23,994,27"]      (div ou li : une représentation)
          .floats strong            -> horaire
          a.event-venue[data-venue] -> salle (HAU1, HAU2…)
          .tagBox .tag              -> « Premiere », « Cancelled »…
          h3 / h4                   -> artiste·s / titre
          .bold.paragraph-space     -> « Part of … », accessibilité
          a.show-btn                -> page détail (/en/programme/pdetail/…)
          button.d-NNNNN            -> emplacement du bouton billets

Langue PAR DATE : data-filterFormats contient les ids du filtre « Language »
de la page (<select name="prodSprache"> : 27 = « English », 877 = « with
German and English surtitles », 831 = « English phonetic language », …). On
les traduit par le libellé du <select>, puis on ramène à la formulation
anglaise de language.detect() : « In English », « In Persian, with German and
English surtitles ». Accessible en anglais = surtitres anglais OU joué en
anglais (beaucoup de spectacles du HAU sont en anglais sans surtitres, comme
les « In English » de la Volksbühne).

Billets : chargés en AJAX (bouton .reservix-handler[data-url]) : une requête
par mois renvoie span#d-NNNNN avec « Tickets », « Few tickets », « Admission
free », « Remaining tickets at the evening box office » ou « Sold out ».
"""
from __future__ import annotations

import re
from datetime import date
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..fetch import fetch_html, fetch_many
from ..models import Show

_BASE = "https://www.hebbel-am-ufer.de"
_MAX_MONTHS = 6
_TIME_RE = re.compile(r"(\d{1,2})[:.](\d{2})")
_YEAR_RE = re.compile(r"(20\d{2})")


def collect(url: str) -> List[Show]:
    """`url` = https://www.hebbel-am-ufer.de/en/programme/schedule-tickets/"""
    first = fetch_html(url)
    pages = [first, *fetch_many(month_urls(first, url)).values()]
    # Le filtre « Language » de chaque page ne liste que les langues du mois :
    # on fusionne, au cas où un id manquerait sur une page.
    lang_ids: Dict[str, str] = {}
    for page in pages:
        lang_ids.update(languages_map(BeautifulSoup(page, "html.parser")))
    price_urls = [u for u in (price_url(p) for p in pages) if u]
    prices: Dict[str, Tuple[str, Optional[str]]] = {}
    for body in fetch_many(price_urls).values():
        prices.update(parse_prices(body))
    shows: List[Show] = []
    seen = set()
    for page in pages:
        for s in parse(page, prices, lang_ids=lang_ids):
            k = (s.title, s.date, s.time, s.venue)
            if k not in seen:
                seen.add(k)
                shows.append(s)
    return shows


def month_urls(html: str, base: str, today: Optional[date] = None) -> List[str]:
    """Pages des mois APRÈS celui affiché, d'après <select name="prodMonth">."""
    today = today or date.today()
    soup = BeautifulSoup(html, "html.parser")
    months = set()
    for opt in soup.select('select[name="prodMonth"] option'):
        m = re.fullmatch(r"(\d{2})-(\d{4})", (opt.get("value") or "").strip())
        if m and (int(m.group(2)), int(m.group(1))) > (today.year, today.month):
            months.add((int(m.group(2)), int(m.group(1))))
    return [urljoin(base, f"prodMonth/{mo:02d}-{y}/") for y, mo in sorted(months)[:_MAX_MONTHS]]


def price_url(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one(".reservix-handler[data-url]")
    return urljoin(_BASE, el["data-url"]) if el else None


def parse_prices(html: str) -> Dict[str, Tuple[str, Optional[str]]]:
    """{'d-15620': ('Tickets', 'https://shop…'), …} depuis la réponse AJAX."""
    soup = BeautifulSoup(html, "html.parser")
    out: Dict[str, Tuple[str, Optional[str]]] = {}
    for span in soup.select("span.button-list[id]"):
        a = span.find("a", href=True)
        out[span["id"]] = (re.sub(r"\s+", " ", span.get_text(" ", strip=True)), a["href"] if a else None)
    return out


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\xad", "")).strip()


def languages_map(soup: BeautifulSoup) -> Dict[str, str]:
    """{'27': 'English', '877': 'with German and English surtitles', …}"""
    out: Dict[str, str] = {}
    for opt in soup.select('select[name="prodSprache"] option'):
        v = (opt.get("value") or "").strip()
        if v.isdigit():
            out[v] = _clean(opt.get_text(" "))
    return out


def normalize_languages(labels: List[str]) -> Optional[str]:
    """['English phonetic language', 'with German and English surtitles']
    -> 'In English, with German and English surtitles'."""
    spoken: List[str] = []
    extras: List[str] = []
    for label in labels:
        lab = re.sub(r"\s*\b(?:phonetic|spoken)\s+language\b", "", label, flags=re.I).strip()
        if re.match(r"with\b", lab, re.I):
            extras.append(lab[0].lower() + lab[1:])
            continue
        if not re.search(r"\swith\s", lab, re.I) and re.search(r"\s(?:surtitles|subtitles)$", lab, re.I):
            # « English surtitles » (sans « with ») : surtitres, pas langue parlée
            extras.append("with " + lab)
            continue
        head, _, tail = _split_with(lab)
        if head and head not in spoken:
            spoken.append(head)
        if tail:
            extras.append("with " + tail)
    bits = []
    if spoken:
        bits.append("In " + " and ".join(spoken))
    bits.extend(dict.fromkeys(extras))
    if not bits:
        return None
    text = ", ".join(bits)
    return text[0].upper() + text[1:]


def _split_with(label: str) -> Tuple[str, str, str]:
    m = re.match(r"(.*?)\s+with\s+(.*)$", label, re.I)
    if not m:
        return label.strip(), "", ""
    return m.group(1).strip(), "with", m.group(2).strip()


def _is_english_friendly(language: Optional[str], title: str) -> bool:
    """Surtitres anglais, ou joué en anglais (« In English », « In English and French »)."""
    if language and re.search(r"\benglish\b", language, re.I):
        return True
    return bool(re.search(r"\(in english\)|\bin english\b", title, re.I))


def parse(html: str, prices: Optional[Dict[str, Tuple[str, Optional[str]]]] = None,
          today: Optional[date] = None, lang_ids: Optional[Dict[str, str]] = None) -> List[Show]:
    prices = prices or {}
    today_iso = (today or date.today()).isoformat()
    soup = BeautifulSoup(html, "html.parser")
    lang_ids = {**(lang_ids or {}), **languages_map(soup)}
    shows: List[Show] = []
    for month in soup.select("div.month"):
        head = month.select_one(".month-box h3")
        ym = _YEAR_RE.search(head.get_text(" ") if head else "")
        if not ym:
            continue
        year = int(ym.group(1))
        for day in month.select("li.day[data-filterdate]"):
            dm = re.fullmatch(r"(\d{1,2})-(\d{1,2})", (day.get("data-filterdate") or "").strip())
            if not dm:
                continue
            iso = f"{year:04d}-{int(dm.group(2)):02d}-{int(dm.group(1)):02d}"
            if iso < today_iso:
                continue                       # le mois en cours commence au 1er
            # div.item ou li.item selon les jours ; « disturber » = encart promo
            for item in day.select(".item[data-filterformats]"):
                if "disturber" in (item.get("class") or []):
                    continue
                show = _parse_item(item, iso, lang_ids, prices)
                if show:
                    shows.append(show)
    return shows


def _parse_item(item, iso: str, lang_ids: Dict[str, str], prices) -> Optional[Show]:
    when = item.select_one(".date .floats strong")
    if not when:
        return None                            # en-tête de festival (« 11.–21.11. »), pas une date
    tm = _TIME_RE.search(when.get_text(" "))
    time_str = f"{int(tm.group(1)):02d}:{tm.group(2)}" if tm else None
    tags = [_clean(t.get_text(" ")) for t in item.select(".tagBox .tag")]
    if any(re.search(r"cancel|abgesagt|entf(?:ä|ae)llt|postponed|verschoben", t, re.I) for t in tags):
        return None
    h3, h4 = item.select_one(".info-wrap h3"), item.select_one(".info-wrap h4")
    artist = _clean(h3.get_text(" ")) if h3 else ""
    title = _clean(h4.get_text(" ")) if h4 else artist
    # Rencontres : h3 = la série, h4 = « With Tony Njoku » -> titre complet
    if artist and re.match(r"(?:with|mit)\s", title, re.I):
        title = f"{artist} {title[0].lower()}{title[1:]}"
        artist = title
    if not title:
        return None
    venue_el = item.select_one("a.event-venue[data-venue]")
    venue = _clean(venue_el.get("data-venue", "")) if venue_el else None
    detail = item.select_one("a.show-btn[href]")
    url = urljoin(_BASE, detail["href"]) if detail else None
    cats = [_clean(c.get_text(" ")) for c in item.select(".cat-box li.cat")]

    ids = [x for x in (item.get("data-filterformats") or "").split(",") if x.strip()]
    labels = [lang_ids[i] for i in ids if i in lang_ids]
    language = normalize_languages(labels)

    sold_out: Optional[bool] = None
    booking = None
    for btn in item.find_all(class_=re.compile(r"^d-\d+$")):
        key = next(c for c in btn["class"] if re.fullmatch(r"d-\d+", c))
        if key in prices:
            label, booking = prices[key]
            sold_out = bool(re.search(r"sold out|ausverkauft", label, re.I))
            break

    note = " · ".join(p for p in ((artist if artist != title else None), language) if p) or None
    return Show(
        theater="HAU Hebbel am Ufer",
        title=title,
        date=iso,
        time=time_str,
        venue=venue,
        url=url,
        languages=note,                        # artiste·s · langue / surtitres
        production_type=" / ".join(cats) or None,
        has_english_surtitles=_is_english_friendly(language, title),
        sold_out=sold_out,
        booking_url=booking,
    )
