"""Salles de concert (lieux « à la carte », optional: true) : Schokoladen et Urban Spree.

Pas de filtre de langue (has_english_surtitles=True pour passer le filtre commun, comme la
Philharmonie) ; production_type="Concert" pour que l'enrichissement n'affiche ni langue ni
surtitres. Seulement les concerts : lectures, soirées DJ, expos, marchés… sont écartés.

Schokoladen (schokoladen-mitte.de, Ackerstr. 169, Mitte) — tout le calendrier est rendu côté
serveur, paginé (?page=2…), un bloc par soirée, sans page détail :

    div.event
      h6.category            -> « Musik » (aussi « Lesung », « Party », « DJ » : écartés)
      p.h3 span              -> jour, « 18.11. », « 19:00 Uhr »
      span.promoter          -> organisateur (« little league shows prsnt: »)
      h2                     -> artistes (« 7ebra (indie-pop, swe) + Joy Wellboy (…) »)
    div.event-info[data-event-date="2026-11-18"][id="e20261118"]
      a.ticket-btn[href]     -> prévente (vvk.link, eventim…)
      .event-facts           -> « Time doors 19:00 - show 20:00 », parfois le prix

Urban Spree (urbanspree.com, Revaler Str. 99, Friedrichshain) — rubrique Concerts, paginée
(?page=2…), du plus lointain au plus proche ; une carte par concert :

    a.card[href="program/concerts/….html"][data-dateStart="2026-12-05 19:00:00"]
      p.title                -> titre (souvent en capitales)

puis la page du concert : h1 (« Coilguns - Berlin - Urban Spree »), prix (.ct-price
« 24.90€ »), bouton « Buy tickets » (lien de prévente).
"""
from __future__ import annotations

import re
from datetime import date
from typing import List, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..fetch import fetch_html, fetch_many
from ..models import Show
from ..price import parse_range

_SOLD = re.compile(r"ausverkauft|sold\s*out", re.I)
_TIME = re.compile(r"(\d{1,2})[:.](\d{2})")


def _clean(t: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (t or "").replace("\xa0", " ")).strip()


# ---------------------------------------------------------------------------
# Schokoladen
# ---------------------------------------------------------------------------
_SK_BASE = "https://www.schokoladen-mitte.de/"
_SK_MAX_PAGES = 12


def schokoladen(url: str = _SK_BASE) -> List[Show]:
    shows: List[Show] = []
    seen: set = set()
    for page in range(1, _SK_MAX_PAGES + 1):
        html = fetch_html(url if page == 1 else urljoin(url, f"?page={page}"))
        got = [s for s in parse_schokoladen(html, url) if (s.date, s.title) not in seen]
        if not got and page > 1:
            break
        for s in got:
            seen.add((s.date, s.title))
        shows += got
        if f"?page={page + 1}" not in html:
            break
    return shows


def parse_schokoladen(html: str, base: str = _SK_BASE, today: Optional[date] = None) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    today_iso = (today or date.today()).isoformat()
    shows: List[Show] = []
    for ev in soup.select("div.event"):
        info = ev.find_next("div", class_="event-info")
        if not info or not info.get("data-event-date"):
            continue
        day = info["data-event-date"].strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or day < today_iso:
            continue
        cat = _clean((ev.select_one("h6.category") or BeautifulSoup("", "html.parser")).get_text(" "))
        if cat and cat.lower() not in ("musik", "music", "konzert", "concert"):
            continue                                  # Lesung, Party, DJ…
        h2 = ev.select_one("h2")
        title = _clean(h2.get_text(" ")) if h2 else ""
        if not title:
            continue
        facts = info.select_one(".event-facts")
        facts_txt = _clean(facts.get_text(" ")) if facts else ""
        # « doors 19:00 - show 20:00 » : l'heure du concert ; sinon l'heure du bloc (« 19:00 Uhr »).
        show_m = re.search(r"show\s*:?\s*(\d{1,2})[:.](\d{2})", facts_txt, re.I) or \
            re.search(r"beginn\s*:?\s*(\d{1,2})[:.](\d{2})", facts_txt, re.I)
        head_m = _TIME.search(_clean(ev.select_one("p.h3").get_text(" ")) if ev.select_one("p.h3") else "")
        m = show_m or _TIME.search(facts_txt) or head_m
        clock = f"{int(m.group(1)):02d}:{m.group(2)}" if m else None
        sold_title = bool(_SOLD.search(title))
        title = re.sub(r"^\s*(?:ausverkauft|sold\s*out)\s*!*\s*[-–:]?\s*", "", title, flags=re.I) or title
        ticket = info.select_one("a.ticket-btn[href]")
        promoter = _clean((ev.select_one(".promoter") or BeautifulSoup("", "html.parser")).get_text(" ")).rstrip(":").strip()
        promoter = re.sub(r"\s*(?:prsnt|presents?|präsentiert)\s*:?\s*$", "", promoter, flags=re.I).strip()
        lo, hi = parse_range(facts_txt)
        anchor = info.get("id") or ""
        shows.append(Show(
            theater="Schokoladen",
            title=title,
            date=day,
            time=clock,
            venue=None,
            url=base.split("#")[0] + (f"#{anchor}" if anchor else ""),
            languages=promoter or None,
            production_type="Concert",
            has_english_surtitles=True,           # pas de filtre de langue pour les concerts
            sold_out=True if sold_title or _SOLD.search(facts_txt) else None,
            booking_url=ticket["href"].strip() if ticket else None,
            price_min=lo,
            price_max=hi,
        ))
    return shows


# ---------------------------------------------------------------------------
# Urban Spree
# ---------------------------------------------------------------------------
_US_BASE = "https://www.urbanspree.com/"
_US_MAX_PAGES = 10
_US_SUFFIX = re.compile(r"\s*[-–—•|,]\s*(?:berlin|urban spree)(?:\s*[-–—•|,]\s*(?:berlin|urban spree))*\s*$", re.I)


def urban_spree(url: str = _US_BASE + "program/concerts/") -> List[Show]:
    cards: List[dict] = []
    today_iso = date.today().isoformat()
    for page in range(1, _US_MAX_PAGES + 1):
        html = fetch_html(url if page == 1 else f"{url}?page={page}")
        got = urban_spree_cards(html)
        if not got:
            break
        cards += [c for c in got if c["date"] >= today_iso]
        if min(c["date"] for c in got) < today_iso:  # du plus lointain au plus proche : fini
            break
    cards = list({c["url"]: c for c in cards}.values())      # une carte peut revenir sur deux pages
    pages = fetch_many([c["url"] for c in cards])
    return [s for c in cards for s in [parse_urban_spree_event(pages.get(c["url"]), c)] if s]


# Styles reconnus dans le texte « About the Concert » (le site n'a pas de champ genre).
_GENRES = ["post-punk", "post-rock", "noise-rock", "math-rock", "stoner rock", "psych-rock", "garage rock", "indie rock",
           "hardcore", "punk", "shoegaze", "doom", "black metal", "death metal", "metal", "grunge", "emo", "rock",
           "darkwave", "cold wave", "coldwave", "synth-pop", "synthpop", "new wave", "goth", "industrial", "ebm",
           "indie-pop", "indie pop", "dream pop", "art pop", "pop", "folk", "singer-songwriter", "americana", "country",
           "blues", "soul", "r&b", "funk", "jazz", "hip-hop", "hip hop", "rap", "electronic", "techno", "ambient",
           "experimental", "noise", "krautrock", "reggae", "ska", "afrobeat", "cumbia", "world"]
_GENRE_RE = re.compile(r"(?<![\w-])(" + "|".join(re.escape(g) for g in _GENRES) + r")(?![\w-])", re.I)
_PARTY = re.compile(r"\b(?:party|parties|dj[- ]?sets?|club ?night|rave|karaoke|quiz)\b", re.I)


def us_genres(text: str, n: int = 3) -> List[str]:
    """« … their own blend of punk and extatic noise-rock … » -> ['punk', 'noise-rock']."""
    out: List[str] = []
    for m in _GENRE_RE.finditer(text or ""):
        g = m.group(1).lower().replace("hip hop", "hip-hop").replace("synthpop", "synth-pop").replace("coldwave", "cold wave")
        # « rock » / « pop » / « noise » seuls : seulement si rien de plus précis ne les contient déjà
        if g not in out and not any(g in x for x in out):
            out = [x for x in out if x not in g] + [g]
    return out[:n]


def urban_spree_cards(html: str) -> List[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out: List[dict] = []
    for a in soup.select("a.card[href]"):
        href = a["href"]
        if "program/concerts/" not in href or not href.endswith(".html"):
            continue
        m = re.match(r"(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}))?", (a.get("data-datestart") or "").strip())
        if not m:
            continue
        t = a.select_one(".title")
        out.append({
            "url": urljoin(_US_BASE, href),
            "date": m.group(1),
            "time": f"{m.group(2)}:{m.group(3)}" if m.group(2) else None,
            "title": _clean(t.get_text(" ")) if t else "",
        })
    return out


def _us_title(raw: str) -> str:
    t = _US_SUFFIX.sub("", _clean(raw))
    # Carte en capitales (« BERLIN BREAKOUT 2027 ») : on garde tel quel, c'est le nom de l'affiche.
    return t


def parse_urban_spree_event(html: Optional[str], card: dict) -> Optional[Show]:
    title = card.get("title") or ""
    lo = hi = None
    booking = None
    sold = None
    about = ""
    if html:
        soup = BeautifulSoup(html, "html.parser")
        h1 = soup.find("h1")
        if h1 and _clean(h1.get_text(" ")):
            title = _clean(h1.get_text(" "))
        price = soup.select_one(".ct-price")
        lo, hi = parse_range(_clean(price.get_text(" "))) if price else (None, None)
        btn = next((a for a in soup.find_all("a", href=True)
                    if re.search(r"tickets?", a.get_text(" "), re.I) and a["href"].startswith("http")), None)
        booking = btn["href"].strip() if btn else None
        head = _clean(" ".join(x.get_text(" ") for x in soup.select(".ct-price, h1, .ct-btns")))
        sold = True if _SOLD.search(head) else None
        full = _clean(soup.get_text(" "))
        about = full.split("About the Concert", 1)[1].split("View_all", 1)[0] if "About the Concert" in full else ""
    title = _us_title(title)
    if not title:
        return None
    if re.search(r"\b(?:workshop|flea|market|flohmarkt|exhibition|vernissage)\b", title, re.I):
        return None
    if _PARTY.search(title):
        return None                                # soirées / DJ sets : pas un concert
    genres = us_genres(about)
    return Show(
        theater="Urban Spree",
        title=title,
        date=card["date"],
        time=card.get("time"),
        venue=None,
        url=card["url"],
        languages=None,
        production_type="Concert" + (f" · {' / '.join(genres)}" if genres else ""),
        has_english_surtitles=True,               # pas de filtre de langue pour les concerts
        sold_out=sold,
        booking_url=booking,
        price_min=lo,
        price_max=hi,
    )
