"""Deutsches Theater et Sophiensæle : extraits réels des pages (18/11/2026)."""
from pathlib import Path

from src.parsers import deutsches_theater, sophiensaele

FX = Path(__file__).parent / "fixtures"


def test_deutsches_theater_surtitles_flag_and_sold_out():
    shows = deutsches_theater.parse((FX / "deutsches_theater_programme.html").read_text())
    by = {}
    for s in shows:
        by.setdefault(s.title, []).append(s)
    rosa = by["Rosa L."][0]
    assert rosa.date == "2026-11-18" and rosa.time == "19:30" and rosa.venue == "Kammer"
    assert rosa.has_english_surtitles and rosa.sold_out is True and rosa.booking_url is None
    assert "English surtitles" in rosa.languages
    polaris = by["Polaris"][0]
    assert polaris.has_english_surtitles and polaris.sold_out is False
    assert polaris.booking_url.startswith("https://ticket.deutschestheater.de/")
    assert polaris.url == "https://www.deutschestheater.de/en/program/productions/polaris"
    assert all(not s.has_english_surtitles for s in by["Fake Jews"])   # sans surtitres : écarté


def test_sophiensaele_language_from_production_page():
    lang, only = sophiensaele.language_of((FX / "sophiensaele_daniels_destruction.html").read_text())
    assert lang == "In German with English surtitles" and only is None


def test_sophiensaele_some_dates_only():
    page = '<aside id="stueck-sidebar"><ul><li>Festsaal</li><li>German</li></ul></aside>' \
           "<p>Note 27./28./29.11.: with English surtitles</p>"
    assert sophiensaele.language_of(page) == ("In German with English surtitles", {"27.11", "28.11", "29.11"})
    assert sophiensaele.language_of('<aside id="stueck-sidebar"><ul><li>German</li></ul></aside>') == (None, None)
    assert sophiensaele.language_of('<aside id="stueck-sidebar"><ul><li>No language skills needed, English</li></ul></aside>')[0] \
        == "No language needed"


def test_sophiensaele_parse_listing():
    home = (FX / "sophiensaele_home.html").read_text()
    dd = "https://sophiensaele.com/en/stueck/daniels-destruction"
    sl = "https://sophiensaele.com/en/stueck/schwarze-leute-reclaiming-memories"
    shows = sophiensaele.parse(home, {dd: ("In German with English surtitles", None),
                                      sl: ("In German with English surtitles", {"27.11", "28.11", "29.11"})})
    d = [s for s in shows if s.url == dd]
    assert d and all(s.has_english_surtitles for s in d)
    assert d[0].date == "2026-11-19" and d[0].time == "19:00" and d[0].venue == "Kantine"
    assert d[0].booking_url and "reservix" in d[0].booking_url
    s = {x.date: x.has_english_surtitles for x in shows if x.url == sl}
    assert s.get("2026-11-25") is False and s.get("2026-11-27") is True
