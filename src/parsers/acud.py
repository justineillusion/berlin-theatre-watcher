"""Source ACUD Theater (acud-theater.de, Veteranenstr. 21, Mitte).

Tout le Spielplan tient sur la page d'accueil, section #programm :

    .eventrow                         (une production)
      .eventType                      -> « International », « Impro », « Premiere », « Kinder », « Workshop »…
      p.metaHeader                    -> compagnie / accroche
      h4 a                            -> titre + page détail (/programm/NNNN-….html)
      p.subHeader                     -> « von … », « Improvisationstheater auf Englisch »…
      .termin-tag                     -> « Sa 21.11., 19:30 » (une par date ; « HEUTE: » devant le jour même)

La langue n'est que sur la page détail : « Sprache der Vorstellung: Spanisch », « The show is in
English », « Die Vorstellung ist nonverbal ». Maison très internationale (espagnol, italien, français…) :
on ne garde (has_english_surtitles) que ce qui se suit en anglais ou sans paroles ; les ateliers et le
jeune public sont écartés.
"""
from __future__ import annotations

import re
from datetime import date
from typing import List, Optional, Tuple

from bs4 import BeautifulSoup

from ..fetch import fetch_html
from ..models import Show

THEATER = "ACUD Theater"
BASE = "https://www.acud-theater.de"
_SKIP_TYPES = {"workshop", "kinder", "streaming"}
_SKIP = re.compile(r"\bworkshops?\b|\btraining\b|kurs(?:e|sprache)?\b|\bcancel|abgesagt", re.I)
_TERMIN = re.compile(r"(\d{1,2})\.(\d{1,2})\.?,?\s*(\d{1,2})[:.](\d{2})")
_LANG_LINE = re.compile(r"Sprache der Vorstellung\s*:\s*([^\n.]{2,60})", re.I)
# Une phrase qui dit la langue de la production (« The show is in English », « … auf Englisch »).
# Pas « (Show in English) » accolé à une date : chez ACUD, ça vise une soirée précise, souvent passée.
_ENGLISH = re.compile(r"\b(?:show|performance|piece|play)\s+is\s+(?:performed\s+)?in\s+english\b|vorstellung\s+ist\s+(?:auf\s+)?englisch|auf\s+englisch\b|performed\s+in\s+english", re.I)
_WORDLESS = re.compile(r"\bnon-?verbal\b|ohne\s+worte|without\s+words|no\s+spoken\s+(?:word|language)", re.I)
_LANGS = [("English", r"englisch|english|inglés"), ("Spanish", r"spanisch|español|spanish"), ("Italian", r"italienisch|italiano|italian"),
          ("French", r"französisch|français|french"), ("German", r"deutsch|german")]


def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").replace("\xad", "")).strip()


def _dates(texts: List[str], today: date) -> List[Tuple[str, str]]:
    """« Sa 21.11., 19:30 » -> ("2026-11-21", "19:30"). Année : celle d'aujourd'hui, ou la suivante
    si le mois est déjà passé de plus de deux mois (le Spielplan de décembre annonce janvier)."""
    out = []
    for t in texts:
        m = _TERMIN.search(t)
        if not m:
            continue
        d, mo, h, mi = (int(g) for g in m.groups())
        y = today.year + (1 if mo < today.month - 2 else 0)
        try:
            out.append((date(y, mo, d).isoformat(), f"{h:02d}:{mi:02d}"))
        except ValueError:
            continue
    return out


def language(page_text: str, sub: str = "") -> Tuple[Optional[str], bool]:
    """(note langue pour le Show, lisible sans allemand ?) à partir de la page détail."""
    text = f"{sub} \n {page_text}"
    if _WORDLESS.search(text) and not _SKIP.search(sub):
        return "Without words", True
    m = _LANG_LINE.search(text)
    names: List[str] = []
    if m:
        names = [n for n, pat in _LANGS if re.search(pat, m.group(1), re.I)]
    elif _ENGLISH.search(text):
        names = ["English"] + [n for n, pat in _LANGS[1:4] if re.search(rf"\b(?:en|in|auf)\s+(?:{pat})\b", text, re.I)]
    if not names:
        return None, False
    note = "In " + " and ".join(names)
    return note, "English" in names


def parse_list(html: str, today: Optional[date] = None) -> List[dict]:
    """Les productions de la page d'accueil (sans la langue, qui est sur la page détail)."""
    today = today or date.today()
    soup = BeautifulSoup(html, "html.parser")
    root = soup.select_one("#programm") or soup
    rows = []
    for r in root.select(".eventrow"):
        a = r.select_one("h4 a[href]")
        if not a:
            continue
        kind = _clean(r.select_one(".eventType").get_text()) if r.select_one(".eventType") else ""
        title = _clean(a.get_text())
        meta = _clean(r.select_one(".metaHeader").get_text()) if r.select_one(".metaHeader") else ""
        sub = _clean(r.select_one(".subHeader").get_text()) if r.select_one(".subHeader") else ""
        if kind.lower() in _SKIP_TYPES or _SKIP.search(f"{title} {sub}"):
            continue
        ds = _dates([_clean(t.get_text()) for t in r.select(".termin-tag")], today)
        if not ds:
            continue
        href = a["href"]
        rows.append({"title": title, "company": meta, "sub": sub, "type": kind, "dates": ds,
                     "url": href if href.startswith("http") else BASE + href})
    return rows


def collect(url: str = BASE + "/") -> List[Show]:
    shows: List[Show] = []
    for row in parse_list(fetch_html(url)):
        try:
            page = _clean(BeautifulSoup(fetch_html(row["url"]), "html.parser").get_text(" "))
        except Exception:  # noqa: BLE001 — page détail indisponible : langue inconnue, on saute
            continue
        note, readable = language(page, row["sub"])
        credits = " · ".join(p for p in (row["company"], row["sub"]) if p and not re.search(r"jeden|every", p, re.I))
        for d, t in row["dates"]:
            shows.append(Show(
                theater=THEATER,
                title=row["title"].title() if row["title"].isupper() else row["title"],
                date=d,
                time=t,
                url=row["url"],
                languages=" · ".join(p for p in (credits, note) if p) or None,
                has_english_surtitles=readable,
            ))
    return shows
