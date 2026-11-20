from datetime import date
from pathlib import Path

from src.parsers.acud import language, parse_list

FIX = Path(__file__).parent / "fixtures"


def test_list_skips_workshops_and_reads_dates():
    rows = parse_list((FIX / "acud_home.html").read_text(), today=date(2026, 11, 20))
    titles = [r["title"] for r in rows]
    assert "Tragödienbastard" in titles
    assert not any("Clown-Training" in t or "Training" in t for t in titles)
    trag = next(r for r in rows if r["title"] == "Tragödienbastard")
    assert trag["dates"][0] == ("2026-11-25", "20:00") and len(trag["dates"]) == 4
    assert all(r["url"].startswith("https://www.acud-theater.de/programm/") for r in rows)


def test_year_rolls_over_in_december():
    from src.parsers.acud import _dates
    assert _dates(["Sa 09.01., 20:00"], date(2026, 12, 1)) == [("2027-01-09", "20:00")]


def test_language_rules():
    assert language("Sprache der Vorstellung: Spanisch / Español") == ("In Spanish", False)
    assert language("The show is in English from a cast that reflects Berlin") == ("In English", True)
    assert language("", "Improvisationstheater auf Englisch") == ("In English", True)
    assert language("Die Vorstellung ist nonverbal") == ("Without words", True)
    # « (Show in English) » accolé à une soirée passée : ne suffit pas
    assert language("8.11.26, 19:30 Uhr ESIMPROFEST 26 Waiting for Bob & Friends (Show in English) SHOWS DE IMPROVISACIÓN") == (None, False)
    assert language("Eine Komödie über drei Damen") == (None, False)
