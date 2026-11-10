"""Berliner Philharmoniker : abonnements -> séries -> pages concert (pages réelles du 2026-11-10)."""
from pathlib import Path

from src.parsers.philharmonie import category_links, concert_links, parse_concert, series_links

F = Path(__file__).parent / "fixtures"
B = "https://www.berliner-philharmoniker.de"


def _read(name):
    return (F / name).read_text()


def test_discovery_chain():
    cats = category_links(_read("philharmoniker_subscriptions.html"))
    assert cats == [
        f"{B}/en/concerts/subscriptions-and-flex-packages/symphonic-subscriptions/2026-27/",
        f"{B}/en/concerts/subscriptions-and-flex-packages/chamber-music-jazz-world/2026-27/",
    ]
    series = series_links(_read("philharmoniker_symphonic.html"))
    assert len(series) == 13 and series[0].endswith("/2026-27/series-a/")
    concerts = concert_links(_read("philharmoniker_series_a.html"))
    assert concerts[:2] == [f"{B}/en/concert/calendar/57060/", f"{B}/en/concert/calendar/57079/"]
    assert len(concerts) == 5


def test_concert_all_dates():
    # JSON-LD de cette page invalide (virgule en trop) : titre lu quand même.
    shows = parse_concert(_read("philharmoniker_57079.html"), f"{B}/en/concert/calendar/57079/")
    assert [(s.date, s.time) for s in shows] == [
        ("2026-12-17", "20:00"), ("2026-12-18", "20:00"), ("2026-12-19", "19:00")]
    s = shows[0]
    assert s.title == "Maxime Pascal makes his debut with Berlioz’s “L’Enfance du Christ”"
    assert (s.venue, s.kind, s.production_type, s.has_english_surtitles, s.sold_out) == \
        ("Main Auditorium", "theatre", "Concert", True, None)
    assert s.languages.startswith("Berliner Philharmoniker, Maxime Pascal (conductor)")


def test_chamber_hall_guest_ensemble():
    shows = parse_concert(_read("philharmoniker_57086.html"), "u")
    assert [(s.title, s.date, s.venue) for s in shows] == [
        ("Lisa Batiashvili, Robin Ticciati and the Chamber Orchestra of Europe", "2027-01-12", "Chamber Music Hall")]
