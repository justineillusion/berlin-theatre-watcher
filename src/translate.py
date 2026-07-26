"""Traduction EN/DE -> FR, gratuite et sans clé (endpoint Google Translate).

En cas d'échec (réseau, quota), on renvoie le texte d'origine : mieux vaut un
résumé en anglais qu'aucun résumé.
"""
from __future__ import annotations

from typing import Optional


def to_french(text: Optional[str]) -> Optional[str]:
    if not text:
        return text
    try:
        from deep_translator import GoogleTranslator

        return GoogleTranslator(source="auto", target="fr").translate(text)
    except Exception:  # noqa: BLE001 — la traduction est un bonus, pas un bloquant
        return text
