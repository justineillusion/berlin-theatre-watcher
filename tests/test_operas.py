"""Staatsoper, Deutsche Oper, Komische Oper (pages réelles du 2026-11-10)."""
import json
from pathlib import Path

import yaml

from src.main import venue_slug
from src.matching import select
from src.parsers import SOURCES
from src.parsers.opera import (
    deutsche_oper_language,
    komische_oper_months,
    parse_deutsche_oper,
    parse_komische_oper,
    parse_staatsoper,
    staatsoper_links,
)

F = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent


def _read(name):
    return (F / name).read_text()


# --- Staatsoper -------------------------------------------------------------
def test_staatsoper_links():
    links = staatsoper_links(_read("staatsoper_operas.html"))
    assert len(links) == 32
    assert "https://www.staatsoper-berlin.de/en/veranstaltungen/orfeo-ed-euridice.27753/" in links
    assert all("/en/veranstaltungen/" in l for l in links)


def test_staatsoper_dates_and_surtitles():
    shows = parse_staatsoper(_read("staatsoper_orfeo.html"), "https://x/orfeo")
    assert [(s.date, s.time) for s in shows] == [("2026-11-12", "19:30"), ("2026-11-14", "19:30")]
    s = shows[0]
    assert (s.title, s.has_english_surtitles, s.sold_out) == ("Orfeo ed Euridice", True, False)
    assert s.languages == "In Italian Language with German and English surtitles"   # « Englisch » corrigé
    assert s.production_type == "Music by Christoph Willibald Gluck"
    assert s.booking_url.startswith("https://tickets.staatsoper-berlin.de/")


def test_staatsoper_sold_out():
    shows = parse_staatsoper(_read("staatsoper_tristan.html"), "https://x/tristan")
    assert len(shows) == 3 and all(s.sold_out is True and s.has_english_surtitles for s in shows)


def test_staatsoper_school_performance_skipped():
    shows = parse_staatsoper(_read("staatsoper_zauberfloete.html"), "https://x/zf")
    days = [s.date for s in shows]
    assert len(shows) == 12 and "2026-12-01" not in days          # 11:00 scolaire
    assert ("2026-12-26", "14:00") in [(s.date, s.time) for s in shows]


def test_staatsoper_german_only_not_english():
    shows = parse_staatsoper(_read("staatsoper_fledermaus_kinder.html"), "https://x/fk")
    assert shows and not any(s.has_english_surtitles for s in shows)


# --- Deutsche Oper ----------------------------------------------------------
BOHEME = "https://deutscheoperberlin.de/en_EN/production/la-boheme.1385732"


def test_deutsche_oper_language():
    assert deutsche_oper_language(_read("deutsche_oper_la_boheme.html")) == \
        "In Italian with German and English surtitles"
    assert deutsche_oper_language(_read("deutsche_oper_hamed_sherifa.html")) == "In German"


def test_deutsche_oper_events():
    events = json.loads(_read("deutsche_oper_events_p1.json"))["EventOverview"]
    langs = {BOHEME: deutsche_oper_language(_read("deutsche_oper_la_boheme.html"))}
    shows = parse_deutsche_oper(events, langs)
    assert len(shows) == 20 and len({s.title for s in shows}) == 7
    first = shows[0]
    assert (first.title, first.date, first.time, first.venue) == ("Queen of Spades", "2026-11-13", "18:00", "Main stage")
    assert first.url == "https://deutscheoperberlin.de/en_EN/production/queen-of-spades.1385561"
    assert first.has_english_surtitles is False                 # langue inconnue -> pas retenu
    boheme = [s for s in shows if s.url == BOHEME]
    assert [(s.date, s.time) for s in boheme] == [
        ("2026-12-11", "19:00"), ("2026-12-13", "16:00"), ("2026-12-15", "19:30")]
    assert all(s.has_english_surtitles and s.sold_out is False for s in boheme)


# --- Komische Oper ----------------------------------------------------------
KO = "https://www.komische-oper-berlin.de/en/what/schedule/"


def test_komische_oper_months():
    months = komische_oper_months(_read("komische_oper_schedule.html"), KO)
    assert months[0] == KO + "2027-01/" and months[-1] == KO + "2027-07/" and len(months) == 7


def test_komische_oper_schedule():
    shows = parse_komische_oper(_read("komische_oper_schedule.html"), KO)
    titles = {s.title for s in shows}
    assert titles == {"Orpheus in the Underworld", "Madama Butterfly", "Eugene Onegin",
                      "Hansel and Gretel", "Treading the boards"}         # sans visites / jeune public / concerts
    assert len(shows) == 28 and all(s.has_english_surtitles for s in shows)
    onegin = [s for s in shows if s.title == "Eugene Onegin"][0]
    assert (onegin.date, onegin.time) == ("2026-11-14", "19:30")
    assert onegin.url == "https://www.komische-oper-berlin.de/en/what/a-z/eugene-onegin/"
    assert onegin.production_type == "Pyotr Tchaikovsky"
    sold = [(s.title, s.date) for s in shows if s.sold_out]
    assert sold == [("Orpheus in the Underworld", "2026-12-04")]


def test_komische_oper_foyer_skipped():
    shows = parse_komische_oper(_read("komische_oper_2027-01.html"), KO)
    assert "The eternal circle" not in {s.title for s in shows}
    assert sum(s.title == "Echnaton (Akhnaten)" for s in shows) == 7


def test_komische_oper_month_pages_link_to_the_production():
    # /en/what/schedule/2027-01/madama-butterfly/1396/ -> /en/what/a-z/madama-butterfly/
    shows = parse_komische_oper(_read("komische_oper_2027-01.html"), KO)
    assert shows and all("/a-z/" in s.url for s in shows), {s.url for s in shows if "/a-z/" not in s.url}


def test_press_aliases():
    from src.parsers.opera import press_aliases
    assert press_aliases("The Flying Dutchman") == ["Der fliegende Holländer"]
    assert press_aliases("Queen of Spades", "Pique Dame") == ["Pique Dame"]
    assert press_aliases("Tosca", "Tosca") == []
    events = json.loads(_read("deutsche_oper_events_p1.json"))["EventOverview"]
    dutch = [s for s in parse_deutsche_oper(events, {}) if s.title == "The Flying Dutchman"][0]
    assert dutch.aliases == ["Der fliegende Holländer"]


def test_grouped_per_production():
    shows = parse_komische_oper(_read("komische_oper_schedule.html"), KO)
    hits = select(shows, {})
    butterfly = [h for h in hits if h.title == "Madama Butterfly"][0]
    assert len(butterfly.available_iso) == 7 and butterfly.available_iso[0] == "2026-11-21 19:00"


# --- config -----------------------------------------------------------------
def test_config_optional_venues():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    new = {t["name"]: t for t in cfg["theaters"] if t.get("optional")}
    assert {venue_slug(n) for n in new} == {
        "staatsoper-unter-den-linden", "deutsche-oper-berlin", "komische-oper-berlin", "berliner-philharmoniker"}
    assert all(t["parser"] in SOURCES and t.get("kind", "theatre") == "theatre" for t in new.values())
