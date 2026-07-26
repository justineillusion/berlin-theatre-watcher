"""Récupère un court résumé du sujet d'une pièce depuis sa page détail.

Sans LLM : sélecteur dédié par théâtre (le synopsis est en anglais sur les
pages « en »), avec un repli générique (og:description). On tronque à ~2 lignes.
"""
from __future__ import annotations

import re
from typing import Optional

from bs4 import BeautifulSoup

from .fetch import fetch_html

_MAX = 240


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _trim(text: str, max_chars: int = _MAX) -> str:
    """Coupe à la fin de phrase avant max_chars (2 lignes max)."""
    text = _clean(text)
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    if end > 80:
        return cut[: end + 1]
    return cut.rsplit(" ", 1)[0].rstrip(" ,;:") + "…"


def _berliner_ensemble(soup: BeautifulSoup) -> Optional[str]:
    el = soup.select_one(".s-description-toggle__controls")
    if not el:
        return None
    parent = el.find_parent()
    txt = parent.get_text(" ", strip=True) if parent else ""
    return re.sub(r"^\s*Short info\s*", "", txt, flags=re.I) or None


def _schaubuehne(soup: BeautifulSoup) -> Optional[str]:
    el = soup.select_one("div.pe-lg-5")
    if not el:
        return None
    text = el.get_text(" ", strip=True)
    # le bloc commence par le générique + date + info surtitres ; le vrai
    # synopsis suit la dernière mention "surtitles".
    low = text.lower()
    idx = low.rfind("surtitles")
    if idx != -1:
        tail = text[idx + len("surtitles"):].strip(" .–-|")
        # retire un bandeau promo éventuel ("THEATERTAG 50% discount …")
        promo = re.match(r"^.{0,40}?discount\s+", tail, re.I)
        if promo:
            tail = tail[promo.end():]
        if len(tail) > 60:
            return tail
    return text


def _generic(soup: BeautifulSoup) -> Optional[str]:
    for attrs in ({"property": "og:description"}, {"name": "description"}):
        meta = soup.find("meta", attrs=attrs)
        if meta and meta.get("content", "").strip():
            return meta["content"]
    return None


_EXTRACTORS = {
    "Berliner Ensemble": _berliner_ensemble,
    "Schaubühne": _schaubuehne,
}


def fetch_summary(theater: str, url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    try:
        soup = BeautifulSoup(fetch_html(url), "html.parser")
    except Exception:  # noqa: BLE001 — un résumé manquant n'est pas bloquant
        return None
    extractor = _EXTRACTORS.get(theater)
    text = (extractor(soup) if extractor else None) or _generic(soup)
    return _trim(text) if text else None
