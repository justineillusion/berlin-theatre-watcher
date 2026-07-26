from __future__ import annotations

import json
from datetime import date
from typing import List

from anthropic import Anthropic

from .models import Show

_EXTRACT_PROMPT = """Tu extrais des représentations de théâtre depuis le contenu \
d'une page web du théâtre "{theater}".

Notes sur cette source : {notes}

Date du jour : {today}. Ignore les représentations déjà passées.

Renvoie UNIQUEMENT un tableau JSON (aucun texte autour). Chaque élément :
{{
  "title": str,                       // titre de la pièce (garde le titre original)
  "date": str,                        // "YYYY-MM-DD" ; "" si vraiment introuvable
  "time": str|null,                   // ex "19:30"
  "venue": str|null,
  "original_language": str|null,      // langue d'origine de l'œuvre si déductible
  "is_german_production": bool|null,  // true si pièce du répertoire allemand / autrice ou auteur allemand
  "has_english_surtitles": bool,      // true SEULEMENT si la page l'indique explicitement (surtitles/Übertitel EN, ou pièce jouée en anglais)
  "sold_out": bool|null,              // true si complet/ausverkauft/sold out ; false si billets dispo ; null si inconnu
  "booking_url": str|null,            // lien direct de réservation (absolu ; complète avec {base_url} si relatif)
  "description": str|null             // 1 phrase max : de quoi ça parle / qui met en scène
}}

Règles :
- N'invente jamais. Si has_english_surtitles n'est pas explicite, mets false.
- Une même pièce jouée à plusieurs dates = plusieurs entrées.
- Si la page ne contient aucune représentation exploitable, renvoie [].

Contenu de la page :
---
{content}
---"""


def extract_shows(
    client: Anthropic,
    model: str,
    theater: str,
    notes: str,
    base_url: str,
    content: str,
) -> List[Show]:
    prompt = _EXTRACT_PROMPT.format(
        theater=theater,
        notes=notes or "aucune",
        today=date.today().isoformat(),
        base_url=base_url,
        content=content,
    )
    resp = client.messages.create(
        model=model,
        max_tokens=8000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = "".join(block.text for block in resp.content if block.type == "text").strip()
    data = _parse_json_array(raw)

    shows: List[Show] = []
    for item in data:
        if not isinstance(item, dict) or not item.get("title"):
            continue
        item["theater"] = theater
        shows.append(Show.from_dict(item))
    return shows


def _parse_json_array(raw: str) -> list:
    """Parse un tableau JSON en tolérant d'éventuels ```json fences."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.lstrip().startswith("json"):
            raw = raw.lstrip()[4:]
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return []
