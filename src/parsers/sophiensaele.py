"""Source Sophiensæle (sophiensaele.com/en/, théâtre indépendant, Mitte).

Le programme (bloc Livewire #section-programm de la page d'accueil) est rendu
côté serveur, une ligne par représentation :

    #section-programm article
      time[datetime="YYYY-MM-DD"]                   -> jour
      time[datetime="YYYY-MM-DDTHH:MM:SS+00:00"]    -> heure (texte « 19:00 », heure de Berlin)
      div « Place: Kantine »                        -> salle
      h3 a[href=".../en/stueck/<slug>"]             -> titre + page production
      a[href*="reservix"]                           -> billetterie (absent / « Sold out » si complet)

Langue : RIEN dans la liste. Elle vit dans la page production, encart latéral
(aside#stueck-sidebar ul li : « German with English surtitles », « English »,
« No language skills needed, English, French… », « German »). Une note peut
réserver les surtitres à certains soirs (« 27./28./29.11.: with English
surtitles ») : seules ces dates comptent alors.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Set, Tuple

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

_LANG_WORD = re.compile(r"\b(german|english|french|spanish|turkish|arabic|russian|mandarin|italian|polish|"
                        r"portuguese|hebrew|persian|ukrainian|language|surtitle|subtitle)", re.I)
_EN_SURT = re.compile(r"english (?:surtitles|subtitles)", re.I)
_NO_LANG = re.compile(r"no language skills|no language needed|without language|no spoken", re.I)
_DATES_SURT = re.compile(r"((?:\d{1,2}\.\s*/?\s*)+\d{1,2}\.\d{1,2}\.?)\s*:?\s*(?:with )?english surtitles", re.I)


def collect(url: str) -> List[Show]:
    html = fetch_html(url)
    pages: Dict[str, Tuple[Optional[str], Optional[Set[str]]]] = {}
    for link in {a.get("href") for a in BeautifulSoup(html, "html.parser").select("#section-programm article h3 a")}:
        if not link:
            continue
        try:
            pages[link] = language_of(fetch_html(link))
        except Exception:  # noqa: BLE001 — page production en panne : langue inconnue, pièce écartée
            pages[link] = (None, None)
    return parse(html, pages)


def language_of(html: str) -> Tuple[Optional[str], Optional[Set[str]]]:
    """(note de langue normalisée ou None si rien d'accessible, jours « JJ.MM » surtitrés ou None = tous)."""
    soup = BeautifulSoup(html, "html.parser")
    items = [li.get_text(" ", strip=True) for li in soup.select("aside#stueck-sidebar ul li")]
    lang = next((t for t in items if _LANG_WORD.search(t)), "")
    if _NO_LANG.search(lang):
        return "No language needed", None
    if _EN_SURT.search(lang):
        return "In German with English surtitles", None
    if re.search(r"\benglish\b", lang, re.I):
        return ("In English and German" if re.search(r"\bgerman\b", lang, re.I) else "In English"), None
    # Surtitres certains soirs seulement (note de la page).
    text = re.sub(r"\s+", " ", soup.get_text(" "))
    m = _DATES_SURT.search(text)
    if m:
        nums = [int(n) for n in re.findall(r"\d{1,2}", m.group(1))]   # « 27./28./29.11. » -> jours…, mois
        if len(nums) >= 2:
            mm = nums[-1]
            return "In German with English surtitles", {f"{d:02d}.{mm:02d}" for d in nums[:-1]}
    return None, None


def parse(html: str, pages: Dict[str, Tuple[Optional[str], Optional[Set[str]]]]) -> List[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: List[Show] = []
    for art in soup.select("#section-programm article"):
        a = art.select_one("h3 a")
        day_el = next((t for t in art.select("time[datetime]") if len(t.get("datetime", "")) == 10), None)
        if not a or not day_el:
            continue
        day = day_el["datetime"]
        hm = next((t.get_text(strip=True) for t in art.select("time[datetime]") if "T" in t.get("datetime", "")), None)
        url = a.get("href") or ""
        place = next((d.get_text(" ", strip=True).replace("Place:", "").strip()
                      for d in art.select("div") if d.get_text(strip=True).startswith("Place:")
                      and not d.find("div")), None)
        ticket = next((x.get("href") for x in art.select("a[href]") if "reservix" in (x.get("href") or "")), None)
        txt = art.get_text(" ", strip=True).lower()
        lang, only = pages.get(url, (None, None))
        ok = bool(lang) and (only is None or f"{day[8:10]}.{day[5:7]}" in only)
        shows.append(Show(
            theater="Sophiensæle",
            title=a.get_text(" ", strip=True),
            date=day,
            time=hm if hm and re.match(r"^\d{1,2}:\d{2}$", hm) else None,
            venue=place,
            url=url,
            languages=lang if ok else None,
            has_english_surtitles=ok,
            sold_out=True if ("sold out" in txt or "ausverkauft" in txt) else (False if ticket else None),
            booking_url=ticket,
        ))
    return shows
