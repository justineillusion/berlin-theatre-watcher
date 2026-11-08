"""Récupère un court résumé du sujet d'une pièce depuis sa page détail.

Sans LLM : sélecteur dédié par théâtre (le synopsis est en anglais sur les
pages « en »), avec un repli générique (og:description). On tronque à ~2 lignes.
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

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


# Générique (credits) : « Regie: X », « by Milo Rau », « Bühne: … », dates,
# durée, surtitres… Ce n'est PAS un résumé : jamais affiché comme 📝.
_CREDIT_WORDS = (
    r"regie|inszenierung|directed by|director|direction|mise en sc[eè]ne|von|nach|after|mit|with|by|"
    r"b[üu]hne|stage|set|kost[üu]me?|costumes?|dramaturgi[ea]|dramaturgy|musik|music|licht|light(?:ing)?|"
    r"video|choreogra\w*|text|premi[eè]re|uraufführung|world premiere|dauer|duration|"
    r"surtitles|übertitel|sous-titres|surtitres|cast|besetzung|en allemand|in german|auf deutsch"
)
_LABEL_RE = re.compile(rf"\b(?:{_CREDIT_WORDS})\s*:\s*\S", re.I)
_LEAD_RE = re.compile(rf"^\s*(?:{_CREDIT_WORDS})\b", re.I)
_SENT_RE = re.compile(r"[a-zäöüßàâçéèêëîïôûù]{2,}[.!?…»“”\"]?\s+[A-ZÄÖÜÀ-Ý»„“\"]|[a-zäöüßàâçéèêëîïôûù]{2,}[.!?…]\s*$")


def is_synopsis(text: Optional[str], min_chars: int = 150) -> bool:
    """Un vrai résumé (de quoi parle la pièce), pas un générique ni une liste de noms."""
    if not text:
        return False
    t = _clean(text)
    if len(t) < min_chars:
        return False
    t = t[:400]                                 # ce qui sera affiché (2–3 phrases)
    if len(_LABEL_RE.findall(t)) >= 2:          # « Regie: X, Bühne: Y »
        return False
    if _LEAD_RE.match(t) and len(_SENT_RE.findall(t)) < 2:
        return False                            # « by X, mit Y… » sans vraies phrases
    if not _SENT_RE.search(t):
        return False                            # aucune phrase : liste de noms / dates
    # proportion de mots capitalisés (listes de noms) trop forte
    words = re.findall(r"\b\w+\b", t)
    caps = sum(w[:1].isupper() for w in words)
    return caps / max(1, len(words)) < 0.45


def _first_synopsis(soup: BeautifulSoup) -> Optional[str]:
    """Repli générique : 1er paragraphe « feuille » qui ressemble à un résumé."""
    for p in soup.find_all("p"):
        if p.find(["p", "div"]) or p.find_parent(["footer", "nav", "header"]):
            continue
        txt = _clean(p.get_text(" ", strip=True))
        if is_synopsis(txt):
            return txt
    return None


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


def _volksbuehne(soup: BeautifulSoup) -> Optional[str]:
    skip = ("cookie", "theaterkasse", "besucherservice", "abendkasse", "newsletter")
    for p in soup.find_all("p"):
        if p.find(["p", "div"]):
            continue                       # on ne garde que les <p> feuilles
        txt = p.get_text(" ", strip=True)
        if len(txt) > 90 and not any(k in txt.lower() for k in skip):
            return txt
    return None


def _co_berlin(soup: BeautifulSoup) -> Optional[str]:
    """C/O Berlin (Drupal) : pas de meta description ; le texte est dans
    les blocs « field--name-field-text » — le 1er vrai paragraphe = le chapeau."""
    for p in soup.select(".field--name-field-text p"):
        if p.find_parent("footer"):
            continue
        txt = _clean(p.get_text(" ", strip=True))
        if len(txt) > 120:
            return txt
    return None


def _generic(soup: BeautifulSoup) -> Optional[str]:
    for attrs in ({"property": "og:description"}, {"name": "description"}):
        meta = soup.find("meta", attrs=attrs)
        if meta and meta.get("content", "").strip():
            return meta["content"]
    return None


_EXTRACTORS = {
    "Berliner Ensemble": _berliner_ensemble,
    "Schaubühne": _schaubuehne,
    "Volksbühne": _volksbuehne,
    "C/O Berlin": _co_berlin,
}


def fetch_details(theater: str, url: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Renvoie (résumé, texte brut de la page) en une seule requête.

    Le texte brut sert à la détection de langue (voir `language.detect`), d'où
    le fait de le remonter plutôt que de refetcher la page une deuxième fois.
    """
    if not url:
        return None, None
    try:
        soup = BeautifulSoup(fetch_html(url), "html.parser")
    except Exception:  # noqa: BLE001 — un résumé manquant n'est pas bloquant
        return None, None
    extractor = _EXTRACTORS.get(theater)
    text = None
    for cand in ((extractor(soup) if extractor else None), _generic(soup), _first_synopsis(soup)):
        if is_synopsis(cand):
            text = cand
            break
    # Rien de valable (générique seul…) : pas de 📝 plutôt qu'un générique.
    return (_trim(text) if text else None), soup.get_text(" ", strip=True)


def fetch_summary(theater: str, url: Optional[str]) -> Optional[str]:
    return fetch_details(theater, url)[0]
