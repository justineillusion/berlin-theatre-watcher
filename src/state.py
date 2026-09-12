from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Set

_STATE_PATH = Path(__file__).resolve().parent.parent / "state" / "seen.json"


def load_seen() -> Dict[str, Set[str]]:
    """État : clé de pièce -> dates déjà notifiées (format "AAAA-MM-JJ HH:MM").

    Une pièce présente avec un ensemble de dates VIDE vient de l'ancien format
    (simple liste de clés) : on ne connaît pas les dates qui avaient été
    annoncées. main.py traite ce cas en amorçant l'état sans rien envoyer, pour
    éviter de renotifier d'un coup tout le catalogue.
    """
    if not _STATE_PATH.exists():
        return {}
    try:
        raw = json.loads(_STATE_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}

    if isinstance(raw, list):          # ancien format : ["Théâtre|titre", …]
        return {str(k): set() for k in raw}
    if isinstance(raw, dict):
        return {str(k): set(v or []) for k, v in raw.items()}
    return {}


def save_seen(seen: Dict[str, Set[str]]) -> None:
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {k: sorted(v) for k, v in sorted(seen.items())}
    _STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
