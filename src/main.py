from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List

import yaml

from .matching import select
from .models import Show
from .notify import expo_period, format_digest, format_item, send_telegram
from .parsers import SOURCES
from .state import load_seen, save_seen
from .language import detect as detect_language
from .mute import filter_muted, load_muted, mute_keyboard, sync as sync_muted
from .critics import fetch_rating
from .summary import fetch_details
from .translate import to_french

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"❌ Variable d'environnement manquante : {name}")
    return value


def venue_slug(name: str) -> str:
    """'Berliner Festspiele — Theatertreffen' -> 'berliner-festspiele-theatertreffen'."""
    import re
    import unicodedata

    flat = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", flat.lower()).strip("-")[:40]


def collect_shows(theaters: list) -> List[Show]:
    shows: List[Show] = []
    for theater in theaters:
        name = theater["name"]
        kind = theater.get("kind", "theatre")
        source = SOURCES.get(theater.get("parser", ""))
        if source is None:
            print(f"⚠️  {name} — source inconnue : {theater.get('parser')!r}, ignorée.")
            continue
        try:
            found = source(theater["url"])
        except Exception as exc:  # noqa: BLE001 — on continue sur les autres théâtres
            print(f"⚠️  {name} — échec ({exc}).")
            continue
        for show in found:
            show.venue_id = venue_slug(name)
            show.venue_name = name
            show.kind = kind
            if kind == "expo":
                show.theater = name
        unit = "expo(s)" if kind == "expo" else "représentation(s)"
        print(f"   {name} : {len(found)} {unit} trouvée(s).")
        shows.extend(found)
    return shows


def add_critics(shows: List[Show], config: dict) -> None:
    """Note presse estimée depuis Nachtkritik, quand une Kritikenrundschau existe."""
    shows = [s for s in shows if s.kind != "expo"]    # Nachtkritik = théâtre seulement
    mode = config.get("critics_rating", True)
    if not mode or not shows:
        return
    # "cache" (--no-critics) : note lue dans state/critics_cache.json, sans réseau.
    offline = mode == "cache"
    print(f"📰 Recherche des critiques sur Nachtkritik ({len(shows)} pièce(s))…")
    # La recherche Nachtkritik met 5 à 30 s : quelques requêtes en parallèle
    # (sans plus, par politesse) pour que le récap ne dure pas un quart d'heure.
    with ThreadPoolExecutor(max_workers=4) as pool:
        ratings = pool.map(lambda s: fetch_rating(s.theater, s.title, s.url, offline=offline), shows)
        for show, rating in zip(shows, ratings):
            show.critics = rating
    found = sum(1 for s in shows if s.critics)
    print(f"   {found} pièce(s) avec une note presse.")


def enrich(shows: List[Show], digest: bool = False) -> None:
    """Pages détail : résumé traduit en FR + langue parlée (théâtre).

    Le récap ne montre pas les résumés : on saute alors la traduction, lente et
    rate-limitée, et on ne garde que la détection de langue.
    """
    if not shows:
        return
    print("📝 Récupération des pages détail (langue" + ("" if digest else " + résumés FR") + ")…")
    for i, show in enumerate(shows):
        if i and not digest:
            time.sleep(1.0)   # espace les appels pour éviter le rate-limit traduction
        summary, page_text = fetch_details(show.theater, show.url)
        if not digest:
            show.summary = to_french(summary)
        if show.kind != "expo":
            show.spoken_language, show.surtitles = detect_language(
                show.languages, page_text, show.has_english_surtitles
            )


def _print_console(show: Show) -> None:
    if show.kind == "expo":
        print(f"\n  🖼 {show.title}{' ⭐' if show.matched_keywords else ''}")
        print(f"     {show.theater} · {expo_period(show)}")
        if show.summary:
            print(f"     📝 {show.summary}")
        if show.url:
            print(f"     🔗 {show.url}")
        return
    dates = show.available_dates or ([show.date] if show.date else [])
    star = " ⭐" if show.matched_keywords else ""
    print(f"\n  🎭 {show.title}{star}")
    print(f"     {show.theater} · {show.venue or ''}")
    if dates:
        print(f"     🗓 Places libres : {' | '.join(dates)}")
    spoken = " · ".join(p for p in (show.spoken_language, show.surtitles) if p)
    if spoken:
        print(f"     🗣 {spoken}")
    if show.summary:
        print(f"     📝 {show.summary}")
    if show.critics:
        print(f"     📰 {show.critics.label()}")
    if show.booking_url:
        print(f"     🎟 {show.booking_url}")
    if show.url:
        print(f"     🔗 {show.url}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scanner de théâtres berlinois")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Affiche les résultats dans le terminal, sans Telegram ni écriture "
        "d'état. Ne nécessite AUCUNE clé ni token.",
    )
    parser.add_argument(
        "--digest",
        action="store_true",
        help="Récap hebdomadaire : envoie TOUT ce qui est réservable, y compris "
        "les pièces déjà notifiées. Ne touche pas à l'état (state/seen.json).",
    )
    parser.add_argument(
        "--no-critics",
        action="store_true",
        help="Pas de requête Nachtkritik (lente) : seulement les notes déjà en "
        "cache. Pour les ouvertures de vente, où l'alerte doit partir tout de suite.",
    )
    args = parser.parse_args()

    config = yaml.safe_load(CONFIG_PATH.read_text())
    if args.no_critics and config.get("critics_rating", True):
        config["critics_rating"] = "cache"     # notes déjà en cache seulement (pas de réseau)

    # Mode multi-utilisateurs (amis) dès que le Worker Cloudflare est configuré.
    multi = bool(os.environ.get("BOT_API_URL")) and not args.dry_run
    if not args.dry_run:
        tg_token = _require_env("TELEGRAM_BOT_TOKEN")
        tg_chat = None if multi else _require_env("TELEGRAM_CHAT_ID")

    # Mode un seul chat : on lit d'abord les clics « 🔕 Ne plus suivre » reçus
    # depuis le dernier scan (state/muted.json). Le récap tourne en lecture
    # seule : il applique les clics en mémoire sans avancer l'offset.
    muted_state = None
    if args.dry_run:
        muted_state = load_muted()
    elif not multi:
        muted_state = sync_muted(tg_token, tg_chat, read_only=args.digest)

    print("🔎 Collecte des programmes…")
    all_shows = collect_shows(config["theaters"])

    hits = select(all_shows, config)
    print(f"✅ {len(hits)} spectacle(s) retenu(s) (surtitres EN, non complet, filtres).")

    if multi:
        # Seul le texte de base dépend du scraping ; qui reçoit quoi (abonnements,
        # « vu », « ignoré », nouvelles dates) est décidé par le Worker. On ne
        # récupère donc les pages détail + critiques QUE pour les pièces qu'au
        # moins un ami doit recevoir (sinon le scan durerait 25 min chaque jour).
        from .botapi import run_multi
        run_multi(hits, config, tg_token, digest=args.digest, enrich=enrich)
        return

    hits = filter_muted(hits, muted_state or {})

    enrich(hits, args.digest)

    if args.dry_run or args.digest:
        add_critics(hits, config)

    if args.dry_run:
        print("\n🔔 DRY-RUN (rien envoyé, état inchangé) :")
        if args.digest:
            for msg in format_digest(hits):
                print("\n--- message ---")
                print(msg)
        else:
            for show in hits:
                _print_console(show)
        print("\n(Retire --dry-run + configure Telegram pour recevoir les push.)")
        return

    if args.digest:
        messages = format_digest(hits)
        for msg in messages:
            send_telegram(tg_token, tg_chat, msg)
        print(
            f"📅 Récap envoyé : {len(hits)} pièce(s) en {len(messages)} message(s). "
            "État inchangé."
        )
        return

    seen = load_seen()

    # Une alerte par pièce, MAIS on réveille la notification quand le théâtre
    # ouvre des dates qu'on n'avait pas encore annoncées.
    pending: List[Show] = []
    # Un lieu d'EXPO qui apparaît pour la 1re fois : on enregistre son catalogue
    # en silence plutôt que d'envoyer 40 notifs d'un coup. (Pas pour les
    # théâtres : la 1re saison des Festspiele, par ex., doit bien être notifiée.)
    known_venues = {k.split("|", 1)[0] for k in seen}
    for show in hits:
        key = show.key()
        current = set(show.available_iso)
        known = seen.get(key)

        if known is None and show.kind == "expo" and show.theater not in known_venues:
            seen[key] = current
        elif known is None:                    # pièce jamais vue
            pending.append(show)
        elif not known:                        # état hérité de l'ancien format
            seen[key] = current                # on amorce en silence
        else:
            fresh = sorted(current - known)
            if fresh:
                show.new_dates = fresh         # dates inédites -> on réalerte
                pending.append(show)
            else:
                seen[key] = known | current

    add_critics(pending, config)

    fresh_plays = sum(1 for s in pending if not s.new_dates)
    print(
        f"🔔 {len(pending)} notification(s) : {fresh_plays} nouvelle(s) pièce(s), "
        f"{len(pending) - fresh_plays} avec de nouvelles dates."
    )

    for show in pending:
        try:
            send_telegram(tg_token, tg_chat, format_item(show), reply_markup=mute_keyboard(show))
            seen[show.key()] = seen.get(show.key(), set()) | set(show.available_iso)
            label = "nouvelles dates" if show.new_dates else "nouveau"
            print(f"   → notifié ({label}) : {show.title}")
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️  échec de l'envoi Telegram pour {show.title} : {exc}")

    save_seen(seen)
    print("💾 État sauvegardé.")


if __name__ == "__main__":
    main()
