"""Maxim Gorki Theater et HAU Hebbel am Ufer (pages réelles du 2026-11-11)."""
import json
from datetime import date
from pathlib import Path

import yaml
from bs4 import BeautifulSoup

from src.language import detect
from src.main import venue_slug
from src.matching import select
from src.parsers import SOURCES, gorki, hau
from src.summary import _EXTRACTORS, is_synopsis

F = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent
HAU = "https://www.hebbel-am-ufer.de/en/programme/schedule-tickets/"
TODAY = date(2026, 11, 11)


def _read(name):
    return (F / name).read_text()


# --- Gorki ------------------------------------------------------------------
def _gorki():
    langs = gorki.project_languages(json.loads(_read("gorki_projects.json")))
    return gorki.parse(_read("gorki_schedule.html"), langs)


def test_gorki_language_normalized():
    assert gorki.normalize_language("Deutsch + eng. ÜT") == "In German, with English surtitles"
    assert gorki.normalize_language("Türkisch mit dt. und engl. Übertiteln") == \
        "In Turkish, with German and English surtitles"
    assert gorki.normalize_language("In English") == "In English"
    assert gorki.normalize_language(None) is None


def test_gorki_project_languages_both_slugs():
    langs = gorki.project_languages(json.loads(_read("gorki_projects.json")))
    # langue saisie seulement en allemand, mais retrouvée depuis le slug anglais
    assert langs["the-hearing-trumpet"] == ("The Hearing Trumpet", "In German, with English surtitles")
    assert langs["das-hoerrohr"] == langs["the-hearing-trumpet"]
    assert langs["bam-bam-bam"][1] is None


def test_gorki_schedule():
    shows = _gorki()
    assert len(shows) == 59 and sum(s.has_english_surtitles for s in shows) == 13
    first = shows[0]
    assert first.date == "2026-11-11" and first.time == "13:00"
    assert first.url == "https://www.gorki.de/en/in-the-corpse-of-the-present-prinz-friedrich-von-homburg-2"
    bam = [s for s in shows if s.title.startswith("BAM BAM BAM")][0]
    assert (bam.date, bam.time, bam.venue, bam.sold_out) == ("2026-12-04", "19:30", "Stage", False)
    assert bam.booking_url == "https://tickets.gorki.de/eventim.webshop/webticket/shop?event=14240"
    assert bam.languages == "Imran Ayata, Daniel Richter" and not bam.has_english_surtitles


def test_gorki_surtitles_per_production_not_exhibition():
    shows = _gorki()
    trumpet = [s for s in shows if s.title == "The Hearing Trumpet"]
    assert len(trumpet) == 11 and all(s.has_english_surtitles for s in trumpet)
    assert trumpet[0].languages == "Ulrike Ottinger · In German, with English surtitles"
    # l'expo rattachée à la même production n'est pas « surtitrée »
    expo = [s for s in shows if s.title == "Ottinger - Exhibition"]
    assert expo and not any(s.has_english_surtitles for s in expo)
    # premiere : le badge « Premiere » ne pollue pas le titre ; 1re date complète
    assert ("2026-12-03", True) == (trumpet[0].date, trumpet[0].sold_out)
    assert detect(trumpet[0].languages, None, True) == (None, "surtitres anglais")


def test_gorki_in_english_events():
    shows = _gorki()
    en = {s.title for s in shows if s.has_english_surtitles and s.title != "The Hearing Trumpet"}
    assert en == {"Noise as a Strategy — English Workshop",
                  "Çağla Ilk in conversation with Marco Fusinato (in English)"}
    german_ws = [s for s in shows if s.title == "Noise as a Strategy — German Workshop"]
    assert german_ws and not any(s.has_english_surtitles for s in german_ws)


def test_gorki_select_groups_and_drops_sold_out():
    hits = {h.title: h for h in select(_gorki(), {})}
    trumpet = hits["The Hearing Trumpet"]
    assert trumpet.available_iso[0] == "2026-12-05 19:30" and len(trumpet.available_iso) == 10


def test_gorki_synopsis():
    soup = BeautifulSoup(_read("gorki_the_hearing_trumpet.html"), "html.parser")
    text = _EXTRACTORS["Maxim Gorki Theater"](soup)
    assert text.startswith("Everyone who has read Leonora Carrington’s century-defining novel")
    assert is_synopsis(text) and "cookie" not in text.lower()


# --- HAU --------------------------------------------------------------------
def _hau_nov(prices=None):
    if prices is None:
        prices = hau.parse_prices(_read("hau_prices_2026-11.html"))
    return hau.parse(_read("hau_schedule_2026-11.html"), prices, today=TODAY)


def test_hau_months_and_price_url():
    html = _read("hau_schedule_2026-11.html")
    assert hau.month_urls(html, HAU, today=TODAY) == [HAU + "prodMonth/12-2026/", HAU + "prodMonth/01-2027/"]
    assert "ajaxPriceButtons" in hau.price_url(html)


def test_hau_language_labels():
    assert hau.normalize_languages(["English phonetic language", "with German and English surtitles"]) == \
        "In English, with German and English surtitles"
    assert hau.normalize_languages(["Persian with German and English surtitles"]) == \
        "In Persian, with German and English surtitles"
    assert hau.normalize_languages(["Polish spoken language with German surtitles"]) == \
        "In Polish, with German surtitles"
    assert hau.normalize_languages(["German", "English surtitles"]) == "In German, with English surtitles"
    assert hau.normalize_languages(["German", "English"]) == "In German and English"
    assert hau.normalize_languages([]) is None


def test_hau_november():
    shows = _hau_nov()
    assert len(shows) == 20 and all(s.date >= "2026-11-11" for s in shows)   # jours passés écartés
    assert sum(s.has_english_surtitles for s in shows) == 8
    exxy = [s for s in shows if s.title == "EXXY"]
    assert [(s.date, s.time, s.venue) for s in exxy] == [("2026-11-11", "20:00", "HAU2"), ("2026-11-12", "19:00", "HAU2")]
    assert exxy[0].url == "https://www.hebbel-am-ufer.de/en/programme/pdetail/dan-daw-creative-projects-exxy/"
    assert exxy[0].languages == "Dan Daw Creative Projects · In English, with German and English surtitles"
    assert exxy[0].production_type == "Performance / Dance"
    assert exxy[1].booking_url == "https://shop.hebbel-am-ufer.de/en/buyingflow/tickets/17551/44650/"
    assert all(s.sold_out is False for s in shows)
    amoroso = [s for s in shows if s.title == "Amoroso"][0]
    assert amoroso.languages == "Teatr Klucz · In Polish, with German surtitles"
    assert not amoroso.has_english_surtitles


def test_hau_in_english_without_surtitles_counts():
    shows = _hau_nov()
    tool = [s for s in shows if s.title == "Tool-Party #4: Synthetic Desire"][0]
    assert tool.has_english_surtitles and tool.languages == "Anan Fries · In English"
    assert detect(tool.languages, None, tool.has_english_surtitles) == ("En anglais", None)


def test_hau_sold_out_from_price_buttons():
    prices = hau.parse_prices(_read("hau_prices_2026-11.html"))
    prices["d-15621"] = ("Sold out", None)
    exxy = [s for s in _hau_nov(prices) if s.title == "EXXY"]
    assert [s.sold_out for s in exxy] == [False, True]
    hits = {h.title: h for h in select(_hau_nov(prices), {})}
    assert hits["EXXY"].available_iso == ["2026-11-11 20:00"]
    # sans réponse AJAX : statut inconnu (on notifie quand même)
    assert all(s.sold_out is None for s in _hau_nov({}))


def test_hau_december():
    shows = hau.parse(_read("hau_schedule_2026-12.html"), {}, today=TODAY)
    assert len(shows) == 25 and sum(s.has_english_surtitles for s in shows) == 10
    revue = [s for s in shows if s.title == "Die große Klassenrevue"]
    assert len(revue) == 3 and revue[0].languages == "Christiane Rösinger / HAU · In German, with English surtitles"
    kids = [s for s in shows if s.title == "KIDS"][0]
    assert kids.has_english_surtitles and kids.languages.endswith("In English, with German subtitles")
    german = [s for s in shows if s.title == "Nocturne Catalyst"]
    assert german and not any(s.has_english_surtitles for s in german)


def test_hau_synopsis():
    soup = BeautifulSoup(_read("hau_exxy.html"), "html.parser")
    text = _EXTRACTORS["HAU Hebbel am Ufer"](soup)
    assert text.startswith("How can you value yourself when society doesn’t?")
    assert is_synopsis(text) and "privacy policy" not in text.lower()


# --- config -----------------------------------------------------------------
def test_config_gorki_hau():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    venues = {venue_slug(t["name"]): t for t in cfg["theaters"]}
    for slug, parser in (("maxim-gorki-theater", "gorki"), ("hau-hebbel-am-ufer", "hau")):
        t = venues[slug]
        assert t["parser"] == parser and t["parser"] in SOURCES
        assert not t.get("optional") and t.get("kind", "theatre") == "theatre"
