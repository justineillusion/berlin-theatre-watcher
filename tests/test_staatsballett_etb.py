"""Staatsballett Berlin + English Theatre Berlin (pages réelles du 2026-11-18, réduites)."""
from pathlib import Path

import yaml

from src.language import detect, to_english_labels
from src.matching import select
from src.parsers import SOURCES, english_theatre as ET, staatsballett as SB

F = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent


def test_registered_in_config_and_sources():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    by = {t.get("parser"): t for t in cfg["theaters"]}
    assert by["staatsballett"]["optional"] is True and by["staatsballett"]["name"] == "Staatsballett Berlin"
    assert not by["english_theatre"].get("optional")
    assert SOURCES["staatsballett"] is SB.collect and SOURCES["english_theatre"] is ET.collect


def test_staatsballett_performances_only():
    shows = SB.parse((F / "staatsballett_schedule.html").read_text())
    titles = {s.title for s in shows}
    assert "The Nutcracker" in titles and "2 Chapters Love" in titles
    # cours, ateliers, rencontres : écartés
    assert not any(t for t in titles if "Talk" in t or "TanzTanz" in t or "Never too late" in t)
    first = [s for s in shows if s.title == "The Nutcracker"][0]
    assert (first.date, first.time, first.venue) == ("2026-11-27", "19:30", "Deutsche Oper Berlin")
    assert first.sold_out is True and first.booking_url is None
    assert first.url.endswith("/der-nussknacker-en/348.html")
    free = [s for s in shows if s.sold_out is False]
    assert free and all("eventim" in s.booking_url for s in free)
    assert all(s.has_english_surtitles for s in shows)


def test_dance_language_label():
    s = SB.parse((F / "staatsballett_schedule.html").read_text())[0]
    spoken = detect(s.languages, None, True)
    assert spoken == ("Aucune langue requise (danse)", None)
    assert to_english_labels(*spoken)[0] == "No language needed (dance)"


def test_english_theatre():
    shows = ET.parse((F / "etberlin_calendar.html").read_text())
    rain = [s for s in shows if s.title.startswith("It")]
    assert rain and (rain[0].date, rain[0].time, rain[0].venue) == ("2026-11-28", "20:00", "Main Stage")
    assert rain[0].booking_url.startswith("https://www.eventbrite") and rain[0].sold_out is False
    assert detect(rain[0].languages, None, True)[0] == "En anglais"
    sick = [s for s in shows if s.title == "Sick and Tired"]
    assert sick and "In English and German" in sick[0].languages     # « bilingual cabaret »
    cfg = {"keywords_avoid": ["Kinder", "Führung"]}
    assert len(select(shows, cfg)) == 2
