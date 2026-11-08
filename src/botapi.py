"""Mode multi-utilisateurs : le scraper parle au Worker Cloudflare (worker/).

Répartition des rôles :
    - ici (GitHub Actions, Python) : scraping, résumés, notes presse, ENVOI des
      messages Telegram (le plan gratuit Cloudflare limite un Worker à 50
      requêtes sortantes par appel : impossible d'y faire 10 amis × 20 pièces) ;
    - le Worker (D1) : amis, abonnements, ⭐/✅/🔕, notes des amis, et la
      décision « qui reçoit quoi ». Il construit les messages, on les poste.

Déroulé d'un scan :
    1. POST /api/plan   lieux + pièces (sans texte)  -> ids à rédiger
    2. on enrichit ces pièces seulement (pages détail, Nachtkritik)
    3. POST /api/render textes                       -> messages par ami
    4. envoi Telegram, puis POST /api/sent           -> message_id mémorisés
Un envoi raté n'est pas déclaré : il repartira au scan suivant (comme avant).
"""
from __future__ import annotations

import copy
from datetime import date, timedelta

import os
from typing import Callable, Dict, List

import httpx

from .models import Show
from .notify import digest_line, format_item, send_telegram


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=os.environ["BOT_API_URL"].rstrip("/"),
        headers={"Authorization": f"Bearer {os.environ['BOT_API_TOKEN']}"},
        timeout=120.0,
    )


def _venues(config: dict) -> List[dict]:
    from .main import venue_slug

    return [
        {"id": venue_slug(t["name"]), "name": t["name"], "kind": t.get("kind", "theatre")}
        for t in config["theaters"]
    ]


def _meta(show: Show) -> dict:
    return {
        "id": show.item_id(),
        "venue_id": show.venue_id,
        "kind": show.kind,
        "title": show.title,
        "url": show.url,
        "dates": sorted(set(show.available_iso)),
        "start_date": show.date if show.kind == "expo" else None,
        "end_date": show.end_date,
        "starred": bool(show.matched_keywords),
    }


def _complete(show: Show, need_ids: set) -> bool:
    """Texte complet (écrase l'ancien) : ce qui part, ou ce qui a un résumé / une note.
    Sinon version courte qui ne remplace jamais un texte complet déjà en base."""
    return show.item_id() in need_ids or bool(show.summary or show.summary_en or show.critics)


HORIZON_THEATRE_DAYS = 14   # config.yaml horizon_theatre_days (fixé par run_multi)


def _windowed(show: Show) -> Show:
    """Pièce : seulement les dates des `horizon_theatre_days` prochains jours
    (la fiche ne montre que ce qui se joue bientôt ; les dates d'après restent
    en base et seront annoncées en entrant dans la fenêtre)."""
    if show.kind != "theatre" or len(show.available_iso) != len(show.available_dates):
        return show
    now = date.today()
    end = (now + timedelta(days=HORIZON_THEATRE_DAYS)).isoformat()
    keep = [i for i, d in enumerate(show.available_iso) if now.isoformat() <= d[:10] <= end]
    if not keep or len(keep) == len(show.available_iso):
        return show
    out = copy.copy(show)
    out.available_iso = [show.available_iso[i] for i in keep]
    out.available_dates = [show.available_dates[i] for i in keep]
    return out


def _texts(show: Show, langs: tuple) -> dict:
    show = _windowed(show)
    out = {"id": show.item_id(), "text": format_item(show), "line": digest_line(show)}
    if "en" in langs:
        out["text_en"] = format_item(show, "en")
        out["line_en"] = digest_line(show, "en")
    return out


def run_multi(
    hits: List[Show],
    config: dict,
    tg_token: str,
    digest: bool,
    enrich: Callable[[List[Show], bool, tuple], None],
) -> None:
    from .main import add_critics
    global HORIZON_THEATRE_DAYS
    HORIZON_THEATRE_DAYS = int(config.get("horizon_theatre_days", 14))

    mode = "digest" if digest else "scan"
    by_id: Dict[str, Show] = {s.item_id(): s for s in hits}

    with _client() as api:
        plan = api.post(
            "/api/plan",
            json={
                "mode": mode,
                "venues": _venues(config),
                "items": [_meta(s) for s in hits],
                "expo_last_weeks_days": config.get("expo_last_weeks_days", 14),
                "horizon_expo_days": config.get("horizon_expo_days", 7),
                "horizon_theatre_days": config.get("horizon_theatre_days", 14),
            },
        )
        plan.raise_for_status()
        need = [by_id[i] for i in plan.json()["need"] if i in by_id]
        # Langues lues par au moins un ami actif (le Worker choisit la variante par personne).
        langs = tuple(plan.json().get("langs") or ["fr"])
        print(f"👥 {plan.json().get('users', 0)} ami·e(s) inscrit·e(s) ; {len(need)} pièce(s) à rédiger"
              f" ({', '.join(langs)}).")

        need_ids = {s.item_id() for s in need}
        # TOUT le catalogue est rédigé (résumé + note presse), pas seulement ce qui
        # part : /programme et le parcours par lieu montrent des fiches complètes.
        # Les nouveautés d'abord (budget de temps) ; caches = coût faible ensuite.
        ordered = need + [s for s in hits if s.item_id() not in need_ids]
        enrich(ordered, digest, langs)
        add_critics(ordered, config)

        rendered = api.post(
            "/api/render",
            json={
                "mode": mode,
                "items": [_texts(s, langs) for s in ordered if _complete(s, need_ids)],
                # Tout le reste du catalogue, en version courte (sans résumé ni
                # critiques) : /programme et les récaps ont toujours une ligne.
                # Le Worker n'écrase pas un texte complet déjà rédigé.
                "basic": [_texts(s, langs) for s in ordered if not _complete(s, need_ids)],
            },
        )
        rendered.raise_for_status()
        messages = rendered.json()["messages"]

        sent: List[dict] = []
        for msg in messages:
            # On renvoie au Worker tout ce qu'il nous a donné (item, type, dates,
            # en-tête…) sauf le texte : c'est lui qui sait quoi en faire.
            report = {k: v for k, v in msg.items() if k not in ("text", "reply_markup")}
            try:
                report["message_id"] = send_telegram(
                    tg_token, str(msg["chat_id"]), msg["text"],
                    reply_markup=msg.get("reply_markup"),
                )
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                print(f"   ⚠️  envoi refusé ({code}) pour {msg['chat_id']}")
                if code == 403:            # l'ami a bloqué le bot
                    report["error"] = 403
                else:
                    continue
            except Exception as exc:  # noqa: BLE001
                print(f"   ⚠️  échec de l'envoi pour {msg['chat_id']} : {exc}")
                continue
            sent.append(report)

        if sent:
            api.post("/api/sent", json={"sent": sent}).raise_for_status()

    ok = sum(1 for r in sent if "error" not in r)
    print(f"🔔 {ok}/{len(messages)} message(s) envoyé(s) ({mode}).")
