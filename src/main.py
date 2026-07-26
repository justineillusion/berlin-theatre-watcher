from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from anthropic import Anthropic

from .extract import extract_shows
from .fetch import fetch_html, html_to_text
from .models import Show
from .notify import format_show, send_telegram
from .scoring import score_shows
from .state import load_seen, save_seen

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


def _base_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"❌ Variable d'environnement manquante : {name}")
    return value


def collect_shows(client: Anthropic, model: str, theaters: list) -> list[Show]:
    shows: list[Show] = []
    for theater in theaters:
        name = theater["name"]
        for url in theater.get("urls", []):
            try:
                text = html_to_text(fetch_html(url))
            except Exception as exc:  # noqa: BLE001 — on continue sur les autres sources
                print(f"⚠️  {name} — échec du fetch de {url} : {exc}")
                continue
            try:
                found = extract_shows(
                    client, model, name, theater.get("notes", ""), _base_url(url), text
                )
            except Exception as exc:  # noqa: BLE001
                print(f"⚠️  {name} — échec de l'extraction : {exc}")
                continue
            print(f"   {name} : {len(found)} représentation(s) extraite(s) de {url}")
            shows.extend(found)
    return shows


def main() -> None:
    config = yaml.safe_load(CONFIG_PATH.read_text())
    model = config.get("model", "claude-sonnet-5")
    threshold = int(config.get("score_threshold", 7))
    taste = config["taste_profile"]

    api_key = _require_env("ANTHROPIC_API_KEY")
    tg_token = _require_env("TELEGRAM_BOT_TOKEN")
    tg_chat = _require_env("TELEGRAM_CHAT_ID")
    client = Anthropic(api_key=api_key)

    print("🔎 Collecte des programmes…")
    all_shows = collect_shows(client, model, config["theaters"])

    # Filtres durs : surtitres anglais requis, on écarte les complets.
    candidates = [
        s for s in all_shows if s.has_english_surtitles and s.sold_out is not True
    ]
    print(f"✅ {len(candidates)} candidat(s) avec surtitres EN et non complet(s).")

    if not candidates:
        print("Rien à scorer. Fin.")
        return

    print("🧠 Scoring selon le profil de goût…")
    scored = score_shows(client, model, taste, candidates)

    seen = load_seen()
    new_hits = [
        s
        for s in scored
        if (s.score or 0) >= threshold and s.key() not in seen
    ]
    new_hits.sort(key=lambda s: s.score or 0, reverse=True)

    print(f"🔔 {len(new_hits)} nouveau(x) spectacle(s) au-dessus du seuil {threshold}.")
    for show in new_hits:
        try:
            send_telegram(tg_token, tg_chat, format_show(show))
            seen.add(show.key())
            print(f"   → notifié : {show.title} ({show.score}/10)")
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️  échec de l'envoi Telegram pour {show.title} : {exc}")

    save_seen(seen)
    print("💾 État sauvegardé.")


if __name__ == "__main__":
    main()
