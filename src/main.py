from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import List

import yaml

from .matching import select
from .models import Show
from .notify import format_digest, format_show, send_telegram
from .parsers import SOURCES
from .state import load_seen, save_seen
from .language import detect as detect_language
from .summary import fetch_details
from .translate import to_french

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"❌ Variable d'environnement manquante : {name}")
    return value


def collect_shows(theaters: list) -> List[Show]:
    shows: List[Show] = []
    for theater in theaters:
        name = theater["name"]
        source = SOURCES.get(theater.get("parser", ""))
        if source is None:
            print(f"⚠️  {name} — source inconnue : {theater.get('parser')!r}, ignorée.")
            continue
        try:
            found = source(theater["url"])
        except Exception as exc:  # noqa: BLE001 — on continue sur les autres théâtres
            print(f"⚠️  {name} — échec ({exc}).")
            continue
        print(f"   {name} : {len(found)} représentation(s) trouvée(s).")
        shows.extend(found)
    return shows


def _print_console(show: Show) -> None:
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
    args = parser.parse_args()

    config = yaml.safe_load(CONFIG_PATH.read_text())

    if not args.dry_run:
        tg_token = _require_env("TELEGRAM_BOT_TOKEN")
        tg_chat = _require_env("TELEGRAM_CHAT_ID")

    print("🔎 Collecte des programmes…")
    all_shows = collect_shows(config["theaters"])

    hits = select(all_shows, config)
    print(f"✅ {len(hits)} spectacle(s) retenu(s) (surtitres EN, non complet, filtres).")

    if hits:
        # Le récap ne montre pas les résumés : on saute la traduction, lente et
        # rate-limitée, et on ne garde que la détection de langue.
        print("📝 Récupération des pages détail (langue" + ("" if args.digest else " + résumés FR") + ")…")
        for i, show in enumerate(hits):
            if i and not args.digest:
                time.sleep(1.0)   # espace les appels pour éviter le rate-limit traduction
            summary, page_text = fetch_details(show.theater, show.url)
            if not args.digest:
                show.summary = to_french(summary)
            show.spoken_language, show.surtitles = detect_language(
                show.languages, page_text, show.has_english_surtitles
            )

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
    new_hits = [s for s in hits if s.key() not in seen]
    print(f"🔔 {len(new_hits)} nouveau(x) depuis le dernier scan.")

    for show in new_hits:
        try:
            send_telegram(tg_token, tg_chat, format_show(show))
            seen.add(show.key())
            print(f"   → notifié : {show.title}")
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️  échec de l'envoi Telegram pour {show.title} : {exc}")

    save_seen(seen)
    print("💾 État sauvegardé.")


if __name__ == "__main__":
    main()
