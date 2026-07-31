from __future__ import annotations

import html
from collections import OrderedDict
from typing import List

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


_TELEGRAM_MAX = 4096
_CHUNK = 3500        # marge sous la limite Telegram
_MAX_DATES = 5       # au-delà, on résume ("+3 autres")


def _short_dates(show: Show) -> str:
    """['05/09 · 19:30', …] -> '05/09, 06/09 (+3 autres)'."""
    dates = [d.split(" · ")[0] for d in (show.available_dates or [])]
    if not dates:
        return ""
    head = ", ".join(dates[:_MAX_DATES])
    extra = len(dates) - _MAX_DATES
    return f"{head} (+{extra} autre{'s' if extra > 1 else ''})" if extra > 0 else head


def format_digest(shows: List[Show]) -> List[str]:
    """Récap hebdomadaire : tout ce qui est réservable, groupé par théâtre.

    Renvoie une LISTE de messages : au-delà de ~4000 caractères Telegram
    refuse l'envoi, donc on découpe sur les frontières de théâtre.
    """
    if not shows:
        return ["📅 <b>Récap du dimanche</b>\n\nRien de surtitré en anglais à se mettre sous la dent cette semaine."]

    by_theater: "OrderedDict[str, List[Show]]" = OrderedDict()
    # Dans un récap, l'ordre chronologique est plus utile que l'ordre par goût
    # du push quotidien (le ⭐ suffit à repérer les coups de cœur).
    for show in sorted(shows, key=lambda s: s.date or "9999"):
        by_theater.setdefault(show.theater, []).append(show)

    header = (
        f"📅 <b>Récap du dimanche</b> — {len(shows)} pièce"
        f"{'s' if len(shows) > 1 else ''} surtitrée"
        f"{'s' if len(shows) > 1 else ''} en anglais, places libres"
    )

    blocks: List[str] = []
    for theater, items in by_theater.items():
        block = [f"\n📍 <b>{_esc(theater)}</b>"]
        for show in items:
            star = " ⭐" if show.matched_keywords else ""
            title = _esc(show.title)
            if show.url:
                title = f'<a href="{html.escape(show.url)}">{title}</a>'
            block.append(f"• {title}{star}")
            detail = " · ".join(
                p for p in (_short_dates(show), show.spoken_language) if p
            )
            if detail:
                line = f"   🗓 {_esc(detail)}"
                if show.booking_url:
                    line += f' · <a href="{html.escape(show.booking_url)}">réserver</a>'
                block.append(line)
        blocks.append("\n".join(block))

    # Regroupe les blocs en messages sous la limite Telegram.
    messages: List[str] = []
    current = header
    for block in blocks:
        if len(current) + len(block) + 1 > _CHUNK:
            messages.append(current)
            current = block.lstrip("\n")
        else:
            current += "\n" + block
    messages.append(current)
    return messages


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
