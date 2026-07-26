"""Récupère ton TELEGRAM_CHAT_ID.

1. Crée un bot avec @BotFather sur Telegram, note le token.
2. Envoie un message ("hi") à ton bot depuis ton compte.
3. Lance :  TELEGRAM_BOT_TOKEN=... python -m src.get_chat_id
"""
from __future__ import annotations

import os
import sys

import httpx


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        sys.exit("Définis TELEGRAM_BOT_TOKEN d'abord.")
    resp = httpx.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=30.0)
    resp.raise_for_status()
    updates = resp.json().get("result", [])
    if not updates:
        sys.exit("Aucun message reçu. Envoie 'hi' à ton bot puis relance.")
    for upd in updates:
        chat = (upd.get("message") or upd.get("channel_post") or {}).get("chat", {})
        if chat:
            print(f"chat_id = {chat.get('id')}  ({chat.get('first_name') or chat.get('title')})")


if __name__ == "__main__":
    main()
