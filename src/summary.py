"""Récupère un court résumé du sujet d'une pièce depuis sa page détail.

Sans LLM : sélecteur dédié par théâtre (le synopsis est en anglais sur les
pages « en »), avec un repli générique (og:description). On tronque à ~2 lignes.
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

from bs4 import BeautifulSoup

from .fetch import fetch_html

_MAX = 500          # 2–3 phrases (demande : un vrai synopsis, pas une ligne)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _trim(text: str, max_chars: int = _MAX) -> str:
    """Coupe à la fin de phrase avant max_chars (2 lignes max)."""
    text = _clean(text)
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    # Fins de phrase réelles : pas « (b. 1940 », « ca. », « St. », « Dr. »…
    ends = [m.end() for m in re.finditer(r"[.!?…][\"”»)]?(?=\s+[A-ZÄÖÜÀ-Ý\"“„»(])", cut)
            if not re.search(r"(?:^|[\s(])(?:\w{1,2}|ca|St|Dr|Nr|bzw|usw|etc|vs)\.$", cut[: m.end()])]
    if ends and ends[-1] > 80:
        return cut[: ends[-1]]
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


# Textes de site (meta description identique sur toutes les pages d'un musée).
_BOILERPLATE = (
    "museum für moderne und zeitgenössische kunst",
    "engages with the central questions of our time",
    "please note that starting times vary",
)


# Bandeaux cookies / consentement / suivi (EN, DE, FR). Les opéras et la
# Philharmonie ont un bandeau de consentement en <p> dans la page : sans ce
# garde-fou, le 1er « paragraphe » trouvé était « We use tracking technologies… »
# (traduit : « Nous utilisons des technologies de suivi… »).
_CONSENT_STRONG = re.compile(
    r"\b(?:we|wir|nous)\s+(?:use|verwenden|nutzen|utilisons)\s+(?:\w+\s+){0,3}"
    r"(?:cookies?|tracking|pixel|technologies de suivi|traceurs)"
    r"|tracking[- ]?technolog|technologies? de (?:suivi|traçage)|traceurs?\b"
    r"|accept(?:ez)? (?:all )?cookies|alle (?:cookies )?akzeptieren|tout accepter|accepter (?:tous )?les cookies"
    r"|cookie[- ]?(?:settings|einstellungen|richtlinie|policy|banner)|param[eè]tres des cookies"
    r"|notwendige cookies|technisch notwendige|strictement n[ée]cessaires|technically necessary"
    r"|your consent|ihre einwilligung|votre consentement"
    r"|personali[sz]ed advertising|personalisierte werbung|publicit[ée] personnalis[ée]e",
    re.I,
)
_CONSENT_WEAK = re.compile(
    r"cookies?|consent|einwilligung|zustimmung|consentement|tracking|datenschutz|data protection|"
    r"privacy|protection des donn[ée]es|confidentialit[ée]|pixels?|analytics|web ?analy",
    re.I,
)


def looks_like_consent(text: Optional[str]) -> bool:
    """Texte de bandeau cookies / consentement / suivi : jamais un résumé."""
    if not text:
        return False
    t = _clean(text)
    if _CONSENT_STRONG.search(t):
        return True
    return len({m.group(0).lower() for m in _CONSENT_WEAK.finditer(t)}) >= 2


def is_synopsis(text: Optional[str], min_chars: int = 150) -> bool:
    """Un vrai résumé (de quoi parle la pièce), pas un générique ni une liste de noms."""
    if not text:
        return False
    t = _clean(text)
    if any(b in t.lower() for b in _BOILERPLATE):
        return False
    if looks_like_consent(t):
        return False
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
    out: list = []
    for p in soup.find_all("p"):
        if p.find(["p", "div"]) or p.find_parent(["footer", "nav", "header", "blockquote", "figcaption", "aside"]):
            continue
        txt = _clean(p.get_text(" ", strip=True))
        if is_synopsis(txt) or (out and len(txt) > 80 and _SENT_RE.search(txt) and not _LABEL_RE.search(txt)):
            out.append(txt)
            if len(" ".join(out)) >= 300:      # 2–3 phrases : le 1er paragraphe peut n'en avoir qu'une
                break
        elif out:
            break
    return " ".join(out) or None


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
        # bandeau « P L ATZ FREI! Eine Aktion der Theaterpädagogik »
        tail = re.sub(r"^P\s*L\s*A\s*T\s*Z\s+F\s*R\s*E\s*I\s*!?\s*(?:Eine Aktion der Theaterpädagogik)?\s*", "", tail)
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


# Conteneurs de bandeau de consentement, retirés de la page avant toute extraction.
_CONSENT_BOX = re.compile(r"cookie|consent|gdpr|usercentrics|onetrust|borlabs|klaro|cmp-|privacy-?banner", re.I)


def _strip_consent(soup: BeautifulSoup) -> None:
    def marked(tag) -> bool:
        attrs = tag.attrs or {}
        return bool(_CONSENT_BOX.search(" ".join([*(attrs.get("class") or []), attrs.get("id") or ""])))

    for tag in [*soup.find_all("dialog"), *soup.find_all(marked)]:
        if not getattr(tag, "decomposed", False):
            tag.decompose()


def _paragraphs(els, max_chars: int = 320) -> Optional[str]:
    """Paragraphes successifs (texte de présentation) jusqu'à ~2–3 phrases."""
    out: list = []
    for el in els:
        txt = _clean(el.get_text(" ", strip=True))
        if len(txt) < 60 or looks_like_consent(txt):
            continue
        out.append(txt)
        if len(" ".join(out)) >= max_chars:
            break
    return " ".join(out) or None


def _staatsoper(soup: BeautifulSoup) -> Optional[str]:
    """Texte d'introduction (bloc dépliable « … more ») de la page production ;
    pas le résumé acte par acte (accordéon plus bas)."""
    box = soup.select_one(".sob-ausklappbarer-abschnitt")
    if not box:
        return None
    teaser = box.select(".sob-ausklappbarer-abschnitt__teaser p") or box.select(".sob-ausklappbarer-abschnitt__teaser")
    return _paragraphs([*teaser, *box.select(".sob-ausklappbarer-abschnitt__panel p")])


def _deutsche_oper(soup: BeautifulSoup) -> Optional[str]:
    """Le chapeau de la production est la meta description (identique au texte
    de l'accordéon « About the production ») ; le corps contient d'abord la
    fiche de l'œuvre (« Opera in three acts, Libretto by… ») puis des teasers
    vidéo/blog, d'où la meta en premier."""
    meta = _generic(soup)
    if meta:
        return meta
    for el in soup.select(".accordion-body .max_content_width"):
        if "backgroundtitle-container" in (el.get("class") or []):
            continue
        txt = _clean(el.get_text(" ", strip=True))
        if len(txt) > 120:
            return txt
    return None


def _komische_oper(soup: BeautifulSoup) -> Optional[str]:
    """1er bloc « richtext » de l'onglet de la production = présentation ;
    le suivant est le résumé acte par acte (« Act 1 … »), gardé en repli."""
    texts = [_clean(el.get_text(" ", strip=True)) for el in soup.select(".tab__item .richtext__text")]
    texts = [t for t in texts if len(t) > 80]
    intro = [t for t in texts if not re.match(r"^(?:act|akt|scene|bild)\b", t, re.I)]
    return (intro or texts or [None])[0]


def _philharmonie(soup: BeautifulSoup) -> Optional[str]:
    """Section « Concert information » : titre, « Tickets », puis « Info » suivi
    du texte d'intro (jusqu'au label suivant, « Artists »)."""
    sec = soup.select_one(".main__concert_introduction")
    if not sec:
        return None
    body, in_info = [], False
    for p in sec.find_all("p"):
        classes = p.get("class") or []
        if "text--small" in classes:              # labels : Tickets / Info / Artists…
            in_info = _clean(p.get_text()).lower() in ("info", "information")
        elif in_info:
            body.append(p)
    return _paragraphs(body or [p for p in sec.find_all("p") if not p.get("class")])


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
    "Staatsoper Unter den Linden": _staatsoper,
    "Deutsche Oper Berlin": _deutsche_oper,
    "Komische Oper Berlin": _komische_oper,
    "Berliner Philharmoniker": _philharmonie,
}


def summary_from_html(theater: str, html: str) -> Optional[str]:
    """Résumé (2–3 phrases) d'une page détail déjà téléchargée, ou None."""
    soup = BeautifulSoup(html, "html.parser")
    _strip_consent(soup)                     # bandeaux cookies : jamais un résumé
    extractor = _EXTRACTORS.get(theater)
    text = None
    # Ordre : extracteur du lieu, puis le CORPS de la page (texte de l'expo/pièce,
    # 2–3 phrases), et seulement en dernier la meta description (souvent une
    # ligne, ou le slogan du musée répété sur toutes les pages).
    meta = _generic(soup)
    for cand in ((extractor(soup) if extractor else None), _first_synopsis(soup), meta):
        if is_synopsis(cand):
            text = cand
            break
    # Corps trop court mais meta plus riche : on garde la plus longue des deux.
    if text and len(_clean(text)) < 200 and is_synopsis(meta) and len(_clean(meta)) > len(_clean(text)):
        text = meta
    # Rien de valable (générique seul…) : pas de 📝 plutôt qu'un générique.
    return _trim(text) if text else None


def fetch_details(theater: str, url: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Renvoie (résumé, texte brut de la page) en une seule requête.

    Le texte brut sert à la détection de langue (voir `language.detect`), d'où
    le fait de le remonter plutôt que de refetcher la page une deuxième fois.
    """
    if not url:
        return None, None
    try:
        html = fetch_html(url)
    except Exception:  # noqa: BLE001 — un résumé manquant n'est pas bloquant
        return None, None
    page_text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    return summary_from_html(theater, html), page_text


def fetch_summary(theater: str, url: Optional[str]) -> Optional[str]:
    return fetch_details(theater, url)[0]
