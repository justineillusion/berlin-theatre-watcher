"""Régressions trouvées par la QA (scripts/qa.py) — 18/11/2026."""
from datetime import datetime
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from src.cinema import taste
from src.cinema.models import Film, Screening
from src.notify import credits_line
from src.parsers import concerts
from src.summary import _urban_spree

TZ = ZoneInfo("Europe/Berlin")


def test_credits_no_half_translation():
    assert credits_line("a project by Jan-Christoph Gockel") == "Un projet de Jan-Christoph Gockel"
    assert credits_line("based on the novella by Heinrich von Kleist directed by Ildikó Gáspár") == \
        "D'après la nouvelle de Heinrich von Kleist mis en scène par Ildikó Gáspár"
    assert credits_line("A play by Friedrich Schiller directed by Claudia Bossard") == \
        "Une pièce de Friedrich Schiller mis en scène par Claudia Bossard"
    assert "traduit de l'anglais par Hanns Zischler" in credits_line(
        "Based on the graphic novel by Ken Krimstein translated from English by Hanns Zischler")
    assert credits_line("von Bertolt Brecht") == "De Bertolt Brecht"
    assert credits_line("By Oscar Wilde") == "D'Oscar Wilde"
    assert credits_line("based on the novella by Heinrich von Kleist", "en") == "based on the novella by Heinrich von Kleist"


def test_urban_spree_genres_and_parties():
    assert concerts.us_genres("their own blend of punk and extatic noise-rock, from the DIY hardcore scene") == \
        ["punk", "noise-rock", "hardcore"]
    assert concerts.us_genres("a dreamy indie pop record") == ["indie pop"]
    card = {"url": "https://www.urbanspree.com/program/concerts/x.html", "date": "2030-01-01", "time": "20:00",
            "title": "Process Party x Effetto Notte"}
    assert concerts.parse_urban_spree_event(None, card) is None


def test_urban_spree_synopsis():
    html = "<html><body><h1>Coilguns</h1><div>About the Concert Coilguns 05.12.2026, Berlin Einlass: 19:00 Beginn: 20:00 " \
           "Initially coming from the DIY hardcore scene, Coilguns have crafted their own blend of punk.</div>" \
           "<div>View_all Concerts</div></body></html>"
    assert _urban_spree(BeautifulSoup(html, "html.parser")).startswith("Initially coming from the DIY hardcore scene")


def _film(version, lang=None, countries=()):
    s = Screening(cinema="Kino International", start=datetime(2030, 1, 4, 20, 0, tzinfo=TZ), title="Die Venus von Paris",
                  version=version, original_language=lang, countries=list(countries))
    return Film(key="venus", screenings=[s])


def test_omu_only_for_english_originals():
    # La Vénus électrique (FR, sous-titres allemands seulement) : pas pour un·e anglophone
    assert taste.version_filter(_film("OmU", "fr"), {}) is not None
    assert taste.version_filter(_film("OmU", countries=["Frankreich"]), {}) is not None
    assert taste.version_filter(_film("OmU", "en"), {}) is None
    assert taste.version_filter(_film("OmeU", "fr"), {}) is None
    assert taste.version_filter(_film("OV", "en"), {}) is None


def test_german_film_without_english_subtitles_is_dropped():
    from datetime import datetime
    from src.cinema.models import Film, Screening
    from src.cinema.taste import version_filter
    mk = lambda v: Screening(cinema="FaF", start=datetime(2026, 11, 20, 18), title="Heimsuchung", version=v,
                             countries=["Deutschland"], original_language="de")
    assert version_filter(Film(key="h", screenings=[mk("DF")]), {}) is not None
    f = Film(key="h", screenings=[mk("DF"), mk("OmeU")])
    assert version_filter(f, {}) is None and [s.version for s in f.screenings] == ["OmeU"]


def test_same_cinema_same_time_listed_once():
    from datetime import datetime
    from src.cinema.main import group
    from src.cinema.models import Screening
    t = datetime(2026, 11, 23, 20)
    f = group([Screening(cinema="Intimes", start=t, title="You Can See Everything", booking_url=u) for u in ("a", "b")])
    assert len(f) == 1 and len(f[0].screenings) == 1
