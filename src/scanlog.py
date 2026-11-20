"""Rapport de scan pour la page /admin : par lieu, ce que la source a renvoyé, ce qui est gardé,
ce qui est écarté et pourquoi (heure, atelier…), et les erreurs. Envoyé au Worker en fin de passage
(POST /api/scan-report). Jamais bloquant : un rapport perdu ne doit pas faire échouer un scan."""
from __future__ import annotations

import os
from typing import Dict, List, Optional

_R: Dict[str, dict] = {}


def _v(venue: str) -> dict:
    return _R.setdefault(venue, {"venue": venue, "found": 0, "kept": 0, "dropped": {}, "error": None})


def found(venue: str, n: int) -> None:
    _v(venue)["found"] += n


def kept(venue: str, n: int) -> None:
    _v(venue)["kept"] += n


def drop(venue: str, reason: str, label: str) -> None:
    lst: List[str] = _v(venue)["dropped"].setdefault(reason, [])
    if label not in lst and len(lst) < 40:
        lst.append(label)


def error(venue: str, msg: str) -> None:
    _v(venue)["error"] = str(msg)[:300]


def push(kind: str) -> None:
    if not _R or not os.environ.get("BOT_API_URL"):
        return
    try:
        from .botapi import _client
        run = os.environ.get("GITHUB_RUN_ID") or ""
        with _client() as api:
            api.post("/api/scan-report", json={"kind": kind, "run": f"{kind}-{run}" if run else "", "venues": list(_R.values())}).raise_for_status()
        print(f"🩺 Rapport de scan envoyé ({len(_R)} lieux).")
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  rapport de scan non envoyé : {exc}")
    finally:
        _R.clear()
