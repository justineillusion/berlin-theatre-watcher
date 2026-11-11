"""Chamäleon Berlin (calendrier réel du 2026-11-11, réduit à nov.–janv.)."""
from datetime import date
from pathlib import Path

import yaml

from src.language import detect, is_pure_language_note, to_english_labels
from src.main import venue_slug
from src.matching import select
from src.notify import credits_line, format_show
from src.parsers import SOURCES, chamaeleon as C
from src.summary import _EXTRACTORS, looks_like_consent, summary_from_html

F = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent
TODAY = date(2026, 11, 11)


def _shows():
    return C.parse((F / "chamaeleon_schedule.html").read_text(), TODAY)


def test_registered_in_config_and_sources():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    venue = [t for t in cfg["theaters"] if t.get("parser") == "chamaeleon"][0]
    assert venue["name"] == "Chamäleon Berlin" and venue.get("kind", "theatre") == "theatre"
    assert not venue.get("optional")
    assert venue_slug(venue["name"]) == "chamaleon-berlin"
    assert SOURCES["chamaeleon"] is C.collect and "Chamäleon Berlin" in _EXTRACTORS


def test_schedule_every_date():
    shows = _shows()
    titles = {s.title: sum(x.title == s.title for x in shows) for s in shows}
    # 66 Kintsugi au calendrier, dont 1 « Schulklassentag / Schools Day » écartée
    assert titles == {"Kintsugi": 65, "North of Now": 6, "New Year’s Eve at Chamäleon": 1}
    first = shows[0]
    assert (first.title, first.date, first.time, first.venue) == ("Kintsugi", "2026-11-11", "20:00", "Hackesche Höfe")
    assert first.url == "https://chamaeleonberlin.com/en/shows/kintsugi-berlin/"
    assert first.booking_url == "https://tickets.chamaeleonberlin.com/webshop/webticket/shop?event=7913&language=en"
    assert first.sold_out is False and first.has_english_surtitles
    assert first.languages == "by Machine de Cirque · No language needed (circus)"
    assert all(s.has_english_surtitles for s in shows)
    assert not any("Schools Day" in (s.languages or "") for s in shows)
    # date avec audiodescription en ligne « primaire » : compagnie reprise
    assert {s.languages for s in shows if s.title == "Kintsugi"} == {"by Machine de Cirque · No language needed (circus)"}
    assert [s for s in shows if s.title == "North of Now"][0].languages == "by Circa · No language needed (circus)"


def test_past_dates_dropped():
    assert all(s.date >= "2026-12-01" for s in C.parse((F / "chamaeleon_schedule.html").read_text(), date(2026, 12, 1)))


def test_sold_out_from_booking_text():
    html = (F / "chamaeleon_schedule.html").read_text()
    i = html.index("Schedule__ticketButton")
    j = html.index("</a>", i)
    start = html.rindex("<a ", 0, i)
    sold = html[:start] + '<span class="Schedule__status">Sold out</span>' + html[j + 4:]
    first = C.parse(sold, TODAY)[0]
    assert first.sold_out is True and first.booking_url is None


def test_page_language_field():
    assert C.page_language((F / "chamaeleon_kintsugi.html").read_text()) == "none"
    assert C.page_language((F / "chamaeleon_ten_thousand_hours.html").read_text()) == "few english dialogues"
    assert C.language_label("none") == (C.NO_LANGUAGE, True)
    assert C.language_label("few english dialogues") == (C.NO_LANGUAGE, True)
    assert C.language_label(None) == (C.NO_LANGUAGE, True)
    assert C.language_label("English") == ("In English", True)
    # pièce parlée en allemand : pas « accessible »
    assert C.language_label("German") == ("In German", False)
    assert C.language_label("Deutsch") == ("In German", False)


def test_german_spoken_piece_not_marked():
    show = C.apply_language(_shows()[0], "German")
    assert show.languages == "by Machine de Cirque · In German" and not show.has_english_surtitles
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    assert select([show], cfg) == []


def test_language_line_fr_en_and_card():
    shows = [C.apply_language(s, "none") for s in _shows()]
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    hits = select(shows, cfg)
    kin = [h for h in hits if h.title == "Kintsugi"][0]
    assert len(kin.available_iso) == 65
    spoken, titles = detect(kin.languages, "Language : none", kin.has_english_surtitles)
    assert (spoken, titles) == ("Aucune langue requise (cirque)", None)       # pas de faux « surtitres anglais »
    assert to_english_labels(spoken, titles) == ("No language needed (circus)", None)
    kin.spoken_language, kin.surtitles = spoken, titles
    fr, en = format_show(kin), format_show(kin, "en")
    assert "🗣 Aucune langue requise (cirque)" in fr and "✍️ De Machine de Cirque" in fr
    assert "🗣 No language needed (circus)" in en and "✍️ By Machine de Cirque" in en
    assert "No language needed" not in fr                                   # pas d'anglais sur la fiche FR
    assert "(+60 autres)" in fr
    # note sans compagnie (Réveillon) : pas de ligne ✍️ redondante
    assert is_pure_language_note(C.NO_LANGUAGE)
    assert credits_line("by Circa · No language needed (circus)") == "De Circa"


def test_synopsis_not_consent():
    for name, start in (("chamaeleon_kintsugi", "2026 sees one of Canada’s most exciting contemporary circus"),
                        ("chamaeleon_ten_thousand_hours", "When author Malcolm Gladwell said")):
        text = summary_from_html("Chamäleon Berlin", (F / f"{name}.html").read_text())
        assert text.startswith(start) and not looks_like_consent(text)
        assert "Age recommendation" not in text and "Language" not in text
