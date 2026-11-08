"""Source générique kinoheld (API GraphQL publique de next-live.kinoheld.de).

Beaucoup de cinémas berlinois vendent leurs billets via kinoheld et
l'intègrent en iframe (« eframe ») sur leur site : c'est le cas du Kino Intimes,
dont le site n'affiche AUCUN horaire en HTML. L'API GraphQL qui alimente
kinoheld.de est ouverte (pas de clé, introspection autorisée) :

    shows(cinemaId, dates: [≤ 3 dates], limit) {
      beginning, flags{code}, subtitleLanguage{isocode},
      movie { title, titleOriginal, released, directors, genres,
              productionCountries, originalLanguage, description }
    }

Flags de langue observés : ``subtitled`` (+ subtitleLanguage de/en),
``omeu``, ``original``, ``deutsch`` (= version allemande), ``family``.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import List

from ..http import post_json
from ..models import Screening
from ..version import parse_version

_API = "https://next-live.kinoheld.de/graphql"
_HEADERS = {"Origin": "https://www.kinoheld.de", "Content-Type": "application/json"}

_QUERY = """
query($c: ID, $d: [Date!]) {
  shows(cinemaId: $c, dates: $d, limit: 500) {
    data {
      id name beginning
      flags { code category }
      subtitleLanguage { isocode }
      audioLanguage { isocode }
      movie {
        title titleOriginal released productionYear urlSlug
        directors { name } genres { name } productionCountries { name }
        originalLanguage { isocode } shortDescription description
      }
    }
  }
}
"""


def _version(show: dict, unmarked_default: str | None) -> str | None:
    codes = {(f.get("code") or "").lower() for f in show.get("flags") or []}
    sub = ((show.get("subtitleLanguage") or {}).get("isocode") or "").lower()
    if "omeu" in codes or ("subtitled" in codes and sub == "en"):
        return "OmeU"
    if "omu" in codes or "omdu" in codes or ("subtitled" in codes and sub in ("de", "")):
        return "OmU"
    if "original" in codes or "ov" in codes:
        return "OV"
    if "deutsch" in codes:
        return "DF"
    return parse_version(show.get("name")) or unmarked_default


def fetch(cfg: dict, start: date, days: int) -> List[Screening]:
    cinema_id = str(cfg["kinoheld_cinema_id"])
    slug = cfg.get("kinoheld_slug")
    city = cfg.get("kinoheld_city", "berlin")
    unmarked = cfg.get("unmarked_version")
    all_dates = [(start + timedelta(days=i)).isoformat() for i in range(days)]

    out: List[Screening] = []
    for i in range(0, len(all_dates), 3):          # l'API refuse > 3 dates par requête
        data = post_json(_API, {"query": _QUERY, "variables": {"c": cinema_id, "d": all_dates[i:i + 3]}},
                         headers=_HEADERS)
        if data.get("errors"):
            raise RuntimeError(f"kinoheld: {data['errors'][0].get('message')}")
        for show in data["data"]["shows"]["data"]:
            movie = show.get("movie") or {}
            released = movie.get("released") or ""
            year = movie.get("productionYear") or (released[:4] if released else None)
            booking = (f"https://www.kinoheld.de/kino/{city}/{slug}/vorstellung/{show['id']}" if slug else None)
            orig = movie.get("titleOriginal")
            out.append(Screening(
                cinema=cfg["name"],
                start=datetime.fromisoformat(show["beginning"]),
                title=(movie.get("title") or show.get("name") or "").strip(),
                url=cfg.get("film_url") or booking,
                booking_url=booking,
                version=_version(show, unmarked),
                original_title=orig.strip() if orig else None,
                alt_titles=[show.get("name") or ""],
                year=int(year) if year and str(year).isdigit() else None,
                directors=[d["name"] for d in movie.get("directors") or []],
                countries=[c["name"] for c in movie.get("productionCountries") or []],
                original_language=(movie.get("originalLanguage") or {}).get("isocode"),
                genres=[g["name"] for g in movie.get("genres") or []],
                description=movie.get("shortDescription") or movie.get("description"),
                tags=[f.get("code") or "" for f in show.get("flags") or []],
            ))
    return out
