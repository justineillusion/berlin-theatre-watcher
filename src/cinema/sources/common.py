"""Analyse des lignes de générique à l'allemande.

    « USA 2006, 123 min, Regie: Sofia Coppola, mit Kirsten Dunst… »
    « Mulholland Drive [Straße der Finsternis] [OmU] FR, USA, 2001, R: David Lynch mit … »
    « Clockwork Kubrick: 2001: A Space Odyssey [OmU], GB USA 1968, R: Stanley Kubrick … »
"""
from __future__ import annotations

import re
from typing import List

# L'année du film : précédée d'un pays, suivie d'une virgule / d'un point / de « R: ».
# (« 2001: A Space Odyssey » ne doit PAS être pris pour une année.)
_YEAR_RE = re.compile(r"(?<![\d:])\b((?:18|19|20)\d{2})\b(?=\s*(?:,|\.|;|$|R:|Regie|\d+\s*min|\)|\[|/|–|-\s))")
_DIRECTOR_RE = re.compile(
    r"(?:\bR:|\bRegie:|\bDirector:|\bDirected by)\s*([^,.;\[\]…]+?)(?=\s+mit\b|\s+with\b|,|\.|;|\[|…|$)",
    re.I,
)

_COUNTRY_WORDS = {
    "usa", "uk", "gb", "d", "f", "i", "e", "a", "ch", "fr", "it", "es", "jp", "in", "col", "br", "de",
    "deutschland", "frankreich", "italien", "spanien", "japan", "hongkong", "hong", "kong", "china",
    "polen", "israel", "österreich", "schweiz", "belgien", "niederlande", "dänemark", "schweden",
    "norwegen", "finnland", "russland", "ukraine", "iran", "indien", "korea", "süd-korea", "südkorea",
    "mexiko", "argentinien", "brasilien", "chile", "kolumbien", "peru", "kanada", "australien",
    "türkei", "griechenland", "portugal", "ungarn", "tschechien", "rumänien", "bulgarien", "taiwan",
    "thailand", "senegal", "ägypten", "marokko", "tunesien", "libanon", "palästina", "georgien",
    "irland", "island", "colombia", "peru/colombia", "ddr", "brd", "sowjetunion", "udssr", "ussr",
    "schw", "bel", "nl", "dk", "se", "no", "pl", "ru", "cn", "hk", "kr", "tw", "ir", "il", "mx", "ar",
    "ca", "au", "tr", "gr", "pt", "hu", "cz", "ro", "bg", "at", "ie", "us", "germany", "france",
    "italy", "spain", "austria",
}


def _countries_before(text: str, end: int) -> List[str]:
    head = text[max(0, end - 60):end]
    tokens = re.split(r"[\s,/]+", head.strip())
    found: List[str] = []
    for tok in reversed(tokens):
        clean = tok.strip("[]().:;")
        if not clean:
            continue
        if tok.endswith(("]", ")", ":")) or clean.lower() not in _COUNTRY_WORDS and not (
            clean.isupper() and len(clean) <= 3
        ):
            break
        found.append(clean)
    return list(reversed(found))


def parse_credit_line(text: str) -> dict:
    """Renvoie {year, countries, directors} (clés absentes si introuvables)."""
    text = text.replace("\xa0", " ").replace(" ", " ")
    info: dict = {}
    for m in _YEAR_RE.finditer(text):
        countries = _countries_before(text, m.start())
        if countries or re.search(r"(R:|Regie|Director)", text[m.end():m.end() + 30]):
            info["year"] = int(m.group(1))
            info["countries"] = countries
            break
    m = _DIRECTOR_RE.search(text)
    if m:
        names = re.split(r"\s+(?:und|and|&)\s+|,", m.group(1))
        names = [n.strip(" :") for n in names if n.strip(" :")]
        if names and len(names[0]) < 60:
            info["directors"] = names
    return info
