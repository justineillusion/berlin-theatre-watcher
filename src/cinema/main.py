"""Récap ciné hebdo (dimanche matin) : films du soir (VO, bien notés, pas grand public)
pour la semaine lundi→dimanche qui vient, + « Ce soir ».

    python -m src.cinema --dry-run             # affiche le message + le rapport de filtrage
    python -m src.cinema                       # envoie sur Telegram
    python -m src.cinema --dry-run --only Intimes,Babylon   # le récap d'un ami qui ne suit que ces cinémas

Envoi : avec BOT_API_URL / BOT_API_TOKEN (bot multi-utilisateurs), chaque ami
reçoit le récap des cinémas qu'il suit via /suivre ; sinon tout part sur
TELEGRAM_CHAT_ID.
    python -m src.cinema --dry-run --start 2026-11-09
"""
from __future__ import annotations

import argparse
import os
import sys
import traceback
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

import yaml

from . import taste
from .message import evening_day, first_sentence, fmt_day, format_week
from .models import Film, Screening
from .ratings import norm_title
from .sources import SOURCES
from .version import label as version_label

CONFIG_PATH = Path(__file__).resolve().parents[2] / "cinema.yaml"
_TZ = ZoneInfo("Europe/Berlin")


def load_config(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def is_evening(s: Screening, evening_from: str) -> bool:
    hh, mm = (int(x) for x in evening_from.split(":"))
    t = s.start.astimezone(_TZ)
    return (t.hour, t.minute) >= (hh, mm) or t.hour < 4


def not_too_late(s: Screening, cfg: dict) -> bool:
    """`latest_start` : en semaine, pas de séance qui commence après 22:00
    (22:00 pile passe). Le jour compté est celui de la soirée (00:30 = la veille)."""
    rule = cfg.get("latest_start") or {}
    limit = rule.get("time")
    if not limit:
        return True
    if evening_day(s).weekday() not in set(rule.get("days", [0, 1, 2, 3, 4])):
        return True
    hh, mm = (int(x) for x in limit.split(":"))
    t = s.start.astimezone(_TZ)
    if t.hour < 4:                       # après minuit = forcément plus tard que la limite
        return False
    return (t.hour, t.minute) <= (hh, mm)


def window(cfg: dict, start: date) -> dict:
    """La semaine couverte. Lancé un dimanche (le cas du cron) : lundi→dimanche
    de la semaine qui vient, plus « Ce soir » (les séances de ce dimanche)."""
    days = int(cfg.get("days", 7))
    tonight = start if start.weekday() == 6 and cfg.get("tonight_on_sunday", True) else None
    first = start + timedelta(days=1) if tonight else start
    return {"start": start, "fetch_days": days + (1 if tonight else 0), "tonight": tonight,
            "first": first, "last": first + timedelta(days=days - 1), "days": days}


def collect(cfg: dict, win: dict) -> tuple[List[Screening], List[str], set, Dict[str, Optional[date]]]:
    evening_from = cfg.get("evening_from", "18:00")
    screenings: List[Screening] = []
    dubbed: set = set()          # titres aussi programmés en VF allemande (toute heure)
    errors: List[str] = []
    known_until: Dict[str, Optional[date]] = {}   # dernier soir avec au moins une séance publiée
    for cin in cfg.get("cinemas", []):
        fetch = SOURCES.get(cin.get("source"))
        if not fetch:
            errors.append(f"{cin.get('name')}: source inconnue {cin.get('source')!r}")
            continue
        try:
            got = fetch({**cin, "_evening_from": evening_from}, win["start"], win["fetch_days"])
        except Exception as exc:  # noqa: BLE001 — un cinéma en panne ne bloque pas les autres
            errors.append(f"{cin.get('name')}: {exc}")
            traceback.print_exc(file=sys.stderr)
            continue
        known_until[cin["name"]] = max((evening_day(s) for s in got), default=None)
        screenings += [s for s in got if is_evening(s, evening_from) and not_too_late(s, cfg)]
        dubbed |= {norm_title(s.original_title or s.title) for s in got if s.version == "DF"}
    return screenings, errors, dubbed, known_until


def coverage_lines(known_until: Dict[str, Optional[date]], names: List[str], win: dict) -> List[str]:
    """« Intimes : programme connu jusqu'au mer. 12 » quand un cinéma n'a pas
    encore publié toute la semaine (l'Intimes publie le jeudi pour jeudi→mercredi).
    Un dernier jour manquant n'est pas signalé (relâche possible)."""
    out = []
    for n in names:
        if n not in known_until:
            continue                       # source en erreur : voir le rapport
        last = known_until[n]
        if last is None:
            out.append(f"{n} : programme pas encore publié")
        elif last < win["last"] - timedelta(days=1):
            out.append(f"{n} : programme connu jusqu'au {fmt_day(last)}")
    return out


def group(screenings: List[Screening]) -> List[Film]:
    films: Dict[str, Film] = {}
    for s in screenings:
        key = norm_title(s.original_title or s.title) or norm_title(s.title) or s.title.lower()
        if key in films:
            films[key].screenings.append(s)
        else:
            films[key] = Film(key=key, screenings=[s])
    return list(films.values())


def merge_by_rating(films: List[Film]) -> List[Film]:
    """Même fiche SensCritique = même film (« Der Himmel über Berlin » / « Wings of Desire »)."""
    out: Dict[str, Film] = {}
    for f in films:
        k = f.senscritique.url if f.senscritique else f"_{f.key}"
        if k in out:
            out[k].screenings += f.screenings
        else:
            out[k] = f
    return list(out.values())


def make_pitch(film: Film) -> None:
    if film.senscritique and film.senscritique.synopsis:
        film.pitch = first_sentence(film.senscritique.synopsis)
        return
    desc = next((s.description for s in film.screenings if s.description), None)
    if not desc:
        return
    short = first_sentence(desc, limit=220)
    try:
        from ..translate import to_french
        short = to_french(short) or short
    except Exception:  # noqa: BLE001 — pas de traduction : on garde l'original
        pass
    film.pitch = first_sentence(short)


def select(passed: List[Film], cfg: dict, this_year: int) -> tuple[List[Film], List[Film]]:
    """Top `max_films` par note, en réservant `min_recent` places aux films
    récents (≤ recent_max_age ans) quand il y en a — sinon les rétrospectives
    (Kubrick, Lynch…) raflent tout."""
    cap = int(cfg.get("max_films", 10))
    min_recent = int(cfg.get("min_recent", 3))
    max_age = int(cfg.get("recent_max_age", 3))
    ranked = sorted(passed, key=lambda f: (-f.best_score, f.screenings[0].start))
    recent = [f for f in ranked if f.is_recent(this_year, max_age)][:min_recent]
    chosen = list(recent)
    for f in ranked:
        if len(chosen) >= cap:
            break
        if f not in chosen:
            chosen.append(f)
    chosen.sort(key=lambda f: (-f.best_score, f.screenings[0].start))
    return chosen, [f for f in ranked if f not in chosen]


def analyse(cfg: dict, start: date) -> dict:
    """Lecture des programmes + notes + filtres de goût, tous cinémas confondus
    (la partie lente, faite une seule fois). La sélection finale (plafond
    max_films, places « récents ») se fait ensuite par `compose`, pour un
    sous-ensemble de cinémas — chaque ami reçoit le top de SES cinémas."""
    today = datetime.now(_TZ).date()
    max_age = int(cfg.get("recent_max_age", 3))
    win = window(cfg, start)
    screenings, errors, dubbed, known_until = collect(cfg, win)
    films = group(screenings)
    for f in films:
        f.dubbed_release = f.key in dubbed
    passed: List[Film] = []
    rejected: List[Film] = []
    unrated: List[Film] = []

    candidates: List[Film] = []
    for f in films:
        f.rejected = taste.pre_filter(f, cfg)
        (rejected if f.rejected else candidates).append(f)

    for f in candidates:
        taste.rate(f, cfg)
    candidates = merge_by_rating(candidates)

    always = {t.lower() for t in cfg.get("always_include") or []}
    for f in candidates:
        f.rejected = (taste.genre_filter(f, cfg) or taste.version_filter(f, cfg)
                      or taste.wide_release_filter(f, cfg))
        if not f.rejected and f.title.lower() not in always:
            f.rejected = taste.rating_filter(f, cfg)
        if f.rejected:
            rejected.append(f)
            # Pas encore noté MAIS récent et passé par tous les autres filtres
            # (version, soirée, goût) : on le signale en une ligne.
            if f.unrated and cfg.get("ratings", {}).get("show_unrated") \
                    and (f.is_recent(today.year, max_age) or not f.year):
                unrated.append(f)
        else:
            passed.append(f)
    return {"passed": passed, "rejected": rejected, "unrated": unrated, "errors": errors,
            "n_screenings": len(screenings), "pitched": set(), "window": win,
            "known_until": known_until}


def _restrict(films: List[Film], names: Optional[set]) -> List[Film]:
    """Copies des films réduites aux séances des cinémas `names` (None = tous)."""
    if names is None:
        return list(films)
    out = []
    for f in films:
        keep = [s for s in f.screenings if s.cinema in names]
        if keep:
            out.append(replace(f, screenings=keep, dropped_screenings=list(f.dropped_screenings)))
    return out


def _touches(f: Film, names: Optional[set]) -> bool:
    if names is None:
        return True
    return (any(s.cinema in names for s in f.screenings)
            or any(d.split(" ")[0] in names for d in f.dropped_screenings))


def compose(analysis: dict, cfg: dict, start: date, cinemas: Optional[List[str]] = None) -> dict:
    """Messages du récap pour les cinémas `cinemas` (None = tous ceux de cinema.yaml)."""
    today = datetime.now(_TZ).date()
    all_names = [c["name"] for c in cfg.get("cinemas", [])]
    names = None if cinemas is None else set(cinemas)
    shown = all_names if names is None else [n for n in all_names if n in names]

    kept, overflow = select(_restrict(analysis["passed"], names), cfg, today.year)
    unrated = _restrict(analysis["unrated"], names)
    rejected = [f for f in analysis["rejected"] if _touches(f, names)]
    by_key = {f.key: f for f in analysis["passed"]}
    for f in kept:
        # Le pitch (traduction éventuelle) est calculé une fois par film, pas par ami.
        orig = by_key.get(f.key, f)
        if orig.key not in analysis["pitched"]:
            make_pitch(orig)
            analysis["pitched"].add(orig.key)
        f.pitch = orig.pitch
    for f in overflow:
        f.rejected = "hors top (plafond max_films)"

    win = analysis["window"]
    messages = format_week(kept, unrated, len(rejected) + len(overflow), win, shown, cfg,
                           coverage_lines(analysis["known_until"], shown, win))
    return {"messages": messages, "kept": kept, "rejected": rejected + overflow,
            "errors": analysis["errors"], "n_screenings": analysis["n_screenings"]}


def run(cfg: dict, start: date, cinemas: Optional[List[str]] = None) -> dict:
    return compose(analyse(cfg, start), cfg, start, cinemas)


def cinema_venue_id(name: str) -> str:
    """Id du cinéma côté bot (table venues) : « cinema-intimes »."""
    from ..main import venue_slug
    return "cinema-" + venue_slug(name)


def send_multi(cfg: dict, start: date, token: str, force: bool = False) -> None:
    """Bot multi-utilisateurs : un récap par ami, limité aux cinémas qu'il suit
    (/suivre). Personne ne suit de cinéma = aucun envoi. Idempotent par semaine
    (second créneau cron) sauf `force`."""
    import time

    import httpx

    from ..botapi import _client
    from ..notify import send_telegram

    names = [c["name"] for c in cfg.get("cinemas", [])]
    by_id = {cinema_venue_id(n): n for n in names}
    week = window(cfg, start)["first"].isoformat()
    with _client() as api:
        resp = api.post("/api/cinema-recipients", json={
            "venues": [{"id": i, "name": n} for i, n in by_id.items()], "week": week, "force": force})
        resp.raise_for_status()
        data = resp.json()
        if data.get("already_sent"):
            print(f"✅ Récap de la semaine du {week} déjà envoyé : rien à faire (--force pour renvoyer).")
            return
        recipients = data["recipients"]
        print(f"👥 {len(recipients)} ami·e(s) suivent au moins un cinéma.")
        analysis = analyse(cfg, start)

        cache: Dict[tuple, List[str]] = {}
        failed: List[dict] = []
        ok = total = 0
        for rcp in recipients:
            subset = tuple(n for n in names if n in {by_id.get(v) for v in rcp["venue_ids"]})
            if not subset:
                continue
            if subset not in cache:
                cache[subset] = compose(analysis, cfg, start, list(subset))["messages"]
            for msg in cache[subset]:
                total += 1
                try:
                    send_telegram(token, str(rcp["chat_id"]), msg)
                    ok += 1
                except httpx.HTTPStatusError as exc:
                    code = exc.response.status_code
                    print(f"   ⚠️  envoi refusé ({code}) pour {rcp['chat_id']}")
                    if code == 403:            # l'ami a bloqué le bot : le Worker le désactive
                        failed.append({"chat_id": rcp["chat_id"], "kind": "cinema", "error": 403})
                        break
                except Exception as exc:  # noqa: BLE001 — un ami en échec ne bloque pas les autres
                    print(f"   ⚠️  échec de l'envoi pour {rcp['chat_id']} : {exc}")
                time.sleep(0.1)                # douceur vis-à-vis des limites Telegram
        if failed:
            api.post("/api/sent", json={"sent": failed}).raise_for_status()
        if ok or not total:                    # tout a échoué : le 2e créneau retentera
            api.post("/api/cinema-done", json={"week": week}).raise_for_status()
    print(f"✅ {ok}/{total} message(s) envoyé(s) à {len(recipients)} ami·e(s) "
          f"({len(cache)} combinaison(s) de cinémas).")
    print(report(compose(analysis, cfg, start)))


def report(result: dict) -> str:
    lines = [f"\n===== RAPPORT ({result['n_screenings']} séances du soir lues) ====="]
    if result["errors"]:
        lines.append("Erreurs de source : " + "; ".join(result["errors"]))
    lines.append("\n--- Retenus ---")
    for f in result["kept"]:
        sc = f.senscritique
        lines.append(f"  ✔ {f.title} [{', '.join(sorted({s.cinema for s in f.screenings}))}]"
                     f" -> SC: {sc.title + ' / ' + str(sc.original_title) if sc else '—'}"
                     f" {sc.year if sc else ''} {sc.value if sc else ''} ({sc.count if sc else 0} votes, {sc.confidence if sc else ''})"
                     f"{' | LB ' + str(f.letterboxd.value) if f.letterboxd else ''}")
        if f.dropped_screenings:
            lines.append(f"      séances écartées : {', '.join(f.dropped_screenings)}")
    lines.append("\n--- Écartés ---")
    for f in sorted(result["rejected"], key=lambda f: f.rejected or ""):
        sc = f.senscritique
        cins = ", ".join(sorted({s.cinema for s in f.screenings}))
        vers = ", ".join(sorted({version_label(s.version) for s in f.screenings}))
        match = (f" | SC: {sc.title} ({sc.year}, {', '.join(sc.directors[:1])}) {sc.value or '—'}/{sc.count}v"
                 if sc else "")
        if f.letterboxd:
            match += f" | LB {f.letterboxd.value}/{f.letterboxd.count}v"
        lines.append(f"  ✘ {f.title} [{cins}; {vers}] — {f.rejected}{match}")
    return "\n".join(lines)


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Récap ciné hebdo (Intimes, Lichtblick, Babylon…)")
    ap.add_argument("--dry-run", action="store_true", help="affiche sans envoyer (aucun token requis)")
    ap.add_argument("--start", help="premier jour (YYYY-MM-DD), défaut : aujourd'hui à Berlin")
    ap.add_argument("--config", default=str(CONFIG_PATH))
    ap.add_argument("--only", help="cinémas (noms de cinema.yaml, séparés par des virgules) : "
                                   "le récap tel que le reçoit un ami qui ne suit qu'eux")
    ap.add_argument("--force", action="store_true", help="renvoie même si le récap de la semaine est déjà parti")
    ap.add_argument("--backup", action="store_true",
                    help="créneau cron de secours : n'envoie que si le 1er n'est pas passé (bot multi-utilisateurs)")
    args = ap.parse_args(argv)

    cfg = load_config(Path(args.config))
    start = date.fromisoformat(args.start) if args.start else datetime.now(_TZ).date()
    only = [x.strip() for x in args.only.split(",") if x.strip()] if args.only else None

    if args.dry_run:
        result = run(cfg, start, only)
        for i, msg in enumerate(result["messages"], 1):
            print(f"----- message {i}/{len(result['messages'])} ({len(msg)} car.) -----")
            print(msg)
        print(report(result))
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        sys.exit("❌ TELEGRAM_BOT_TOKEN manquant (ou utilise --dry-run)")
    if os.environ.get("BOT_API_URL"):
        send_multi(cfg, start, token, force=args.force)
        return 0
    if args.backup:
        print("Créneau de secours sans bot multi-utilisateurs : impossible de savoir si le "
              "récap est déjà parti, on n'envoie rien.")
        return 0

    analysis = analyse(cfg, start)
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not chat_id:
        sys.exit("❌ TELEGRAM_CHAT_ID manquant (ou BOT_API_URL pour le bot multi-utilisateurs)")
    from ..notify import send_telegram
    result = compose(analysis, cfg, start, only)
    for msg in result["messages"]:
        send_telegram(token, chat_id, msg)
    print(f"✅ {len(result['messages'])} message(s) envoyé(s), {len(result['kept'])} film(s).")
    print(report(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
