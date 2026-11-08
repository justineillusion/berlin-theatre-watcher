"""Chaque surface rendue en fr ET en en : aucune chaîne codée en dur dans l'autre langue.

On rend les cartes (pièce, expo, ligne de récap, film) avec un contenu NEUTRE
(titres et lieux sans mots fr/en), puis on cherche les mots-outils de l'autre
langue. On vérifie aussi que le dictionnaire anglais du Worker (worker/src/i18n.ts)
ne contient pas de français.

    ./.venv/bin/python -m tests.test_lang_surfaces
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.cinema import message as cm
from src.cinema.models import Film, Rating, Screening
from src.models import Show
from src.notify import digest_line, format_expo, format_show

FR_MARKERS = r"\b(?:le|la|les|des|du|une|pour|jusqu'au|autres?|places|réserver|libres|nouvelles|page de|"\
             r"pièce|déjà|à partir|surtitres|en allemand|séances?|programme connu|pas encore)\b"
EN_MARKERS = r"\b(?:the|and|until|from|more|seats|available|book|play page|exhibition page|new dates|"\
             r"surtitles|in german|screenings?|not rated|known until)\b"

_HTML = re.compile(r"<[^>]+>")


def _visible(html: str) -> str:
    return _HTML.sub(" ", html)


def _check(text: str, lang: str, where: str) -> None:
    other = EN_MARKERS if lang == "fr" else FR_MARKERS
    hits = re.findall(other, _visible(text), re.I)
    assert not hits, f"{where} [{lang}] contient {hits!r} :\n{text}"


def _play() -> Show:
    return Show(
        theater="Xyztheater", title="Qwerty", venue="Saal Zz", url="https://x/p", booking_url="https://x/b",
        available_dates=[f"0{i}/12 · 19:30" for i in range(1, 8)], available_iso=["2026-12-01 19:30"],
        new_dates=["2026-12-01 19:30"], production_type=None, spoken_language="En anglais",
        surtitles="surtitres anglais", summary="Résumé.", summary_en="Summary.", venue_id="x", venue_name="Xyztheater",
    )


def _expo() -> Show:
    return Show(theater="Xyzmuseum", title="Qwerty", date="2026-11-01", end_date="2027-01-10", kind="expo",
                url="https://x/e", summary="Résumé.", summary_en="Summary.", venue_id="m", venue_name="Xyzmuseum")


def _film() -> Film:
    start = datetime.now(timezone.utc) + timedelta(days=1)
    s = Screening(cinema="Kinox", start=start, title="Qwerty", url="https://x/f", booking_url="https://x/t", version="OmU")
    return Film(key="qwerty", screenings=[s], senscritique=Rating("SensCritique", 7.5, 900, "https://sc/x"),
                pitch="Pitch.", pitch_en="Pitch.")


def test_theatre_and_expo_cards():
    for lang in ("fr", "en"):
        sh = _play()
        if lang == "en":
            sh.spoken_language = "In English"
            sh.surtitles = "English surtitles"
        _check(format_show(sh, lang), lang, "fiche pièce")
        _check(digest_line(sh, lang), lang, "ligne de récap pièce")
        _check(format_expo(_expo(), lang), lang, "fiche expo")
        _check(digest_line(_expo(), lang), lang, "ligne de récap expo")


def test_film_card():
    for lang in ("fr", "en"):
        _check(cm.film_card(_film(), lang), lang, "fiche film")


def test_worker_english_dictionary_has_no_french():
    src = (Path(__file__).resolve().parent.parent / "worker" / "src" / "i18n.ts").read_text(encoding="utf-8")
    en = src[src.index("const en: typeof fr = {"):]
    en = en[: en.index("\n};")]
    # On ignore les commandes (/interets, /suivre…) : ce sont des noms de commande.
    body = re.sub(r"/[a-z]+", " ", en)
    body = re.sub(r"🇫🇷 Français|Langue des messages[^\"]*", " ", body)
    hits = re.findall(FR_MARKERS + r"|[éèêàçù]", body, re.I)
    assert not hits, f"i18n.ts (en) contient du français : {sorted(set(hits))}"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
