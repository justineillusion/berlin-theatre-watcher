from __future__ import annotations

import html
import time
from collections import OrderedDict
from typing import List

import httpx

from .language import is_pure_language_note
from .models import Show

_API = "https://api.telegram.org/bot{token}/sendMessage"


def send_telegram(
    token: str,
    chat_id: str,
    text: str,
    retries: int = 3,
    reply_markup: dict | None = None,
) -> int | None:
    """Envoie un message, en réessayant les échecs réseau.

    Sans retry, un simple « read operation timed out » fait perdre l'alerte du
    jour : main.py n'inscrit la pièce dans l'état qu'après un envoi réussi, donc
    elle repartirait au scan suivant — mais pour une représentation le soir même
    c'est déjà trop tard. On insiste donc ici.

    Un 4xx (token ou chat_id faux, message mal formé) n'est pas réessayé : il ne
    se résoudra pas tout seul.

    Renvoie le message_id (le bot multi-utilisateurs s'en sert pour mettre à
    jour la liste « Intéressé·es » sur le message déjà envoyé).
    """
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            resp = httpx.post(_API.format(token=token), json=payload, timeout=30.0)
            if resp.status_code == 429:        # rate-limit : on attend ce qu'on nous dit
                wait = resp.json().get("parameters", {}).get("retry_after", 5)
                time.sleep(min(float(wait), 60.0))
                last_error = httpx.HTTPStatusError("429", request=resp.request, response=resp)
                continue
            resp.raise_for_status()
            return (resp.json().get("result") or {}).get("message_id")
        except httpx.HTTPStatusError as exc:
            if 400 <= exc.response.status_code < 500:
                raise
            last_error = exc
        except httpx.RequestError as exc:      # timeout, DNS, coupure réseau
            last_error = exc
        if attempt < retries - 1:
            time.sleep(2.0 * (attempt + 1))
    raise last_error if last_error else RuntimeError("envoi Telegram échoué")


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


def _fr_date(iso: str | None) -> str:
    """'2027-01-10' -> '10/01/27'."""
    if not iso or len(iso) < 10:
        return iso or ""
    return f"{iso[8:10]}/{iso[5:7]}/{iso[2:4]}"


def expo_period(show: Show) -> str:
    if show.date and show.end_date:
        return f"du {_fr_date(show.date)} au {_fr_date(show.end_date)}"
    if show.end_date:
        return f"jusqu'au {_fr_date(show.end_date)}"
    return f"à partir du {_fr_date(show.date)}" if show.date else ""


def digest_line(show: Show) -> str:
    """Bloc d'une pièce/expo dans un récap (sans la ligne « amis », ajoutée par
    le bot multi-utilisateurs)."""
    star = " ⭐" if show.matched_keywords else ""
    title = _esc(show.title)
    if show.url:
        title = f'<a href="{html.escape(show.url)}">{title}</a>'
    lines = [f"• {title}{star}"]
    if show.kind == "expo":
        period = expo_period(show)
        if period:
            lines.append(f"   🗓 {_esc(period)}")
        return "\n".join(lines)
    detail = " · ".join(p for p in (_short_dates(show), show.spoken_language) if p)
    if detail:
        line = f"   🗓 {_esc(detail)}"
        if show.booking_url:
            line += f' · <a href="{html.escape(show.booking_url)}">réserver</a>'
        lines.append(line)
    if show.critics:
        lines.append(
            f'   📰 <a href="{html.escape(show.critics.url)}">{show.critics.star_bar()}</a>'
            f" ({show.critics.count} critiques)"
        )
    return "\n".join(lines)


def format_expo(show: Show) -> str:
    """Message Telegram (HTML) pour une expo."""
    lines = [f"🖼 <b>{_esc(show.title)}</b>", f"📍 {_esc(show.venue_name or show.theater)}"]
    period = expo_period(show)
    if period:
        lines.append(f"🗓 {_esc(period[0].upper() + period[1:])}")
    if show.languages:
        lines.append(f"✍️ {_esc(show.languages)}")
    if show.summary:
        lines.append(f"\n📝 {_esc(show.summary)}")
    if show.url:
        lines.append(f'\n🔗 <a href="{html.escape(show.url)}">Page de l\'expo</a>')
    return "\n".join(lines)


def format_item(show: Show) -> str:
    return format_expo(show) if show.kind == "expo" else format_show(show)


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
            block.append(digest_line(show))
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
    if show.new_dates:
        lines.append("🆕 Nouvelles dates pour une pièce déjà signalée")

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
    if show.critics:
        lines.append(
            f"\n📰 Presse : {show.critics.label()}\n"
            f'   <a href="{html.escape(show.critics.url)}">Kritikenrundschau sur Nachtkritik</a>'
            " · note estimée"
        )
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
