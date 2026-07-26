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
    """Message Telegram pour une représentation retenue."""
    title = html.escape(show.title)
    lines = [f"🎭 <b>{title}</b>", f"📍 {html.escape(show.theater)}"]

    when = " · ".join(x for x in [show.date, show.time] if x)
    if when:
        lines.append(f"🗓 {html.escape(when)}")
    if show.venue:
        lines.append(f"🏛 {html.escape(show.venue)}")
    if show.score is not None:
        star = "⭐" * min(show.score, 10)
        lines.append(f"\n{star} <b>{show.score}/10</b>")
    if show.reason:
        lines.append(html.escape(show.reason))
    if show.sold_out is False:
        lines.append("🟢 Billets disponibles")
    elif show.sold_out is None:
        lines.append("⚪️ Disponibilité inconnue")
    if show.booking_url:
        lines.append(f'\n🎟 <a href="{html.escape(show.booking_url)}">Réserver</a>')

    return "\n".join(lines)
