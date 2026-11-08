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
import time
import traceback
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

import yaml

from . import taste
from .message import (evening_day, film_card, film_line, first_sentence, fmt_day, format_week,
                      text, week_header)
from .models import Film, Screening
from .ratings import norm_title
from ..budget import call_with_timeout, map_with_budget
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
        limit = float(cfg.get("cinema_timeout_s", 90))
        try:
            ok, got = call_with_timeout(
                lambda: fetch({**cin, "_evening_from": evening_from}, win["start"], win["fetch_days"]), limit)
        except Exception as exc:  # noqa: BLE001 — un cinéma en panne ne bloque pas les autres
            errors.append(f"{cin.get('name')}: {exc}")
            traceback.print_exc(file=sys.stderr)
            continue
        if not ok:
            errors.append(f"{cin.get('name')}: pas de réponse en {limit:.0f} s, cinéma sauté")
            print(f"⏱  {cin.get('name')} : pas de réponse en {limit:.0f} s, cinéma sauté.", file=sys.stderr)
            continue
        known_until[cin["name"]] = max((evening_day(s) for s in got), default=None)
        screenings += [s for s in got if is_evening(s, evening_from) and not_too_late(s, cfg)]
        dubbed |= {norm_title(s.original_title or s.title) for s in got if s.version == "DF"}
    return screenings, errors, dubbed, known_until


def coverage_lines(known_until: Dict[str, Optional[date]], names: List[str], win: dict,
                   lang: str = "fr") -> List[str]:
    """« Intimes : programme connu jusqu'au mer. 12 » quand un cinéma n'a pas
    encore publié toute la semaine (l'Intimes publie le jeudi pour jeudi→mercredi).
    Un dernier jour manquant n'est pas signalé (relâche possible)."""
    out = []
    for n in names:
        if n not in known_until:
            continue                       # source en erreur : voir le rapport
        last = known_until[n]
        if last is None:
            out.append(f"{n}{'' if lang == 'en' else ' '}: {text(lang, 'not_published')}")
        elif last < win["last"] - timedelta(days=1):
            out.append(f"{n}{'' if lang == 'en' else ' '}: {text(lang, 'known_until')} {fmt_day(last, lang)}")
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


def make_pitch_en(film: Film) -> None:
    """Pitch anglais : la description du cinéma (souvent en allemand) traduite.
    Le synopsis SensCritique est en français : pas de traduction FR->EN en
    cascade. Rien de fiable -> pas de pitch (plutôt qu'une autre langue)."""
    desc = next((s.description for s in film.screenings if s.description), None)
    if not desc:
        return
    short = first_sentence(desc, limit=220)
    try:
        from ..translate import looks_english, translate
        if not looks_english(short):
            out = translate(short, "en")
            short = out if out and out != short else None
    except Exception:  # noqa: BLE001
        short = None
    film.pitch_en = first_sentence(short) if short else None


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

    # Notes SensCritique puis Letterboxd (dans rating_filter) : budget global en
    # temps réel ; un film dont la note n'arrive pas à temps est écarté (et loggé).
    budget = float(cfg.get("ratings_budget_s", 300))
    t0 = time.monotonic()
    done, late = map_with_budget(candidates, lambda f: taste.rate(f, cfg), budget, workers=2)
    timed_out = [candidates[i] for i in late]
    candidates = merge_by_rating([f for i, f in enumerate(candidates) if i in done])

    always = {t.lower() for t in cfg.get("always_include") or []}

    def judge(f: Film) -> Optional[str]:
        try:
            why = (taste.genre_filter(f, cfg) or taste.version_filter(f, cfg)
                   or taste.wide_release_filter(f, cfg))
            if not why and f.title.lower() not in always:
                why = taste.rating_filter(f, cfg)
            return why
        except Exception as exc:  # noqa: BLE001 — sans verdict fiable, on écarte
            return f"erreur pendant les filtres : {exc}"

    left = max(10.0, budget - (time.monotonic() - t0))
    verdicts, late2 = map_with_budget(candidates, judge, left, workers=2)
    timed_out += [candidates[i] for i in late2]
    judged = [(f, verdicts[i]) for i, f in enumerate(candidates) if i in verdicts]
    for f in timed_out:
        f.rejected = "notes : délai dépassé (ratings_budget_s)"
        rejected.append(f)
    if timed_out:
        print(f"⏱  notes : budget de {budget:.0f} s dépassé, {len(timed_out)} film(s) écarté(s) faute de note.",
              file=sys.stderr)
    for f, why in judged:
        f.rejected = why
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


def compose(analysis: dict, cfg: dict, start: date, cinemas: Optional[List[str]] = None,
            lang: str = "fr") -> dict:
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
        if (orig.key, lang) not in analysis["pitched"]:
            (make_pitch_en if lang == "en" else make_pitch)(orig)
            analysis["pitched"].add((orig.key, lang))
        f.pitch, f.pitch_en = orig.pitch, orig.pitch_en
    for f in overflow:
        f.rejected = "hors top (plafond max_films)"

    win = analysis["window"]
    coverage = coverage_lines(analysis["known_until"], shown, win, lang)
    messages = format_week(kept, unrated, len(rejected) + len(overflow), win, shown, cfg, coverage, lang)
    head = week_header(win, shown, cfg, len(kept), unrated, coverage, lang)
    return {"messages": messages, "header": head, "kept": kept, "rejected": rejected + overflow,
            "errors": analysis["errors"], "n_screenings": analysis["n_screenings"]}


def run(cfg: dict, start: date, cinemas: Optional[List[str]] = None, lang: str = "fr") -> dict:
    return compose(analyse(cfg, start), cfg, start, cinemas, lang)


def cinema_venue_id(name: str) -> str:
    """Id du cinéma côté bot (table venues) : « cinema-intimes »."""
    from ..main import venue_slug
    return "cinema-" + venue_slug(name)


def _film_item(f: Film, by_id: Dict[str, str]) -> dict:
    """Film -> item du bot (venue = cinéma de la 1re séance)."""
    first = min(f.screenings, key=lambda s: s.start)
    names = {n: i for i, n in by_id.items()}
    return {
        "id": f.item_id(),
        "venue_id": names.get(first.cinema, cinema_venue_id(first.cinema)),
        "title": (f.senscritique.original_title if f.senscritique and f.senscritique.original_title else None)
                 or f.original_title or f.title,
        "url": first.url,
        "dates": sorted({s.start.astimezone(_TZ).strftime("%Y-%m-%d %H:%M") for s in f.screenings}),
        "text": film_card(f, "fr"), "line": film_line(f, "fr"),
        "text_en": film_card(f, "en"), "line_en": film_line(f, "en"),
    }


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

        cache: Dict[tuple, dict] = {}         # (cinémas, langue) -> compose()
        plan = []
        for rcp in recipients:
            subset = tuple(n for n in names if n in {by_id.get(v) for v in rcp["venue_ids"]})
            if not subset:
                continue
            lang = "en" if rcp.get("lang") == "en" else "fr"
            key = (subset, lang)
            if key not in cache:
                cache[key] = compose(analysis, cfg, start, list(subset), lang)
            plan.append((rcp, lang, cache[key]))

        # Un message par film, comme une pièce : le Worker enregistre les films
        # (items kind 'film'), écarte ce que chacun a déjà reçu (sauf nouvelles
        # séances), vu ou ignoré, et rend chaque message dans la langue de l'ami.
        by_key = {f.key: f for f in analysis["passed"]}
        films: Dict[str, Film] = {}
        for res in cache.values():
            for f in res["kept"]:
                films.setdefault(f.item_id(), by_key.get(f.key, f))
        for f in films.values():           # pitch des deux langues sur la fiche complète
            for lang in {lg for _, lg, _ in plan}:
                if (f.key, lang) not in analysis["pitched"]:
                    (make_pitch_en if lang == "en" else make_pitch)(f)
                    analysis["pitched"].add((f.key, lang))
        resp = api.post("/api/film-plan", json={
            "films": [_film_item(f, by_id) for f in films.values()],
            "targets": [{"chat_id": rcp["chat_id"], "ids": [f.item_id() for f in res["kept"]]}
                        for rcp, _, res in plan],
        })
        resp.raise_for_status()
        per_chat: Dict[int, List[dict]] = {}
        for m in resp.json()["messages"]:
            per_chat.setdefault(m["chat_id"], []).append(m)

        failed: List[dict] = []
        sent: List[dict] = []
        ok = total = 0
        for rcp, lang, res in plan:
            film_msgs = per_chat.get(rcp["chat_id"], [])
            if not film_msgs:
                continue                       # rien de neuf pour cette personne : pas d'en-tête seul
            msgs = [{"text": res["header"]}] + film_msgs
            for msg in msgs:
                total += 1
                try:
                    mid = send_telegram(token, str(rcp["chat_id"]), msg["text"], reply_markup=msg.get("reply_markup"))
                    ok += 1
                    if msg.get("item_id"):
                        sent.append({**{k: v for k, v in msg.items() if k not in ("text", "reply_markup")},
                                     "message_id": mid})
                except httpx.HTTPStatusError as exc:
                    code = exc.response.status_code
                    print(f"   ⚠️  envoi refusé ({code}) pour {rcp['chat_id']}")
                    if code == 403:            # l'ami a bloqué le bot : le Worker le désactive
                        failed.append({"chat_id": rcp["chat_id"], "kind": "cinema", "error": 403})
                        break
                except Exception as exc:  # noqa: BLE001 — un ami en échec ne bloque pas les autres
                    print(f"   ⚠️  échec de l'envoi pour {rcp['chat_id']} : {exc}")
                time.sleep(0.1)                # douceur vis-à-vis des limites Telegram
        if sent:
            api.post("/api/sent", json={"sent": sent}).raise_for_status()
        if failed:
            api.post("/api/sent", json={"sent": failed}).raise_for_status()
        if ok or not total:                    # tout a échoué : le 2e créneau retentera
            api.post("/api/cinema-done", json={"week": week}).raise_for_status()
    print(f"🎬 {len(films)} film(s) retenu(s), un message par film (⭐ ✅ 🔕).")
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
    ap.add_argument("--lang", choices=["fr", "en"], default="fr",
                    help="langue du récap (bot : chaque ami reçoit la sienne, /langue)")
    ap.add_argument("--force", action="store_true", help="renvoie même si le récap de la semaine est déjà parti")
    ap.add_argument("--backup", action="store_true",
                    help="créneau cron de secours : n'envoie que si le 1er n'est pas passé (bot multi-utilisateurs)")
    args = ap.parse_args(argv)

    cfg = load_config(Path(args.config))
    start = date.fromisoformat(args.start) if args.start else datetime.now(_TZ).date()
    only = [x.strip() for x in args.only.split(",") if x.strip()] if args.only else None

    if args.dry_run:
        result = run(cfg, start, only, args.lang)
        for i, msg in enumerate(result["messages"], 1):
            print(f"----- message {i}/{len(result['messages'])} ({len(msg)} car.) -----")
            print(msg)
        print("\n===== BOT MULTI-UTILISATEURS : en-tête + un message par film =====")
        print(result["header"])
        for f in result["kept"]:
            print("-----")
            print(film_card(f, args.lang))
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
    result = compose(analysis, cfg, start, only, args.lang)
    for msg in result["messages"]:
        send_telegram(token, chat_id, msg)
    print(f"✅ {len(result['messages'])} message(s) envoyé(s), {len(result['kept'])} film(s).")
    print(report(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
