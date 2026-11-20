"""Étiquettes d'un film : genres (2 max) et festival (Cannes, Berlinale, Venise…).

Genres : ceux des cinémas (Yorck / kinoheld, en allemand), sinon SensCritique (en français),
ramenés à un petit vocabulaire commun, traduit fr / en.

Sans genre côté cinéma ni SensCritique : la première phrase de l'article Wikipédia.

Festival : lu dans l'introduction de l'article Wikipédia (anglais) du film — « It premiered at the
2025 Cannes Film Festival, where it competed for the Palme d'Or ». On ne garde l'article que si
l'année ET un réalisateur correspondent (sinon homonyme). Cache sur disque : une recherche par film,
jamais refaite (sauf « rien trouvé », retenté au bout de 30 jours : les articles arrivent après la sortie).
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional

from .models import Film

# libellé source (minuscule) -> clé commune
_GENRE_KEYS = {
    "drama": "drama", "drame": "drama",
    "komödie": "comedy", "comédie": "comedy", "comedy": "comedy", "schwarze komödie": "comedy", "tragikomödie": "comedy",
    "comédie dramatique": "comedy",
    "thriller": "thriller", "krimi": "crime", "policier": "crime", "crime": "crime",
    "horror": "horror", "épouvante-horreur": "horror", "horreur": "horror",
    "science fiction": "scifi", "science-fiction": "scifi", "sci-fi": "scifi",
    "fantasy": "fantasy", "fantastique": "fantasy",
    "action": "action", "abenteuer": "adventure", "aventure": "adventure",
    "animation": "animation", "animationsfilm": "animation",
    "doku": "doc", "dokumentarfilm": "doc", "dokumentation": "doc", "documentaire": "doc", "documentary": "doc",
    "romanze": "romance", "liebesfilm": "romance", "romance": "romance",
    "western": "western", "musical": "musical", "musik": "music", "musique": "music", "musikfilm": "music",
    "biopic": "biopic", "biographie": "biopic", "historienfilm": "history", "historique": "history", "historie": "history",
    "kriegsfilm": "war", "guerre": "war", "familie": "family", "familienfilm": "family", "famille": "family",
    "kurzfilm": "short", "experimentalfilm": "experimental", "expérimental": "experimental",
}
GENRE_LABELS = {
    "drama": ("Drame", "Drama"), "comedy": ("Comédie", "Comedy"), "thriller": ("Thriller", "Thriller"),
    "crime": ("Polar", "Crime"), "horror": ("Horreur", "Horror"), "scifi": ("Science-fiction", "Sci-fi"),
    "fantasy": ("Fantastique", "Fantasy"), "action": ("Action", "Action"), "adventure": ("Aventure", "Adventure"),
    "animation": ("Animation", "Animation"), "doc": ("Documentaire", "Documentary"), "romance": ("Romance", "Romance"),
    "western": ("Western", "Western"), "musical": ("Comédie musicale", "Musical"), "music": ("Musique", "Music"),
    "biopic": ("Biopic", "Biopic"), "history": ("Historique", "Historical"), "war": ("Guerre", "War"),
    "family": ("Famille", "Family"), "short": ("Court métrage", "Short"), "experimental": ("Expérimental", "Experimental"),
}


def genres(film: Film, limit: int = 2) -> List[str]:
    """Clés communes, dans l'ordre du cinéma (le genre principal d'abord)."""
    raw: List[str] = []
    for s in film.screenings:
        raw += s.genres
    if film.senscritique:
        raw += film.senscritique.genres
    out: List[str] = []
    for g in raw:
        k = _GENRE_KEYS.get(str(g).strip().lower())
        if k and k not in out:
            out.append(k)
    # Rien côté cinéma ni SensCritique : la première phrase de Wikipédia (« a 2025 French comedy-drama film »).
    if not out:
        out = [k for k in (film.wiki_genres or []) if k in GENRE_LABELS]
    # « Drame » + « Comédie » côte à côte disent peu : la comédie suffit.
    if "comedy" in out and "drama" in out:
        out.remove("drama")
    return out[:limit]


def genre_line(film: Film, lang: str) -> str:
    keys = genres(film)
    i = 1 if lang == "en" else 0
    return " · ".join(GENRE_LABELS[k][i] for k in keys)


# --- Série / festival du cinéma (Yorck « specials ») -----------------------------------
_PREVIEW = re.compile(r"^(?:preview|premiere|vorpremiere|avant-premi[eè]re)\b", re.I)


def series_name(category: str, title: str = "") -> str:
    """« 21. Around the World in 14 Films » -> « Around the World in 14 Films » ; « Preview: X » -> « preview » ;
    « Special Screening: X » -> « » (ne dit rien de plus que la séance)."""
    c = re.sub(r"^\s*\d+\.\s*", "", category or "").strip()
    if not c or re.match(r"special screening\b|sondervorstellung\b", c, re.I):
        return ""
    if _PREVIEW.match(c):
        return "preview"
    c = re.sub(r"\s*#\d+\b", "", c.split(":")[0]).strip()
    return c


def series_line(film: Film, lang: str) -> str:
    for s in film.screenings:
        if getattr(s, "event", False) and s.category:
            n = series_name(s.category, film.title)
            if n == "preview":
                return "Preview" if lang == "en" else "Avant-première"
            if n:
                return n
    return ""


# « is a 2024 German psychological thriller film » : l'expression entre « is a(n) » et « film ».
_WIKI_GENRES = [
    ("doc", r"documentar"), ("animation", r"animated|animation"), ("comedy", r"comedy|comedic|satir"),
    ("thriller", r"thriller"), ("horror", r"horror"), ("scifi", r"science[- ]fiction|sci-fi"),
    ("fantasy", r"fantasy"), ("crime", r"crime|gangster|heist|noir"), ("war", r"\bwar\b"),
    ("western", r"western"), ("musical", r"musical"), ("biopic", r"biographical|biopic"),
    ("history", r"historical|period"), ("romance", r"romantic|romance"), ("action", r"action"),
    ("adventure", r"adventure"), ("family", r"family|children's"), ("experimental", r"experimental|essay"),
    ("drama", r"drama"),
]


def genres_from_intro(intro: str) -> List[str]:
    first = re.split(r"(?<=\.)\s", (intro or "").strip(), maxsplit=1)[0]
    m = re.search(r"\b(?:is|was) an? (.{0,120}?)\b(?:film|movie|documentary|short)\b", first, re.I)
    if not m:
        return []
    phrase = m.group(1) + (" documentary" if re.search(r"documentary\s*$", m.group(0), re.I) else "")
    hits = sorted((mm.start(), k) for k, pat in _WIKI_GENRES for mm in [re.search(pat, phrase, re.I)] if mm)
    out: List[str] = []
    for _, k in hits:
        if k not in out:
            out.append(k)
    if "comedy" in out and "drama" in out:
        out.remove("drama")
    return out[:2]


# --- Festivals -------------------------------------------------------------------------
_FESTIVALS = [
    ("Cannes", r"cannes"), ("Berlinale", r"berlin(?:ale| international film festival)"),
    ("Venise", r"venice|mostra"), ("Sundance", r"sundance"), ("Toronto", r"toronto international film festival|\btiff\b"),
    ("Locarno", r"locarno"), ("San Sebastián", r"san sebasti[aá]n"), ("Rotterdam", r"rotterdam"),
    ("Karlovy Vary", r"karlovy vary"), ("Telluride", r"telluride"),
]
_FEST_EN = {"Venise": "Venice"}
_PRIZES = [
    ("Palme d'or", r"(?:won|awarded|winner of) the palme d'or"),
    ("Ours d'or", r"(?:won|awarded|winner of) the golden bear"),
    ("Lion d'or", r"(?:won|awarded|winner of) the golden lion"),
    ("Grand Prix", r"won the grand prix"),
    ("Ours d'argent", r"won the silver bear|silver bear (?:grand jury|for)"),
]
_PRIZE_EN = {"Palme d'or": "Palme d'Or", "Ours d'or": "Golden Bear", "Lion d'or": "Golden Lion", "Ours d'argent": "Silver Bear"}
_CTX = re.compile(r"premiered|world premiere|screened|selected|competed|competition|section|won|awarded|nominated", re.I)
_CACHE = Path(__file__).resolve().parents[2] / "state" / "festival_cache.json"
_API = "https://en.wikipedia.org/w/api.php"


def _plain(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


def festival_from_text(intro: str, year: Optional[int]) -> Optional[dict]:
    """{"fest": "Cannes", "year": 2025, "prize": "Palme d'or" | None} d'après l'intro Wikipédia."""
    for sent in re.split(r"(?<=[.;])\s+", intro or ""):
        if not _CTX.search(sent):
            continue
        for name, pat in _FESTIVALS:
            if re.search(pat, sent, re.I):
                m = re.search(r"\b(19|20)\d\d\b", sent)
                fy = int(m.group(0)) if m else year
                prize = next((p for p, pp in _PRIZES if re.search(pp, intro, re.I)), None)
                return {"fest": name, "year": fy, "prize": prize}
    return None


def festival_line(info: Optional[dict], lang: str) -> str:
    if not info:
        return ""
    fest = _FEST_EN.get(info["fest"], info["fest"]) if lang == "en" else info["fest"]
    out = f"{fest} {info['year']}" if info.get("year") else fest
    if info.get("prize"):
        out += " · " + (_PRIZE_EN.get(info["prize"], info["prize"]) if lang == "en" else info["prize"])
    return out


def _load() -> Dict[str, dict]:
    try:
        return json.loads(_CACHE.read_text())
    except Exception:  # noqa: BLE001
        return {}


def _lookup(client, title: str, year: Optional[int], directors: List[str]) -> Optional[dict]:
    q = f"{title} {year or ''} film".strip()
    r = client.get(_API, params={"action": "query", "list": "search", "srsearch": q, "srlimit": 3, "format": "json"})
    for hit in (r.json().get("query", {}).get("search") or []):
        p = client.get(_API, params={"action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1,
                                     "titles": hit["title"], "format": "json"})
        pages = p.json().get("query", {}).get("pages", {})
        intro = next(iter(pages.values()), {}).get("extract", "") if pages else ""
        low = _plain(intro)
        if year and str(year) not in intro:
            continue
        if directors and not any(_plain(d).split()[-1] in low for d in directors if d.strip()):
            continue
        return {"found": festival_from_text(intro, year), "page": hit["title"], "genres": genres_from_intro(intro)}
    return None


def festivals(films: List[Film], budget_s: float = 240.0) -> Dict[str, Optional[dict]]:
    """item_id -> info festival (ou None). Réseau seulement pour les films jamais cherchés."""
    cache = _load()
    out: Dict[str, Optional[dict]] = {}
    todo = []
    now = time.time()
    for f in films:
        c = cache.get(f.item_id())
        # Article trouvé avant l'ajout des genres : on le relit une fois pour sa première phrase.
        if c and "genres" not in c and c.get("page"):
            c = None
        if c and (c.get("found") or c.get("page") or now - c.get("at", 0) < 30 * 86400):
            out[f.item_id()] = c.get("found")
            f.wiki_genres = c.get("genres") or []
        else:
            todo.append(f)
    if todo:
        try:
            import httpx
            t0 = time.time()
            with httpx.Client(timeout=10, follow_redirects=True, headers={"User-Agent": "BerlinEncore/1.0 (https://berlinencore.app; film festival tags) httpx"}) as cl:
                for f in todo:
                    if time.time() - t0 > budget_s:
                        break
                    year = f.year or (f.senscritique.year if f.senscritique else None)
                    dirs = list(f.screenings[0].directors) if f.screenings else []
                    if not dirs and f.senscritique:
                        dirs = list(f.senscritique.directors)
                    try:
                        hit = _lookup(cl, f.original_title or f.title, year, dirs)
                    except Exception:  # noqa: BLE001 — Wikipédia lent / en panne : on réessaiera
                        continue
                    found = hit["found"] if hit else None
                    cache[f.item_id()] = {"found": found, "at": now, "page": hit["page"] if hit else None,
                                          "genres": hit["genres"] if hit else []}
                    out[f.item_id()] = found
                    f.wiki_genres = hit["genres"] if hit else []
            _CACHE.parent.mkdir(exist_ok=True)
            _CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0))
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️  festivals : {exc}")
    return out
