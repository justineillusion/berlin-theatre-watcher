"""Berliner Festspiele : un seul lieu pour tous les programmes (page réelle du 2026-11-11)."""
from pathlib import Path

import yaml

from src.main import venue_slug
from src.parsers import festspiele as F

FIX = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent


def test_one_venue_for_all_programmes():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    fs = [t for t in cfg["theaters"] if t["parser"] == "festspiele"]
    assert len(fs) == 1 and venue_slug(fs[0]["name"]) == "berliner-festspiele"
    assert F.sitemap_urls(fs[0]["url"]) == [
        "https://www.berlinerfestspiele.de/sitemap.xml?type=pages&nodePath=performing-arts-season",
        "https://www.berlinerfestspiele.de/sitemap.xml?type=pages&nodePath=theatertreffen",
    ]


def test_single_programme_url_unchanged():
    u = "https://www.berlinerfestspiele.de/sitemap.xml?type=pages&nodePath=theatertreffen"
    assert F.sitemap_urls(u) == [u]


def test_event_pages_dedup_and_year():
    sm = ("<urlset><url><loc>https://x/en/theatertreffen/programm/2026/spielplan/a</loc></url>"
          "<url><loc>https://x/en/theatertreffen/programm/2026/spielplan/a</loc></url>"
          "<url><loc>https://x/en/theatertreffen/programm/2024/spielplan/old</loc></url>"
          "<url><loc>https://x/en/theatertreffen/programm/2026/spielplan/a/besetzung</loc></url></urlset>")
    assert F.event_pages(sm, 2025) == ["https://x/en/theatertreffen/programm/2026/spielplan/a"]


def test_app_router_page_metadata():
    # Plus de __NEXT_DATA__ : les données sont dans le flux RSC (self.__next_f.push).
    raw = (FIX / "festspiele_mami.html").read_text()
    meta = F._event_meta(raw)
    assert meta.get("form") == "Theatre"
    assert meta.get("audioLanguages") == ["independent"]
    assert F._languages(meta) == ("No spoken word", True)
    assert len(F._json_ld_events(raw)) == 2
