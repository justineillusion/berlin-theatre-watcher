from __future__ import annotations

import html

import httpx

from .models import Show

_API = "https://api.telegram.org/bot{token}/sendMessage"


def send_telegram(token: str, chat_id: str, text: str) -> None:
    resp = httpx.post(
        _API.format(token=token),
        json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": False,
        },
        timeout=30.0,
    )
    resp.raise_for_status()


def format_show(show: Show) -> str:
    """Message Telegram (HTML) pour une représentation retenue."""
    lines = [f"🎭 <b>{html.escape(show.title)}</b>", f"📍 {html.escape(show.theater)}"]

    when = " · ".join(x for x in [show.date, show.time] if x)
    if when:
        lines.append(f"🗓 {html.escape(when)}")
    if len(show.available_dates) > 1:
        lines.append("🎟 Places libres : " + html.escape(" | ".join(show.available_dates)))
    if show.venue:
        lines.append(f"🏛 {html.escape(show.venue)}")
    if show.production_type:
        lines.append(f"🎬 {html.escape(show.production_type)}")
    if show.languages:
        lines.append(f"🗣 {html.escape(show.languages)}")
    if show.summary:
        lines.append(f"\n📝 {html.escape(show.summary)}")
    if show.sold_out is False:
        lines.append("🟢 Billets disponibles")
    elif show.sold_out is None:
        lines.append("⚪️ Disponibilité inconnue")
    if show.booking_url:
        lines.append(f'\n🎟 <a href="{html.escape(show.booking_url)}">Réserver</a>')
    elif show.url:
        lines.append(f'\n🔗 <a href="{html.escape(show.url)}">Détails</a>')

    return "\n".join(lines)
