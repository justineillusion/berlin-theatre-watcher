"""Garde-fous de durée : aucune étape réseau ne doit pouvoir bloquer un job.

Les timeouts httpx sont par opération (connexion, chaque lecture…) : un site
lent qui renvoie quelques octets de temps en temps, plus les retries, peut
tenir des dizaines de minutes. On borne donc chaque étape en temps réel
(« wall clock »), avec des threads DAEMON : à l'échéance on n'attend plus, et
Python ne les attend pas non plus à la sortie (contrairement à un
ThreadPoolExecutor, dont les workers sont joints à la fin du programme).

Ce qui n'a pas fini à temps est simplement absent du résultat : à l'appelant de
continuer sans (pas de résumé, pas de note…) et de le dire dans les logs.
"""
from __future__ import annotations

import queue
import threading
import time
from typing import Callable, Dict, List, Optional, Sequence, Tuple, TypeVar

T = TypeVar("T")
R = TypeVar("R")

_MISSING = object()


def call_with_timeout(fn: Callable[[], R], timeout: float) -> Tuple[bool, Optional[R]]:
    """Exécute fn() dans un thread daemon. Renvoie (fini_à_temps, résultat).
    Une exception de fn est relancée ici (si elle arrive à temps)."""
    box: list = [_MISSING, None]

    def run() -> None:
        try:
            box[0] = fn()
        except BaseException as exc:  # noqa: BLE001 — relancée côté appelant
            box[1] = exc

    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        return False, None
    if box[1] is not None:
        raise box[1]
    return True, box[0]


def map_with_budget(
    items: Sequence[T],
    fn: Callable[[T], R],
    budget: float,
    workers: int = 1,
    pause: float = 0.0,
    item_timeout: Optional[float] = None,
) -> Tuple[Dict[int, R], List[int]]:
    """Applique fn à chaque item (dans l'ordre, `workers` threads daemon,
    `pause` secondes entre deux items d'un même worker), pendant `budget`
    secondes au plus.

    Renvoie ({index: résultat} pour ce qui a fini à temps, [index non finis]).
    Un item dont fn lève une exception compte comme fini, avec None.
    `item_timeout` : plafond par item (s) ; un item trop lent est abandonné (il
    finit en tâche de fond, son résultat est ignoré) et compté « non fini ».
    """
    if not items:
        return {}, []
    todo: "queue.Queue[int]" = queue.Queue()
    for i in range(len(items)):
        todo.put(i)
    results: Dict[int, R] = {}
    processed = [0]
    lock = threading.Lock()
    all_done = threading.Event()
    closed = threading.Event()

    def worker() -> None:
        first = True
        while not closed.is_set():
            try:
                i = todo.get_nowait()
            except queue.Empty:
                return
            if pause and not first:
                time.sleep(pause)
            first = False
            out = _MISSING
            try:
                if item_timeout:
                    ok, out = call_with_timeout(lambda: fn(items[i]), item_timeout)
                    if not ok:
                        out = _MISSING          # trop lent : sauté (« à retenter »)
                else:
                    out = fn(items[i])
            except Exception:  # noqa: BLE001 — un item en échec ne bloque pas les autres
                out = None
            with lock:
                if closed.is_set():
                    return                      # trop tard : le résultat est ignoré
                if out is not _MISSING:
                    results[i] = out
                processed[0] += 1
                if processed[0] == len(items):
                    all_done.set()

    for _ in range(max(1, min(workers, len(items)))):
        threading.Thread(target=worker, daemon=True).start()
    all_done.wait(budget)
    with lock:
        closed.set()
        done = dict(results)
    return done, [i for i in range(len(items)) if i not in done]
