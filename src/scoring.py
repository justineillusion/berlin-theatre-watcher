from __future__ import annotations

import json
from typing import List

from anthropic import Anthropic

from .models import Show

_SCORE_PROMPT = """Tu es l'assistant personnel de spectacles d'un·e utilisateur·rice. \
Voici SON profil de goût :
---
{taste}
---

Note chaque représentation ci-dessous de 0 à 10 selon la probabilité qu'elle lui \
plaise, en te basant sur le profil. Rappels importants :
- Les surtitres anglais sont une CONDITION (déjà filtrée en amont).
- Forte préférence pour l'international / non-allemand : une production du répertoire \
allemand doit être pénalisée sauf si elle correspond nettement à d'autres goûts.
- Récompense les correspondances explicites (metteur·se en scène, autrice/auteur, thème, pays).

Représentations (JSON) :
{shows}

Renvoie UNIQUEMENT un tableau JSON, un objet par représentation, dans le MÊME ordre :
[{{"score": int 0-10, "reason": "une phrase courte en français"}}]"""


def score_shows(
    client: Anthropic, model: str, taste_profile: str, shows: List[Show]
) -> List[Show]:
    if not shows:
        return shows

    compact = [
        {
            "i": idx,
            "title": s.title,
            "theater": s.theater,
            "original_language": s.original_language,
            "is_german_production": s.is_german_production,
            "description": s.description,
        }
        for idx, s in enumerate(shows)
    ]
    prompt = _SCORE_PROMPT.format(
        taste=taste_profile, shows=json.dumps(compact, ensure_ascii=False, indent=2)
    )
    resp = client.messages.create(
        model=model,
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = "".join(b.text for b in resp.content if b.type == "text").strip()
    verdicts = _parse(raw)

    for show, verdict in zip(shows, verdicts):
        if isinstance(verdict, dict):
            show.score = int(verdict.get("score", 0))
            show.reason = verdict.get("reason")
    return shows


def _parse(raw: str) -> list:
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
