from __future__ import annotations

import html

import httpx

from .language import is_pure_language_note
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


def _esc(text: str) -> str:
    # Telegram HTML ne décode que &lt; &gt; &amp; : on n'échappe donc PAS les
    # guillemets/apostrophes (sinon ils s'affichent en &#x27; / &quot;).
    return html.escape(text, quote=False)


def format_show(show: Show) -> str:
    """Message Telegram (HTML) pour une représentation retenue."""
    lines = [f"🎭 <b>{_esc(show.title)}</b>", f"📍 {_esc(show.theater)}"]

    dates = show.available_dates or ([show.date] if show.date else [])
    if dates:
        lines.append("🗓 Places libres : " + _esc(" | ".join(dates)))
    if show.venue:
        lines.append(f"🏛 {_esc(show.venue)}")
    if show.production_type:
        lines.append(f"🎬 {_esc(show.production_type)}")
    if show.languages and not is_pure_language_note(show.languages):
        lines.append(f"✍️ {_esc(show.languages)}")
    spoken = " · ".join(p for p in (show.spoken_language, show.surtitles) if p)
    if spoken:
        lines.append(f"🗣 {_esc(spoken)}")
    if show.summary:
        lines.append(f"\n📝 {_esc(show.summary)}")
    if show.sold_out is None:
        lines.append("⚪️ Disponibilité inconnue")
    links = []
    if show.booking_url:
        links.append(f'🎟 <a href="{html.escape(show.booking_url)}">Réserver</a>')
    if show.url:
        links.append(f'🔗 <a href="{html.escape(show.url)}">Page de la pièce</a>')
    if links:
        lines.append("\n" + "\n".join(links))

    return "\n".join(lines)
