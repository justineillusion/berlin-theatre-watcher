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
from typing import Optional

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
    except Exception:  # noqa: BLE001 — dépendance absente : on garde l'original
        return text

    for attempt in range(retries):
        try:
            out = GoogleTranslator(source="auto", target=target).translate(text)
            if _looks_valid(text, out):
                return out
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.0 + 1.5 * attempt)   # backoff pour laisser le rate-limit retomber
    return text  # repli : mieux vaut l'original qu'un "505"


def to_french(text: Optional[str], retries: int = 3) -> Optional[str]:
    return translate(text, "fr", retries)


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


def to_english(text: Optional[str], retries: int = 3) -> Optional[str]:
    """Anglais : tel quel s'il l'est déjà, sinon traduit."""
    if not text or looks_english(text):
        return text
    return translate(text, "en", retries)


_FR_WORDS = {"le", "la", "les", "et", "est", "des", "une", "du", "dans", "pour", "qui", "sur", "avec", "pas", "au"}


def looks_french(text: Optional[str]) -> bool:
    words = re.findall(r"[a-zàâçéèêëîïôûùüÿœ]+", (text or "").lower())
    fr = sum(w in _FR_WORDS for w in words)
    return fr >= 2 and fr > 2 * sum(w in _EN_WORDS for w in words)
