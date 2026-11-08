"""Tests hors-ligne du buzz presse (aucun appel réseau).

    ./.venv/bin/python -m tests.test_press      (ou pytest si installé)
"""
from __future__ import annotations

import json
import tempfile
from datetime import date
from pathlib import Path

from src import press

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>X</title>
<item><title>Ruin and Rush in der Neuen Nationalgalerie</title>
<link>https://example.org/kultur/ruin-and-rush</link>
<pubDate>Tue, 04 Nov 2026 10:00:00 +0100</pubDate>
<description>&lt;p&gt;Die Ausstellung ist klein, aber sehr lohnend.&lt;/p&gt;</description></item>
<item><title>Neue Nationalgalerie erhält Schenkung</title>
<link>https://example.org/kultur/schenkung</link>
<pubDate>Mon, 03 Nov 2026 10:00:00 +0100</pubDate>
<description>Nachrichten.</description></item>
</channel></rss>"""

BERLINER_LIST = """
<h3>THROUGH NOV 14</h3><h3>Susan Hiller: Bad Dreams</h3><p>KW Institute for Contemporary Art, Mitte</p>
<h3>Shilpa Gupta&#8217;s What Still Holds</h3><p>Hamburger Bahnhof</p>
<h3>Lovis Corinth: Dann kam Berlin!</h3><p>Berlinische Galerie</p>
"""
HITS_MISSES = """
<h2>The Hits:</h2><h3>Projections Onto the East</h3><p>...</p>
<h2>The Misses:</h2><h3>Night: Maurizio Cattelan</h3><p>Neue Nationalgalerie ...</p>
"""


def _cache(articles) -> Path:
    tmp = Path(tempfile.mkdtemp()) / "press_cache.json"
    tmp.write_text(json.dumps({"articles": articles, "sources": {}, "searches": {}}))
    return tmp


def test_parse_stars():
    assert press.parse_stars("reviews ‘Next Door’ at the Hamburger Bahnhof (2.5 out of 5 stars).") == 2.5
    assert press.parse_stars("by Martin Finnland (three and a half stars)") == 3.5
    assert press.parse_stars("(four stars).") == 4
    assert press.parse_stars("no rating here") is None


def test_feed_and_lexicon_verdict():
    arts = press.parse_feed(RSS, "Jüdische Allgemeine")
    assert len(arts) == 2 and arts[0]["date"] == "2026-11-04"
    assert "lohnend" in arts[0]["dek"]
    path = _cache(arts)
    b = press.press_for("expo", "Neue Nationalgalerie", "Ruin and Rush",
                        "https://www.smb.museum/en/.../ruin-and-rush/", cache_path=path, use_nachtkritik=False)
    assert b["status"] == "verdict" and b["key"] == "positive", b
    assert b["example"]["text"].startswith("Die Ausstellung ist klein, aber sehr lohnend")
    line = press.format_buzz(b, "en")
    assert line.startswith("📰 Buzz: 👍 positive (1 source)") and "http" not in line
    assert press.format_buzz(b, "fr").startswith("📰 Buzz : 👍 plutôt positif (1 source)")


def test_stars_mixed_and_list_pick_and_misses():
    arts = [
        press._article(press.BERLINER, "https://www.the-berliner.com/art/review-next-door-hamburger-bahnhof/",
                       "2026-11-06", "“A pleasant enough celebration.”",
                       "Art editor reviews ‘Next Door’ at the Hamburger Bahnhof (2.5 out of 5 stars).",
                       subjects=["Next Door"], origin="rest"),
        press._article(press.BERLINER, "https://www.the-berliner.com/art/berlin-exhibitions-whats-on-now/",
                       "2026-10-07", "Berlin Art: What Exhibitions Are On Now?",
                       entries=press._list_entries(BERLINER_LIST), origin="rest"),
        press._article(press.BERLINER, "https://www.the-berliner.com/art/berlin-art-week-reviews-2026/",
                       "2026-09-24", "Reviews of Berlin Art Week 2026",
                       entries=press._list_entries(HITS_MISSES), origin="rest"),
    ]
    path = _cache(arts)
    nd = press.press_for("expo", "Hamburger Bahnhof", "Next Door", cache_path=path, use_nachtkritik=False)
    assert nd["key"] == "mixed", nd
    sg = press.press_for("expo", "Hamburger Bahnhof", "Shilpa Gupta", cache_path=path, use_nachtkritik=False)
    assert sg["status"] == "covered", sg      # un agenda « What's On » n'est pas un avis
    mc = press.press_for("expo", "Neue Nationalgalerie", "Maurizio Cattelan. NIGHT", cache_path=path,
                         use_nachtkritik=False)
    assert mc["key"] == "negative", mc


def test_other_venue_is_not_a_match():
    arts = [press._article(press.TIP, "https://www.tip-berlin.de/kultur/kunst/christoph-schlingensief-gropius-bau/",
                           "2026-09-23", "Christoph schlingensief gropius bau", origin="sitemap")]
    path = _cache(arts)
    b = press.press_for("expo", "Neue Nationalgalerie", "Christoph Schlingensief. Deutschlandsuche ’99",
                        cache_path=path, use_nachtkritik=False)
    assert b["status"] == "none", b


def test_covered_none_and_not_open():
    arts = [press._article(press.TIP, "https://www.tip-berlin.de/kultur/kunst/josef-kaiser-berlinische-galerie/",
                           "2026-08-24", "Josef kaiser berlinische galerie", origin="sitemap")]
    path = _cache(arts)
    cov = press.press_for("expo", "Berlinische Galerie", "Josef Kaiser — Building for the GDR",
                          cache_path=path, use_nachtkritik=False)
    assert cov["status"] == "covered"
    assert press.format_buzz(cov, "en") == "📰 Buzz: covered (1 source), no clear verdict yet"
    none = press.press_for("expo", "KW Institute", "Nobody — Nothing", cache_path=path, use_nachtkritik=False)
    assert press.format_buzz(none, "en") == "📰 No reviews yet"
    soon = press.press_for("expo", "Neue Nationalgalerie", "Ulay, Ulay & Abramović", opens="2026-11-28",
                           cache_path=path, use_nachtkritik=False, today=date(2026, 11, 8))
    assert press.format_buzz(soon, "en") == "📰 Not open yet — reviews from 28 Nov"
    assert press.format_buzz(soon, "fr") == "📰 Pas encore ouvert — critiques à partir du 28 nov."


def test_search_query():
    assert press.search_query("Maurizio Cattelan. NIGHT") == '"Maurizio Cattelan"'
    assert press.search_query("Ruin and Rush") == '"Ruin and Rush"'
    assert press.search_query("CHANEL Commission: Lina Lapelytė. We Make Years Out of Hours") == '"Lina Lapelytė"' \
        or press.search_query("CHANEL Commission: Lina Lapelytė. We Make Years Out of Hours").startswith('"')


def test_theatre_needs_venue_and_giveaways_are_not_reviews():
    arts = [
        press._article("Jüdische Allgemeine", "https://example.org/kultur/aus-den-tiefen", "2026-10-05",
                       "Aus den Tiefen ins Licht", "Ein grandioses De Profundis in Wien."),
        press._article(press.MONOPOL, "https://www.monopol-magazin.de/monopol-verlost-karten-fuer-bad-kingdom-der-berliner-schaubuehne",
                       "2026-10-01", "Monopol verlost Karten für Bad Kingdom an der Schaubühne", "Großartig!"),
        press._article("Tagesspiegel", "https://example.org/x", "2026-10-02",
                       "Ruin und Rausch in der Neuen Nationalgalerie", "Klein, aber sehr lohnend."),
    ]
    path = _cache(arts)
    dp = press.press_for("theatre", "Berliner Ensemble", "De Profundis", cache_path=path, use_nachtkritik=False)
    assert dp["status"] == "none", dp
    bk = press.press_for("theatre", "Schaubühne", "Bad Kingdom", cache_path=path, use_nachtkritik=False)
    assert bk["status"] == "covered", bk
    rr = press.press_for("expo", "Neue Nationalgalerie", "Ruin and Rush", aliases=["Ruin und Rausch"],
                         cache_path=path, use_nachtkritik=False)
    assert rr["key"] == "positive", rr


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
