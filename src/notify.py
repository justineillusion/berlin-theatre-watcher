from __future__ import annotations

import html
import re
import time
from collections import OrderedDict
from typing import List

import httpx

from .language import is_pure_language_note, to_english_labels
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


def _short_dates(show: Show, lang: str = "fr") -> str:
    """['05/09 · 19:30', …] -> '05/09, 06/09 (+3 autres)'."""
    dates = [d.split(" · ")[0] for d in (show.available_dates or [])]
    if not dates:
        return ""
    head = ", ".join(dates[:_MAX_DATES])
    extra = len(dates) - _MAX_DATES
    if extra <= 0:
        return head
    return f"{head} (+{extra} more)" if lang == "en" else f"{head} (+{extra} autre{'s' if extra > 1 else ''})"


def _fr_date(iso: str | None) -> str:
    """'2027-01-10' -> '10/01/27'."""
    if not iso or len(iso) < 10:
        return iso or ""
    return f"{iso[8:10]}/{iso[5:7]}/{iso[2:4]}"


def expo_period(show: Show, lang: str = "fr") -> str:
    a, b = _fr_date(show.date), _fr_date(show.end_date)
    if lang == "en":
        if show.date and show.end_date:
            return f"{a} – {b}"
        if show.end_date:
            return f"until {b}"
        return f"from {a}" if show.date else ""
    if show.date and show.end_date:
        return f"du {a} au {b}"
    if show.end_date:
        return f"jusqu'au {b}"
    return f"à partir du {a}" if show.date else ""


def _labels(show: Show, lang: str):
    """(langue parlée, surtitres) dans la langue du message."""
    if lang == "en":
        return to_english_labels(show.spoken_language, show.surtitles)
    return show.spoken_language, show.surtitles


def _summary(show: Show, lang: str):
    """Résumé dans la langue voulue ; pas de repli dans l'autre langue
    (mieux vaut pas de résumé qu'un résumé dans une langue non lue)."""
    return show.summary_en if lang == "en" else show.summary


def _aliases(show: Show) -> List[str]:
    """Autres titres pour la presse : « Die Wildente (The Wild Duck) » -> les deux."""
    import re as _re
    m = _re.match(r"^(.*?)\s*\((.*?)\)\s*$", show.title or "")
    out = [m.group(1), m.group(2)] if m else []
    return [a for a in out + list(getattr(show, "aliases", None) or []) if a and a != show.title]


def press_line(show: Show, lang: str = "fr") -> str:
    """Ligne 📰 unique : uniquement ce qui informe vraiment.
    - Nachtkritik (note + nb de critiques), sans lien ;
    - buzz presse seulement s'il y a un avis tranché (👍/😐/👎/🔥).
    Rien sinon : pas de « pas encore de critiques » / « pas encore ouvert »,
    qui prennent de la place pour rien (et la 1re date réservable n'est pas
    la première de la pièce)."""
    parts = []
    if show.critics:
        n = show.critics.count
        rev = (f"{n} review{'s' if n > 1 else ''}" if lang == "en" else f"{n} critique{'s' if n > 1 else ''}")
        parts.append(f"Nachtkritik {show.critics.star_bar()} ({rev})")
    try:
        from .press import press_for, format_buzz
        venue = (show.venue_name or show.theater) if show.kind == "expo" else show.theater
        b = press_for(show.kind, venue, show.title, show.url or "", opens=None, aliases=_aliases(show))
        if b.get("status") == "verdict":
            parts.append(format_buzz(b, lang).removeprefix("📰 "))
    except Exception:  # noqa: BLE001 — la presse est un bonus, jamais bloquante
        pass
    return ("📰 " + _esc(" · ".join(parts))) if parts else ""


_CREDIT_NOISE = re.compile(
    r"\s*(World Premiere|Uraufführung|Premiere|With English surtitles|Mit englischen Übertiteln|"
    r"PLATZ ?FR ?E ?I|Eine Aktion|Stage [A-Z]\b|Tickets?|Dauer|Duration).*$", re.I)


def clean_credits(text: str) -> str:
    """« by Falk Richter Director: Falk Richter World Premiere Stage A … » -> « by Falk Richter »."""
    t = _CREDIT_NOISE.sub("", text or "").strip(" ,;·-")
    t = re.sub(r"\s+Director:\s*(.+)$", lambda m: "" if m.group(1).strip() in t[:m.start()] else m.group(0), t)
    if len(t) > 110:
        t = t[:110].rsplit(" ", 1)[0] + "…"
    return t


_CREDIT_WORDS = {
    "fr": [(r"\bin an adaptation by\b", "dans une adaptation de"), (r"\bin collaboration with\b", "en collaboration avec"),
           (r"\badapted by\b", "adapté par"), (r"\bdirected by\b", "mis en scène par"), (r"^\s*(?:by|von)\b", "De"),
           (r"\bafter\b|\bnach\b", "d'après"), (r"\bby\b|\bvon\b", "de"), (r"\band\b|\bund\b", "et"),
           (r"\(Book\)", "(livret)"), (r"\(Music\)", "(musique)"), (r"\bDirector:", "Mise en scène :"),
           (r"\bwith\b|\bmit\b", "avec")],
    "en": [(r"^\s*(?:by|von)\b", "By"), (r"\bnach\b", "after"), (r"\bvon\b", "by"), (r"\bund\b", "and"),
           (r"\bmit\b", "with"), (r"\bRegie:", "Director:")],
}


def credits_line(text: str, lang: str = "fr") -> str:
    """Crédits nettoyés, connecteurs dans la langue de la fiche (« By X and Y » -> « De X et Y »)."""
    t = clean_credits(text)
    for pat, rep in _CREDIT_WORDS.get(lang, []):
        t = re.sub(pat, rep, t, flags=re.I)
    if lang == "fr":                        # élision : « D'Oscar Wilde », « d'Elisabeth »
        t = re.sub(r"\b([Dd])e ([AEIOUÉÈÂÎaeiouéèâî])", r"\1'\2", t)
    return t


def digest_line(show: Show, lang: str = "fr") -> str:
    """Bloc d'une pièce/expo dans un récap (sans la ligne « amis », ajoutée par
    le bot multi-utilisateurs)."""
    star = " ⭐" if show.matched_keywords else ""
    title = _esc(show.title)
    if show.url:
        title = f'<a href="{html.escape(show.url)}">{title}</a>'
    lines = [f"• {title}{star}"]
    if show.kind == "expo":
        period = expo_period(show, lang)
        if period:
            lines.append(f"   🗓 {_esc(period)}")
        return "\n".join(lines)
    detail = " · ".join(p for p in (_short_dates(show, lang), _labels(show, lang)[0]) if p)
    if detail:
        line = f"   🗓 {_esc(detail)}"
        if show.booking_url:
            book = "book" if lang == "en" else "réserver"
            line += f' · <a href="{html.escape(show.booking_url)}">{book}</a>'
        lines.append(line)
    if show.critics:
        n = show.critics.count
        reviews = f"{n} review{'s' if n > 1 else ''}" if lang == "en" else f"{n} critiques"
        lines.append(
            f'   📰 <a href="{html.escape(show.critics.url)}">{show.critics.star_bar()}</a>'
            f" ({reviews})"
        )
    return "\n".join(lines)


def format_expo(show: Show, lang: str = "fr") -> str:
    """Message Telegram (HTML) pour une expo."""
    lines = [f"🖼 <b>{_esc(show.title)}</b>", f"📍 {_esc(show.venue_name or show.theater)}"]
    period = expo_period(show, lang)
    if period:
        lines.append(f"🗓 {_esc(period[0].upper() + period[1:])}")
    if show.languages:
        lines.append(f"✍️ {_esc(credits_line(show.languages, lang))}")
    press = press_line(show, lang)
    if press:
        lines.append(press)
    summary = _summary(show, lang)
    if summary:
        lines.append(f"\n📝 {_esc(summary)}")
    if show.url:
        page = "Exhibition page" if lang == "en" else "Page de l'expo"
        lines.append(f'\n🔗 <a href="{html.escape(show.url)}">{page}</a>')
    return "\n".join(lines)


def format_item(show: Show, lang: str = "fr") -> str:
    return format_expo(show, lang) if show.kind == "expo" else format_show(show, lang)


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


def format_show(show: Show, lang: str = "fr") -> str:
    """Fiche (HTML) d'une pièce — même gabarit que les expos et les films :
    titre · 📍 lieu · 🗓 dates · 🗣 langue · ★ note (si connue) · 📝 description · liens."""
    en = lang == "en"
    lines = [f"🎭 <b>{_esc(show.title)}</b>"]
    lines.append(f"📍 {_esc(show.theater)}" + (f" · {_esc(show.venue)}" if show.venue else ""))
    if show.new_dates:
        lines.append("🆕 New dates for a play already announced" if en
                     else "🆕 Nouvelles dates pour une pièce déjà signalée")
    dates = show.available_dates or ([show.date] if show.date else [])
    if dates:
        more = len(dates) - 5
        shown = " | ".join(dates[:5]) + ((f" (+{more} more)" if en else f" (+{more} autres)") if more > 0 else "")
        lines.append(("🗓 Seats available: " if en else "🗓 Places libres : ") + _esc(shown))
    # Disponibilité inconnue : on n'écrit rien (docs/ux.md, zéro remplissage).
    if show.production_type:
        lines.append(f"🎬 {_esc(show.production_type)}")
    if show.languages and not is_pure_language_note(show.languages):
        lines.append(f"✍️ {_esc(credits_line(show.languages, lang))}")
    spoken = " · ".join(p for p in _labels(show, lang) if p)
    if spoken:
        lines.append(f"🗣 {_esc(spoken)}")
    press = press_line(show, lang)
    if press:
        lines.append(press)
    summary = _summary(show, lang)
    if summary:
        lines.append(f"\n📝 {_esc(summary)}")
    links = []
    if show.booking_url:
        links.append(f'🎟 <a href="{html.escape(show.booking_url)}">{"Book" if en else "Réserver"}</a>')
    if show.url:
        links.append(f'🔗 <a href="{html.escape(show.url)}">{"Play page" if en else "Page de la pièce"}</a>')
    if links:
        lines.append("\n" + " · ".join(links))
    return "\n".join(lines)
