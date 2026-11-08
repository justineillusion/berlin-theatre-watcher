"""Job de nuit (critics.yml) : rafraîchit state/critics_cache.json.

Seul endroit où l'on interroge Nachtkritik en ligne ; tous les autres jobs
(scan, ventes, récap, programme) lisent ce cache sans réseau.

    1. rubriques des maisons (BE, Schaubühne, Volksbühne, Festspiele) ;
    2. pièces trouvées dans une rubrique : lecture de la critique (≤ 10 s / pièce) ;
    3. les autres : recherche plein texte du site (lente, ≤ 45 s / pièce),
       dans ce qui reste du budget global (5 min).

Une pièce qui dépasse son plafond est « à retenter » (rien n'est mis en cache
comme « pas de critique »). Chaque pièce est loguée avec sa durée.

    python -m src.critics_refresh [--budget 300] [--cap 10] [--search-cap 45]
"""
from __future__ import annotations

import argparse
import statistics
import time

import yaml

from . import critics as C
from .budget import call_with_timeout, map_with_budget
from .matching import select


def _timed(fn):
    def run(show):
        t = time.monotonic()
        rating = fn(show)
        return rating, time.monotonic() - t
    return run


def main() -> None:
    from . import main as M
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=300)
    ap.add_argument("--cap", type=float, default=10)
    ap.add_argument("--search-cap", type=float, default=45)
    args = ap.parse_args()
    t0 = time.monotonic()
    left = lambda: args.budget - (time.monotonic() - t0)

    config = yaml.safe_load(M.CONFIG_PATH.read_text())
    theatres = [t for t in config["theaters"] if t.get("kind", "theatre") != "expo"]
    shows = [s for s in select(M.collect_shows(theatres), config) if s.kind != "expo"]
    print(f"🎭 {len(shows)} pièce(s) à l'affiche ({time.monotonic() - t0:.0f} s pour les programmes).")
    t0 = time.monotonic()                 # le budget Nachtkritik commence ici

    ok, n = call_with_timeout(C.refresh_listings, 120)
    print(f"📚 Rubriques Nachtkritik : {n if ok else '?'} critiques connues"
          f"{'' if ok else ' (coupé à 120 s, version en cache)'} ({time.monotonic() - t0:.0f} s).")

    rows = []                             # (titre, voie, durée, note ?)
    listed = [s for s in shows if C.in_listing(s.theater, s.title, s.url)]
    rest = [s for s in shows if s not in listed]
    for group, via, cap, search in ((listed, "listing", args.cap, False), (rest, "search", args.search_cap, True)):
        if not group:
            continue
        if left() <= 0:
            rows += [(s.title, "missed", 0.0, None) for s in group]
            continue
        fn = _timed(lambda s, search=search: C.fetch_rating(s.theater, s.title, s.url, search=search))
        done, late = map_with_budget(group, fn, left(), workers=4, item_timeout=cap)
        for i, s in enumerate(group):
            if i in done and done[i] is not None:
                rating, dt = done[i]
                rows.append((s.title, via, dt, rating))
            else:
                rows.append((s.title, "missed", cap, None))
    C._save_cache()

    for title, via, dt, rating in rows:
        note = f"★ {rating.stars:g} ({rating.count})" if rating else "—"
        print(f"   {via:8} {dt:5.1f} s  {note:12} {title}")
    for via in ("listing", "search"):
        ts = [dt for _, v, dt, _ in rows if v == via]
        if ts:
            print(f"⏱  {via} : {len(ts)} pièce(s), médiane {statistics.median(ts):.1f} s, max {max(ts):.1f} s")
    missed = [t for t, v, _, _ in rows if v == "missed"]
    rated = sum(1 for r in rows if r[3])
    print(f"⏭  {len(missed)} pièce(s) à retenter{(' : ' + ', '.join(missed)) if missed else ''}.")
    print(f"📰 {rated}/{len(rows)} pièce(s) notée(s) ({100 * rated // max(1, len(rows))} %), "
          f"{time.monotonic() - t0:.0f} s au total.")


if __name__ == "__main__":
    main()
