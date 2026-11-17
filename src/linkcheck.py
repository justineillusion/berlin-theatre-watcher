"""Aucun lien mort ne part : chaque lien de fiche est testé avant l'envoi au Worker.

Mort = 404 / 410, ou site injoignable (DNS, connexion refusée). Un 403 / 429 / 5xx
ou un délai dépassé n'est PAS une preuve de mort (anti-bot, panne passagère) :
le lien est gardé. Un lien mort est remplacé par le premier repli vivant (page
programme du lieu, du cinéma), sinon retiré.
"""
from __future__ import annotations

import time
from typing import Dict, Iterable, List, Optional

import httpx

from .budget import map_with_budget

_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
_DEAD = {404, 410}
_cache: Dict[str, bool] = {}
_RUN_BUDGET = 240.0                          # plafond total du run (tous les appels à check())
_spent = [0.0]


def _alive(url: str) -> bool:
    for attempt in range(3):                 # un délai dépassé se retente (réseau capricieux)
        try:
            with httpx.Client(headers=_UA, follow_redirects=True, timeout=12) as c:
                with c.stream("GET", url) as r:
                    return r.status_code not in _DEAD
        except (httpx.ConnectError, httpx.UnsupportedProtocol, httpx.InvalidURL):
            return False
        except httpx.TimeoutException:
            continue
        except Exception:  # noqa: BLE001 — TLS capricieux… : pas une preuve de lien mort
            return True
    print(f"🔗 lien non vérifiable (délais dépassés), gardé : {url}")
    return True


def check(urls: Iterable[Optional[str]], budget_s: float = 150) -> Dict[str, bool]:
    """Teste les liens (en parallèle, borné en temps). Ce qui n'a pas pu être testé à temps est gardé."""
    todo = sorted({u for u in urls if u and u.startswith("http") and u not in _cache})
    left = min(budget_s, _RUN_BUDGET - _spent[0])
    if todo and left <= 5:
        print(f"🔗 budget de vérification épuisé : {len(todo)} lien(s) gardés sans test", flush=True)
        for u in todo:
            _cache[u] = True
    elif todo:
        t0 = time.monotonic()
        done, late = map_with_budget(todo, _alive, left, workers=16, item_timeout=40)
        for i, ok in done.items():
            _cache[todo[i]] = ok if ok is not None else True
        for i in late:                       # pas testé à temps : gardé, et jamais retesté dans ce run
            _cache[todo[i]] = True
        if late:
            print(f"🔗 {len(late)} lien(s) non testé(s) à temps, gardés", flush=True)
        _spent[0] += time.monotonic() - t0
    return _cache


def pick(url: Optional[str], *fallbacks: Optional[str]) -> Optional[str]:
    """Le premier lien vivant parmi url puis les replis (déjà passés par check())."""
    cands: List[str] = [u for u in (url, *fallbacks) if u]
    for u in cands:                          # check() doit avoir été appelé avant : aucun réseau ici
        if _cache.get(u, True):
            return u
    return None


def dead(urls: Iterable[Optional[str]]) -> List[str]:
    return [u for u in urls if u and _cache.get(u) is False]
