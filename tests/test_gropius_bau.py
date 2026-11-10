"""Gropius Bau : liste des expos, puis dates du JSON-LD de chaque page (pages réelles du 2026-11-10)."""
from pathlib import Path

from src.parsers.expos import gropius_bau_links, parse_gropius_bau

F = Path(__file__).parent / "fixtures"
BASE = "https://www.berlinerfestspiele.de/en/gropius-bau/ausstellungen/aktuell-und-vorschau"


def test_links():
    links = gropius_bau_links((F / "gropius_bau_list.html").read_text(), BASE)
    assert "https://www.berlinerfestspiele.de/en/gropius-bau/programm/2026/ausstellungen/christoph-schlingensief" in links
    assert all("/ausstellungen/" in l and "/programm/" in l for l in links)


def test_dated_exhibition():
    s = parse_gropius_bau((F / "gropius_bau_schlingensief.html").read_text(), "https://x/schlingensief")
    assert (s.title, s.date, s.end_date, s.kind) == ("Christoph Schlingensief", "2026-10-09", "2027-01-17", "expo")


def test_undated_announcement_skipped():
    assert parse_gropius_bau((F / "gropius_bau_holzinger.html").read_text(), "https://x/holzinger") is None


def test_title_entities_decoded():
    s = parse_gropius_bau((F / "gropius_bau_stoetzer.html").read_text(), "https://x/stoetzer")
    assert s.title == "Gabriele Stötzer: Dabei sein und nicht schweigen"
