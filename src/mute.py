"""« 🔕 Ne plus suivre » en mode un seul chat (sans Worker ni webhook).

Chaque notification porte un bouton inline. Personne n'écoute Telegram en
continu : les clics restent en attente côté Telegram (24 h max) et sont lus
au DÉBUT du scan suivant via getUpdates. L'effet n'est donc pas instantané :
il s'applique au prochain passage (2 par jour).

État : state/muted.json
    {"offset": 123456790,                       # prochain update_id à lire
     "muted": {"<id>": {"title", "venue", "at"}}}

L'offset n'est pas acquitté explicitement auprès de Telegram : il est
simplement sauvegardé, et c'est le getUpdates du run suivant (offset=N) qui
confirme les updates < N. Si le commit de l'état échoue, rien n'est perdu :
les clics seront relus (et rejoués : c'est idempotent).

Le récap du dimanche (workflow en lecture seule, autre groupe de concurrence)
appelle `sync(..., read_only=True)` : il applique les clics en mémoire pour
filtrer, sans répondre, sans modifier de message et sans toucher à l'offset.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Iterable, List

import httpx

from .models import Show

MUTED_PATH = Path(__file__).resolve().parent.parent / "state" / "muted.json"
_API = "https://api.telegram.org/bot{token}/{method}"

MUTE = "mute:"          # bouton sous une notification
UNMUTE = "unmute:"      # « Réactiver » sous une notification masquée
UNMUTE_LIST = "unl:"    # « Réactiver » depuis la liste /muets


# ---------------------------------------------------------------- identité


def mute_id(show: Show) -> str:
    """Hash court et stable de Show.key() (callback_data ≤ 64 octets)."""
    return key_id(show.key())


def key_id(key: str) -> str:
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def is_muted(show: Show, state: dict) -> bool:
    return mute_id(show) in state.get("muted", {})


def filter_muted(shows: Iterable[Show], state: dict) -> List[Show]:
    kept, skipped = [], []
    for show in shows:
        (skipped if is_muted(show, state) else kept).append(show)
    if skipped:
        print(f"🔕 {len(skipped)} pièce(s) masquée(s) ignorée(s) : "
              + ", ".join(s.title for s in skipped))
    return kept


# ---------------------------------------------------------------- claviers


def mute_keyboard(show: Show) -> dict:
    return {"inline_keyboard": [[{"text": "🔕 Ne plus suivre",
                                  "callback_data": MUTE + mute_id(show)}]]}


def _muted_keyboard(item_id: str) -> dict:
    return {"inline_keyboard": [[{"text": "🔕 Plus suivie · ↩️ Réactiver",
                                  "callback_data": UNMUTE + item_id}]]}


def _restore_keyboard(item_id: str) -> dict:
    return {"inline_keyboard": [[{"text": "🔕 Ne plus suivre",
                                  "callback_data": MUTE + item_id}]]}


def _list_keyboard(muted: dict) -> dict:
    rows = []
    for item_id, info in sorted(muted.items(), key=lambda kv: kv[1].get("title", "").lower()):
        title = info.get("title") or "?"
        if len(title) > 40:
            title = title[:39] + "…"
        rows.append([{"text": f"↩️ Réactiver « {title} »",
                      "callback_data": UNMUTE_LIST + item_id}])
    return {"inline_keyboard": rows}


# ---------------------------------------------------------------- état


def load_muted() -> dict:
    try:
        raw = json.loads(MUTED_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    muted = raw.get("muted") if isinstance(raw.get("muted"), dict) else {}
    offset = raw.get("offset") if isinstance(raw.get("offset"), int) else None
    return {"offset": offset, "muted": muted}


def save_muted(state: dict) -> None:
    MUTED_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"offset": state.get("offset"),
               "muted": dict(sorted(state.get("muted", {}).items()))}
    MUTED_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


# ---------------------------------------------------------------- Telegram


def _call(token: str, method: str, payload: dict, timeout: float = 30.0) -> dict:
    """Appel brut (monkeypatché dans les tests). Lève en cas d'échec."""
    resp = httpx.post(_API.format(token=token, method=method), json=payload, timeout=timeout)
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"{method}: {data.get('description') or resp.status_code}")
    return data


def _try(token: str, method: str, payload: dict) -> None:
    """Effet de bord « best effort » : un callback périmé ou un message déjà
    modifié ne doit jamais faire échouer le scan."""
    try:
        _call(token, method, payload)
    except Exception as exc:  # noqa: BLE001
        print(f"   (Telegram {method} ignoré : {exc})")


def fetch_updates(token: str, offset: int | None) -> list:
    payload: dict = {"timeout": 0, "allowed_updates": ["callback_query", "message"]}
    if offset is not None:
        payload["offset"] = offset
    return _call(token, "getUpdates", payload).get("result") or []


# ---------------------------------------------------------------- traitement


def _title_venue(message: dict | None) -> tuple[str, str]:
    """Titre + lieu depuis le texte (sans HTML) du message notifié :
    '🎭 Titre\\n📍 Théâtre\\n…'."""
    lines = ((message or {}).get("text") or "").splitlines()
    title = lines[0] if lines else ""
    for prefix in ("🎭", "🖼"):
        if title.startswith(prefix):
            title = title[len(prefix):]
    venue = lines[1] if len(lines) > 1 else ""
    venue = venue[len("📍"):] if venue.startswith("📍") else ""
    return title.strip(), venue.strip()


def process_updates(
    token: str,
    chat_id: str,
    state: dict,
    updates: list,
    read_only: bool = False,
) -> dict:
    """Applique les clics / commandes à `state` (modifié sur place).

    read_only=True : on met juste à jour la liste en mémoire, sans aucun appel
    Telegram (ni réponse, ni édition) et sans avancer l'offset.
    """
    muted = state.setdefault("muted", {})
    chat_id = str(chat_id)
    newly_muted: List[str] = []
    unmuted: List[str] = []
    list_requested = False
    max_id = None

    for upd in updates:
        uid = upd.get("update_id")
        if isinstance(uid, int):
            max_id = uid if max_id is None else max(max_id, uid)

        cb = upd.get("callback_query")
        if cb:
            message = cb.get("message") or {}
            origin = (message.get("chat") or {}).get("id") or (cb.get("from") or {}).get("id")
            if str(origin) != chat_id:
                continue                        # quelqu'un d'autre : on ignore
            data = cb.get("data") or ""
            msg_ref = {"chat_id": chat_id, "message_id": message.get("message_id")}
            if data.startswith(MUTE):
                item_id = data[len(MUTE):]
                title, venue = _title_venue(message)
                if item_id not in muted:
                    muted[item_id] = {
                        "title": title or "?",
                        "venue": venue,
                        "at": time.strftime("%Y-%m-%d %H:%M", time.gmtime()),
                    }
                    newly_muted.append(muted[item_id]["title"])
                if not read_only:
                    _try(token, "answerCallbackQuery",
                         {"callback_query_id": cb.get("id"), "text": "🔕 Plus de notifications pour cette pièce"})
                    if message.get("message_id"):
                        _try(token, "editMessageReplyMarkup",
                             {**msg_ref, "reply_markup": _muted_keyboard(item_id)})
            elif data.startswith(UNMUTE) or data.startswith(UNMUTE_LIST):
                from_list = data.startswith(UNMUTE_LIST)
                item_id = data[len(UNMUTE_LIST if from_list else UNMUTE):]
                info = muted.pop(item_id, None)
                if info:
                    unmuted.append(info.get("title") or "?")
                if not read_only:
                    _try(token, "answerCallbackQuery",
                         {"callback_query_id": cb.get("id"), "text": "🔔 Pièce réactivée"})
                    if message.get("message_id"):
                        if from_list:
                            rows = [r for r in (message.get("reply_markup") or {}).get("inline_keyboard", [])
                                    if not any(b.get("callback_data") == data for b in r)]
                            markup = {"inline_keyboard": rows}
                        else:
                            markup = _restore_keyboard(item_id)
                        _try(token, "editMessageReplyMarkup", {**msg_ref, "reply_markup": markup})
            continue

        msg = upd.get("message")
        if msg and str((msg.get("chat") or {}).get("id")) == chat_id:
            cmd = (msg.get("text") or "").strip().split()[:1]
            if cmd and cmd[0].split("@")[0].lower() in ("/muets", "/muet", "/masques"):
                list_requested = True

    if read_only:
        return state

    if max_id is not None:
        state["offset"] = max_id + 1

    # Un seul petit récap par scan (les clics datent parfois de plusieurs heures).
    lines = []
    if newly_muted:
        lines.append("🔕 Plus de notifications pour : " + ", ".join(f"« {t} »" for t in newly_muted))
    if unmuted:
        lines.append("🔔 De nouveau suivie(s) : " + ", ".join(f"« {t} »" for t in unmuted))
    if lines:
        _try(token, "sendMessage", {"chat_id": chat_id, "text": "\n".join(lines),
                                     "disable_notification": True})
    if list_requested:
        if muted:
            text = f"🔕 Pièces masquées ({len(muted)}) — touche pour réactiver :"
            _try(token, "sendMessage", {"chat_id": chat_id, "text": text,
                                         "reply_markup": _list_keyboard(muted)})
        else:
            _try(token, "sendMessage", {"chat_id": chat_id, "text": "Aucune pièce masquée."})
    return state


def sync(token: str, chat_id: str, read_only: bool = False) -> dict:
    """Charge muted.json, lit les clics en attente et (sauf read_only) sauvegarde.

    Un échec réseau n'empêche jamais le scan : on garde la liste connue."""
    state = load_muted()
    if os.environ.get("BOT_API_URL"):
        # Mode multi-utilisateurs : le Worker (webhook) gère déjà « 🔕 Ignorer »
        # et getUpdates répondrait 409. On ne touche à rien.
        return state
    try:
        updates = fetch_updates(token, state.get("offset"))
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  Lecture des clics Telegram impossible ({exc}) : liste masquée inchangée.")
        return state
    if updates:
        print(f"📥 {len(updates)} action(s) Telegram en attente.")
    process_updates(token, chat_id, state, updates, read_only=read_only)
    if not read_only:
        save_muted(state)
    return state
