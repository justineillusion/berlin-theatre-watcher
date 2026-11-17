"""Aucun lien mort ne part : chaque lien de fiche est testé avant l'envoi au Worker.

Mort = 404 / 410, ou site injoignable (DNS, connexion refusée). Un 403 / 429 / 5xx
ou un délai dépassé n'est PAS une preuve de mort (anti-bot, panne passagère) :
le lien est gardé. Un lien mort est remplacé par le premier repli vivant (page
programme du lieu, du cinéma), sinon retiré.
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional

import httpx

from .budget import map_with_budget

_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
_DEAD = {404, 410}
_cache: Dict[str, bool] = {}


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
    if todo:
        done, _late = map_with_budget(todo, _alive, budget_s, workers=8, item_timeout=40)
        for i, ok in done.items():
            _cache[todo[i]] = ok
    return _cache


def pick(url: Optional[str], *fallbacks: Optional[str]) -> Optional[str]:
    """Le premier lien vivant parmi url puis les replis (déjà passés par check())."""
    cands: List[str] = [u for u in (url, *fallbacks) if u]
    check(cands)
    for u in cands:
        if _cache.get(u, True):
            return u
    return None


def dead(urls: Iterable[Optional[str]]) -> List[str]:
    return [u for u in urls if u and _cache.get(u) is False]
