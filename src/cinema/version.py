"""Versions linguistiques : normalisation OmU / OmeU / OV / DF.

Codes normalisés :
  OmeU — version originale, sous-titres anglais
  OmU  — version originale, sous-titres allemands (OmdU)
  OV   — version originale sans sous-titres
  muet — film muet (intertitres), souvent avec musique live
  DF   — version allemande (doublée si le film n'est pas germanophone)
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

LABELS_FR = {
    "OmeU": "VO s-t anglais (OmeU)",
    "OmU": "VO s-t allemand (OmU)",
    "OV": "VO (OV)",
    "muet": "muet",
    "DF": "VF allemande",
    "DE": "VO allemande",
}

_PATTERNS = [
    # l'ordre compte : le plus spécifique d'abord
    (re.compile(r"\bom\s*e(ngl?)?\.?\s*u\b|\bomenglu\b|english\s+subtitles|engl\.?\s+(ut|untertitel)|mit\s+e(ngl)?\.?\s*ut\b", re.I), "OmeU"),
    (re.compile(r"\bom\s*d?\s*u\b|\bomdu\b|mit\s+(d|dt)\.?\s*ut\b|deutsche[n]?\s+untertitel", re.I), "OmU"),
    (re.compile(r"\bstummfilm\b|\bsilent\b", re.I), "muet"),
    (re.compile(r"\b(engl\.?\s*)?ov\b|\bov\s*engl|original\s*version|originalfassung|\boriginal\b", re.I), "OV"),
    (re.compile(r"\bdf\b|deutsche\s+fassung|synchron", re.I), "DF"),
]


def parse_version(*texts: Optional[str]) -> Optional[str]:
    """Cherche une mention de version dans des bouts de texte (titre, flags…)."""
    for text in texts:
        if not text:
            continue
        for pattern, code in _PATTERNS:
            if pattern.search(text):
                return code
    return None


_GERMAN_COUNTRIES = {
    "d", "de", "brd", "ddr", "deutschland", "germany", "allemagne", "a", "at",
    "österreich", "oesterreich", "austria", "autriche", "rda", "rfa",
}


def is_german_original(countries: Iterable[str], original_language: Optional[str]) -> Optional[bool]:
    """True si le film est (probablement) germanophone d'origine, None si on ne sait pas.

    Coproductions : on regarde le PREMIER pays cité (pays majoritaire, par
    convention des génériques allemands : « D/F 2024 » = film allemand).
    """
    if original_language:
        return original_language.lower() == "de"
    countries = [c.strip().lower() for c in countries if c and c.strip()]
    if not countries:
        return None
    return countries[0] in _GERMAN_COUNTRIES


def label(version: Optional[str]) -> str:
    return LABELS_FR.get(version or "", "version non précisée")
