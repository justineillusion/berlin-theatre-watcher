"""Traduction EN/DE -> FR (ou -> EN), gratuite et sans clé (endpoint Google Translate).

L'endpoint gratuit rate-limite les rafales d'appels (surtout depuis une IP
partagée comme celle de GitHub Actions) et peut renvoyer un jeton d'erreur au
lieu du texte. On protège donc l'appel : retries avec backoff + validation du
résultat, et en dernier recours on garde le texte d'origine (anglais) plutôt
qu'une erreur.
"""
from __future__ import annotations

import re
import time
from typing import Dict, List, Optional, Sequence

_ERROR_RE = re.compile(r"^\s*(error|erreur)?\s*\d{3}\b", re.I)  # "505", "Error 500 (…)"

# L'endpoint peut renvoyer une PAGE d'erreur Google entière, pas juste un code :
# « Error 500 (Server Error)!!1500.That's an error.… That's all we know. »
# Elle est longue et passait donc le contrôle de longueur. On la reconnaît à ses
# formules, en tolérant l'apostrophe droite comme la typographique.
_ERROR_MARKERS = (
    "that's an error",
    "that\u2019s an error",
    "that's all we know",
    "that\u2019s all we know",
    "server error",
    "please try again later",
)


def _looks_valid(source: str, result: Optional[str]) -> bool:
    if not result or not result.strip():
        return False
    stripped = result.strip()
    if _ERROR_RE.match(stripped):
        return False
    low = stripped.lower()
    if any(marker in low for marker in _ERROR_MARKERS):
        return False
    # une vraie traduction ne fond pas à quasi rien
    return len(stripped) >= max(10, len(source) // 4)


def translate(text: Optional[str], target: str = "fr", retries: int = 3) -> Optional[str]:
    """Traduit vers `target` ('fr', 'en'…). Repli : le texte d'origine."""
    if not text:
        return text
    try:
        from deep_translator import GoogleTranslator
    except Exception:  # noqa: BLE001 — dépendance absente : endpoint gtx seul
        GoogleTranslator = None

    for attempt in range(retries):
        # 1) endpoint « gtx » (celui des extensions navigateur) : bien moins
        #    rate-limité que la page mobile scrapée par deep_translator, qui
        #    renvoyait TooManyRequests en continu (FR jamais traduit, 8/11/2026).
        out = _gtx(text, target)
        if _looks_valid(text, out):
            return out
        if GoogleTranslator is not None:
            try:
                out = GoogleTranslator(source="auto", target=target).translate(text)
                if _looks_valid(text, out):
                    return out
            except Exception:  # noqa: BLE001
                pass
        time.sleep(1.0 + 1.5 * attempt)   # backoff pour laisser le rate-limit retomber
    return text  # repli : mieux vaut l'original qu'un "505"


def _gtx(text: str, target: str) -> Optional[str]:
    """translate.googleapis.com/translate_a/single?client=gtx (sans clé)."""
    try:
        import httpx
        r = httpx.post(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": "auto", "tl": target, "dt": "t"},
            data={"q": text[:4500]}, timeout=8.0,
        )
        if r.status_code != 200:
            return None
        return "".join(seg[0] for seg in (r.json()[0] or []) if seg and seg[0])
    except Exception:  # noqa: BLE001
        return None


def to_french(text: Optional[str], retries: int = 3, keep: Sequence[str] = ()) -> Optional[str]:
    return translate_keeping(text, "fr", keep, retries)


def _title_variants(keep: Sequence[str]) -> List[str]:
    """« CURSED – a preinvented world. » -> [« CURSED – a preinvented world. », « CURSED – a preinvented world », « CURSED »]."""
    out: List[str] = []
    for t in keep:
        t = (t or "").strip()
        for v in (t, t.rstrip(". "), re.split(r"\s+[–—-]\s+|:\s|\s\(", t)[0].strip()):
            if len(v) >= 3 and v not in out:
                out.append(v)
    return sorted(out, key=len, reverse=True)   # le plus long d'abord


def translate_keeping(text: Optional[str], target: str, keep: Sequence[str] = (), retries: int = 3) -> Optional[str]:
    """Traduit sans toucher aux titres : « CURSED » ne doit pas devenir « MAUDIT ».
    Chaque titre est remplacé par un jeton opaque (nom propre inventé) avant la
    traduction, puis remis. Si un jeton s'est perdu en route, on retraduit sans
    protection plutôt que de livrer un texte troué."""
    if not text or not keep:
        return translate(text, target, retries)
    tokens: Dict[str, str] = {}
    masked = text
    for i, v in enumerate(_title_variants(keep)):
        tok = f"Zqx{chr(65 + i)}"
        new = re.sub(re.escape(v), tok, masked, flags=re.I)
        if new != masked:
            tokens[tok] = v
            masked = new
    if not tokens:
        return translate(text, target, retries)
    out = translate(masked, target, retries)
    if out is None or out == masked:
        return text                      # échec de traduction : l'original (comme translate)
    if not all(t in out for t in tokens):
        return translate(text, target, retries)
    for tok, v in tokens.items():
        out = out.replace(tok, v)
    return out


# Mots-outils propres à l'anglais (pas « in », « an », « die »… communs avec l'allemand).
_EN_WORDS = {"the", "and", "of", "is", "are", "was", "with", "to", "his", "her", "who", "for", "their",
             "about", "this", "that", "from", "by", "on", "it", "after", "when", "into"}
_OTHER_WORDS = {"der", "die", "das", "und", "ist", "mit", "ein", "eine", "von", "zu", "sich", "nicht", "auf", "den",
                "le", "la", "les", "et", "est", "des", "une", "du", "dans", "pour", "qui", "sur"}


def looks_english(text: Optional[str]) -> bool:
    """Heuristique sans réseau : le texte est-il (surtout) en anglais ?
    Sert à éviter une traduction inutile (pages /en/ des théâtres)."""
    words = re.findall(r"[a-zäöüß]+", (text or "").lower())
    en = sum(w in _EN_WORDS for w in words)
    other = sum(w in _OTHER_WORDS for w in words)
    return en >= 2 and en > 2 * other


def to_english(text: Optional[str], retries: int = 3, keep: Sequence[str] = ()) -> Optional[str]:
    """Anglais : tel quel s'il l'est déjà, sinon traduit (titres protégés)."""
    if not text or looks_english(text):
        return text
    return translate_keeping(text, "en", keep, retries)


_FR_WORDS = {"le", "la", "les", "et", "est", "des", "une", "du", "dans", "pour", "qui", "sur", "avec", "pas", "au"}


def looks_french(text: Optional[str]) -> bool:
    words = re.findall(r"[a-zàâçéèêëîïôûùüÿœ]+", (text or "").lower())
    fr = sum(w in _FR_WORDS for w in words)
    return fr >= 2 and fr > 2 * sum(w in _EN_WORDS for w in words)


# ---------------------------------------------------------------------------
# Garde-fou de langue : une fiche n'affiche une description QUE dans sa langue.
# Détecteur sans réseau par mots-outils (fr / en / de / es / it).
# ---------------------------------------------------------------------------
_STOP = {
    "fr": {"le", "la", "les", "et", "est", "des", "une", "du", "dans", "pour", "qui", "sur", "avec", "pas",
           "au", "aux", "ce", "cette", "son", "sa", "ses", "elle", "il", "ils", "mais", "où", "par", "que"},
    "en": {"the", "and", "of", "is", "are", "was", "with", "to", "his", "her", "who", "for", "their", "about",
           "this", "that", "from", "by", "it", "after", "when", "into", "an", "be", "has", "have", "its", "which"},
    "de": {"der", "die", "das", "und", "ist", "mit", "ein", "eine", "von", "zu", "sich", "nicht", "auf", "den",
           "dem", "des", "im", "auch", "wird", "sie", "er", "nach", "über", "einer", "eines", "zwischen", "wie"},
    "es": {"el", "los", "las", "y", "es", "una", "del", "en", "con", "para", "que", "por", "su", "sus", "como",
           "pero", "más", "al", "lo", "se", "este", "esta", "entre", "sobre", "hasta", "muy"},
    "it": {"il", "lo", "gli", "e", "è", "di", "una", "del", "della", "con", "per", "che", "nel", "nella", "sono",
           "si", "come", "ma", "più", "suo", "sua", "anche", "tra", "questo", "degli", "alla"},
}


def detect_lang(text: Optional[str]) -> Optional[str]:
    """'fr' / 'en' / 'de' / 'es' / 'it', ou None si trop court / indécis."""
    words = re.findall(r"[a-zàâçéèêëîïôûùüÿœäöüßñáíóúì]+", (text or "").lower())
    if len(words) < 5:
        return None
    scores = {lg: sum(w in stop for w in words) for lg, stop in _STOP.items()}
    best = max(scores, key=scores.get)
    second = max(v for lg, v in scores.items() if lg != best)
    if scores[best] < 2 or scores[best] < 1.5 * second:
        return None
    return best


GUARD_FAILS: dict = {}     # {langue de la fiche: nb de descriptions refusées} (logs)


def in_lang(text: Optional[str], lang: str, count: bool = True) -> Optional[str]:
    """Le texte s'il est (détecté) dans `lang`, sinon None — jamais une 3e langue.
    Indécis (texte très court) : accepté seulement s'il fait moins de 6 mots."""
    if not text or not text.strip():
        return None
    got = detect_lang(text)
    if got == lang or (got is None and len(text.split()) < 6):
        return text
    if count:
        GUARD_FAILS[lang] = GUARD_FAILS.get(lang, 0) + 1
    return None


def pick_in_lang(lang: str, *candidates: Optional[str]) -> Optional[str]:
    """Premier candidat dans la bonne langue ; sinon on tente de traduire le
    premier non vide ; sinon None (la fiche part sans 📝). Un refus compté."""
    for c in candidates:
        if in_lang(c, lang, count=False):
            return c
    for src in dict.fromkeys(c for c in candidates if c and c.strip()):
        out = translate(src, lang)
        ok = in_lang(out, lang, count=False) if out and out != src else None
        if ok:
            return ok
    if any(c and c.strip() for c in candidates):
        GUARD_FAILS[lang] = GUARD_FAILS.get(lang, 0) + 1
    return None
