"""Récap ciné hebdo : films du soir (VO, bien notés, pas grand public).

    python -m src.cinema --dry-run             # affiche le message + le rapport de filtrage
    python -m src.cinema                       # envoie sur Telegram
    python -m src.cinema --dry-run --start 2026-11-09
"""
from __future__ import annotations

import argparse
import os
import sys
import traceback
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List
from zoneinfo import ZoneInfo

import yaml

from . import taste
from .message import first_sentence, format_week
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


def collect(cfg: dict, start: date) -> tuple[List[Screening], List[str], set]:
    days = int(cfg.get("days", 7))
    evening_from = cfg.get("evening_from", "18:00")
    screenings: List[Screening] = []
    dubbed: set = set()          # titres aussi programmés en VF allemande (toute heure)
    errors: List[str] = []
    for cin in cfg.get("cinemas", []):
        fetch = SOURCES.get(cin.get("source"))
        if not fetch:
            errors.append(f"{cin.get('name')}: source inconnue {cin.get('source')!r}")
            continue
        try:
            got = fetch({**cin, "_evening_from": evening_from}, start, days)
        except Exception as exc:  # noqa: BLE001 — un cinéma en panne ne bloque pas les autres
            errors.append(f"{cin.get('name')}: {exc}")
            traceback.print_exc(file=sys.stderr)
            continue
        screenings += [s for s in got if is_evening(s, evening_from)]
        dubbed |= {norm_title(s.original_title or s.title) for s in got if s.version == "DF"}
    return screenings, errors, dubbed


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


def run(cfg: dict, start: date) -> dict:
    today = datetime.now(_TZ).date()
    max_age = int(cfg.get("recent_max_age", 3))
    screenings, errors, dubbed = collect(cfg, start)
    films = group(screenings)
    for f in films:
        f.dubbed_release = f.key in dubbed
    kept: List[Film] = []
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
            kept.append(f)

    kept, overflow = select(kept, cfg, today.year)
    for f in overflow:
        f.rejected = "hors top (plafond max_films)"
        rejected.append(f)
    for f in kept:
        make_pitch(f)

    messages = format_week(kept, unrated, len(rejected), start, int(cfg.get("days", 7)),
                           [c["name"] for c in cfg.get("cinemas", [])], cfg)
    return {"messages": messages, "kept": kept, "rejected": rejected, "errors": errors,
            "n_screenings": len(screenings)}


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
    args = ap.parse_args(argv)

    cfg = load_config(Path(args.config))
    start = date.fromisoformat(args.start) if args.start else datetime.now(_TZ).date()
    result = run(cfg, start)

    if args.dry_run:
        for i, msg in enumerate(result["messages"], 1):
            print(f"----- message {i}/{len(result['messages'])} ({len(msg)} car.) -----")
            print(msg)
        print(report(result))
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        sys.exit("❌ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants (ou utilise --dry-run)")
    from ..notify import send_telegram
    for msg in result["messages"]:
        send_telegram(token, chat_id, msg)
    print(f"✅ {len(result['messages'])} message(s) envoyé(s), {len(result['kept'])} film(s).")
    print(report(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
