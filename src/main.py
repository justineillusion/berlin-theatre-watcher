from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List

import yaml

from .matching import select
from .models import Show
from .notify import format_show, send_telegram
from .parsers import SOURCES
from .state import load_seen, save_seen

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
    when = " · ".join(x for x in [show.date, show.time] if x)
    dispo = {True: "COMPLET", False: "billets dispo", None: "dispo inconnue"}[show.sold_out]
    star = " ⭐" if show.matched_keywords else ""
    extra = f"  (+{show.other_dates_count} autres dates)" if show.other_dates_count else ""
    print(f"\n  🎭 {show.title}{star}")
    print(f"     {show.theater} · {when}{extra} · {show.venue or ''} · {dispo}")
    if show.languages:
        print(f"     🗣 {show.languages}")
    if show.matched_keywords:
        print(f"     ✨ {', '.join(show.matched_keywords)}")
    print(f"     🔗 {show.booking_url or show.url or ''}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scanner de théâtres berlinois")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Affiche les résultats dans le terminal, sans Telegram ni écriture "
        "d'état. Ne nécessite AUCUNE clé ni token.",
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

    if args.dry_run:
        print("\n🔔 DRY-RUN (rien envoyé, état inchangé) :")
        for show in hits:
            _print_console(show)
        print("\n(Retire --dry-run + configure Telegram pour recevoir les push.)")
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
