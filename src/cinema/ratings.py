"""Notes SensCritique (principale) et Letterboxd (repli).

SensCritique
------------
Pas d'API officielle, mais le site est une app Next.js qui interroge une API
GraphQL publique : ``https://apollo.senscritique.com/`` (introspection fermée,
requêtes reprises du JS du site). La recherche ``searchProductExplorer`` cherche
aussi dans les titres ORIGINAUX : « Der Himmel über Berlin » → « Les Ailes du
désir », « Dip huet seung hung » → « The Killer ». Elle renvoie pour chaque
œuvre : titre FR, titre original, année, réalisateurs, genres, pays, note
moyenne (/10), nombre de votes et un synopsis en français (→ pitch).

Rapprochement séance ↔ fiche
---------------------------
On interroge avec chaque titre connu (titre original, titre affiché, morceaux
« Hass – La Haine »), puis on note chaque candidat « film » :
  similarité de titre (titre FR ou original) + réalisateur commun + année ±2.
Un candidat est accepté si le titre colle ET (réalisateur commun OU année
proche). Sans réalisateur ni année côté cinéma, on n'accepte qu'un titre
identique et récent (sortie en salle actuelle) → confiance « faible ».
Attention : ``yearOfProduction`` est parfois l'année de sortie française
(Ghost in the Shell 1995 → 1997), d'où la tolérance et le poids du réalisateur.

Letterboxd
----------
La recherche Letterboxd est derrière Cloudflare (403), mais les pages film
sont lisibles : on devine le slug (``mulholland-drive``, ``the-killer-1989``)
et on vérifie année/réalisateur dans le JSON-LD de la page.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from datetime import date
from difflib import SequenceMatcher
from typing import Dict, Iterable, List, Optional, Tuple

import httpx

from .http import client, post_json
from .models import Rating

_SC_API = "https://apollo.senscritique.com/"
_SC_HEADERS = {
    "Origin": "https://www.senscritique.com",
    "Referer": "https://www.senscritique.com/",
    "Content-Type": "application/json",
}
_SC_QUERY = """
query SearchProductExplorer($query: String, $offset: Int, $limit: Int, $filters: [SearchFilter]) {
  searchProductExplorer(query: $query, filters: $filters, offset: $offset, limit: $limit) {
    items {
      id title originalTitle yearOfProduction dateRelease dateReleaseOriginal
      rating url synopsis universe
      directors { name } countries { name } genresInfos { label }
      stats { ratingCount }
    }
  }
}
"""


# ---------------------------------------------------------------------------
# Normalisation / similarité
# ---------------------------------------------------------------------------
_ARTICLES = r"^(the|a|an|le|la|les|l|der|die|das|el|los|las|il|lo|i)\s+"


def norm_title(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)                       # (4K Restauration), [OmU]
    s = re.sub(r"\b(4k|restaur\w*|director'?s cut|re|wa|omu|omeu|ov|ome?u)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(_ARTICLES, "", s)
    return s


def _surname(name: str) -> str:
    flat = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    parts = [p for p in re.split(r"[^a-z]+", flat) if p]
    return parts[-1] if parts else ""


def title_similarity(ours: Iterable[str], theirs: Iterable[str]) -> float:
    best = 0.0
    for a in ours:
        na = norm_title(a)
        if not na:
            continue
        for b in theirs:
            nb = norm_title(b)
            if not nb:
                continue
            r = 1.0 if na == nb else SequenceMatcher(None, na, nb).ratio()
            best = max(best, r)
    return best


def _years(item: dict) -> List[int]:
    out = []
    for k in ("yearOfProduction", "dateRelease", "dateReleaseOriginal"):
        v = item.get(k)
        if v:
            try:
                out.append(int(str(v)[:4]))
            except ValueError:
                pass
    return out


def _score(item: dict, titles: List[str], year: Optional[int], directors: List[str]) -> Tuple[float, str]:
    """Renvoie (score, confiance). score < 0 = rejeté."""
    tsim = title_similarity(titles, [item.get("title") or "", item.get("originalTitle") or ""])
    their_dirs = {_surname(d["name"]) for d in item.get("directors") or [] if d.get("name")}
    our_dirs = {_surname(d) for d in directors if d}
    dir_match = bool(their_dirs & our_dirs)
    dir_clash = bool(their_dirs and our_dirs and not dir_match)
    years = _years(item)
    year_ok = bool(year and years and any(abs(y - year) <= 2 for y in years))
    year_clash = bool(year and years and not year_ok)

    if dir_match and tsim >= 0.55:
        return 2.0 + tsim + (0.3 if year_ok else 0), "high"
    if tsim >= 0.85 and year_ok and not dir_clash:
        return 1.5 + tsim, "high"
    if tsim >= 0.97 and not our_dirs and not year and not dir_clash:
        # séance sans métadonnées : on n'accepte qu'une sortie récente au titre identique
        recent = any(y >= date.today().year - 2 for y in years)
        if recent:
            return 1.0 + tsim, "low"
    return -1.0, ""


# ---------------------------------------------------------------------------
# SensCritique
# ---------------------------------------------------------------------------
_sc_cache: Dict[str, list] = {}


def _sc_search(query: str) -> list:
    if query in _sc_cache:
        return _sc_cache[query]
    payload = {
        "operationName": "SearchProductExplorer",
        "query": _SC_QUERY,
        "variables": {"query": query, "offset": 0, "limit": 8,
                      "filters": [{"identifier": "universe", "termValues": ["movie"]}]},
    }
    try:
        data = post_json(_SC_API, payload, headers=_SC_HEADERS)
        items = ((data.get("data") or {}).get("searchProductExplorer") or {}).get("items") or []
    except Exception:  # noqa: BLE001
        items = []
    _sc_cache[query] = items
    time.sleep(0.4)
    return items


_EDITION = re.compile(
    r"\s*[-–:]\s*(the\s+)?(director'?s\s+cut|restored.*|remaster.*|\d+k\s*restaur.*|wiederauff.*|extended.*)$"
    r"|\s*[\[(][^\])]*[\])]", re.I)


def clean_query(title: str) -> str:
    """« The Devils - Director's Cut » -> « The Devils » ; « Zombies (2012) » -> « Zombies »."""
    return _EDITION.sub("", title or "").strip(" -–:")


def senscritique(titles: List[str], year: Optional[int], directors: List[str]) -> Optional[Rating]:
    queries: List[str] = []
    expanded: List[str] = []
    for t in titles:
        expanded += [t, clean_query(t)]
    for t in expanded:
        t = (t or "").strip()
        if t and t.lower() not in (q.lower() for q in queries):
            queries.append(t)
    if directors and queries:
        queries.append(f"{queries[0]} {_surname(directors[0])}")

    best: Tuple[float, Optional[dict], str] = (-1.0, None, "")
    for q in queries:
        for item in _sc_search(q):
            if item.get("universe") not in (1, None):
                continue
            score, conf = _score(item, queries, year, directors)
            # à score égal, la fiche la plus votée (la « vraie ») gagne
            score += min((item.get("stats") or {}).get("ratingCount") or 0, 50_000) / 1_000_000
            if score > best[0]:
                best = (score, item, conf)
        if best[0] >= 2.0:                     # réalisateur confirmé : inutile de chercher plus
            break
    item = best[1]
    if not item or best[0] < 0:
        return None
    years = _years(item)
    return Rating(
        source="SensCritique",
        value=float(item["rating"]) if item.get("rating") is not None else 0.0,   # 0 = pas de moyenne publiée
        count=(item.get("stats") or {}).get("ratingCount") or 0,
        url="https://www.senscritique.com" + (item.get("url") or ""),
        scale=10,
        title=item.get("title"),
        original_title=item.get("originalTitle") or item.get("title"),
        year=min(years) if years else None,
        directors=[d["name"] for d in item.get("directors") or []],
        genres=[g["label"] for g in item.get("genresInfos") or []],
        countries=[c["name"] for c in item.get("countries") or []],
        synopsis=item.get("synopsis"),
        confidence=best[2],
    )


# ---------------------------------------------------------------------------
# Letterboxd (repli)
# ---------------------------------------------------------------------------
def _lb_slug(title: str) -> str:
    flat = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    flat = flat.replace("&", " ").replace("'", "")
    return re.sub(r"[^a-z0-9]+", "-", flat).strip("-")


def _lb_page(slug: str) -> Optional[dict]:
    try:
        resp = client().get(f"https://letterboxd.com/film/{slug}/")
    except httpx.HTTPError:
        return None
    time.sleep(0.4)
    if resp.status_code != 200:
        return None
    m = re.search(r'<script type="application/ld\+json">\s*(?:/\*.*?\*/)?\s*(\{.*?\})\s*(?:/\*.*?\*/)?\s*</script>',
                  resp.text, re.S)
    if not m:
        return None
    try:
        ld = json.loads(m.group(1))
    except ValueError:
        return None
    ld["_url"] = str(resp.url)
    return ld


def letterboxd(titles: List[str], year: Optional[int], directors: List[str]) -> Optional[Rating]:
    slugs: List[str] = []
    for t in list(dict.fromkeys(clean_query(x) for x in titles if x)):
        base = _lb_slug(t or "")
        if not base:
            continue
        cands = ([f"{base}-{year}"] if year else []) + [base]
        for s in cands:
            if s not in slugs:
                slugs.append(s)
    our_dirs = {_surname(d) for d in directors if d}
    for slug in slugs[:6]:
        ld = _lb_page(slug)
        if not ld:
            continue
        agg = ld.get("aggregateRating") or {}
        if not agg.get("ratingValue"):
            continue
        dirs = ld.get("director") or []
        dirs = dirs if isinstance(dirs, list) else [dirs]
        their_dirs = {_surname(d.get("name", "")) for d in dirs if isinstance(d, dict)}
        lb_year = None
        for ev in ld.get("releasedEvent") or []:
            try:
                lb_year = int(str(ev.get("startDate"))[:4])
            except (TypeError, ValueError):
                pass
        dir_ok = bool(our_dirs & their_dirs)
        year_ok = bool(year and lb_year and abs(lb_year - year) <= 2)
        if not (dir_ok or year_ok):
            continue
        return Rating(
            source="Letterboxd",
            value=float(agg["ratingValue"]),
            count=int(agg.get("ratingCount") or 0),
            url=ld["_url"],
            scale=5,
            title=ld.get("name"),
            year=lb_year,
            directors=[d.get("name") for d in dirs if isinstance(d, dict)],
            genres=list(ld.get("genre") or []),
        )
    return None
