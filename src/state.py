from __future__ import annotations

import json
from pathlib import Path
from typing import Set

_STATE_PATH = Path(__file__).resolve().parent.parent / "state" / "seen.json"


def load_seen() -> Set[str]:
    """Clés des représentations déjà notifiées."""
    if not _STATE_PATH.exists():
        return set()
    try:
        return set(json.loads(_STATE_PATH.read_text()))
    except (json.JSONDecodeError, OSError):
        return set()


def save_seen(seen: Set[str]) -> None:
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text(json.dumps(sorted(seen), ensure_ascii=False, indent=2))
