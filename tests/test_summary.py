"""Tests hors-ligne de l'extraction des résumés (pas de générique en 📝).

    ./.venv/bin/python -m tests.test_summary
"""
from __future__ import annotations

from pathlib import Path

from bs4 import BeautifulSoup

from src import summary as S

FIX = Path(__file__).parent / "fixtures"


def test_die_seherin_gets_the_synopsis_not_the_credits():
    soup = BeautifulSoup((FIX / "schaubuehne_die_seherin.html").read_text(), "html.parser")
    text = S._schaubuehne(soup)
    assert S.is_synopsis(text), text
    assert "war photographer" in text, text
    assert not text.lower().startswith(("by ", "director", "collaboration")), text


def test_credits_are_not_a_synopsis():
    for credits in (
        "by Milo Rau Collaboration text: Ursina Lardi Director: Milo Rau World Premiere Globe 11/26/2026, 20.30–22.00",
        "Regie: Thomas Ostermeier, Bühne: Magda Willi, Kostüme: Vanessa Sampaio Borgmann, Dramaturgie: "
        "Florian Borchmeyer, Musik: Nils Ostendorf, Licht: Erich Schneider. Premiere am 12. September.",
        "Mise en scène par Milo Rau, avec Ursina Lardi, Azad Hassan, Mohammed Al-Jabbar, Hassan Ali, "
        "Sarah Müller, Klaus Schmidt, Peter Weber, Anna Becker, Lisa Wagner, Julia Hoffmann.",
        "Short",
    ):
        assert not S.is_synopsis(credits), credits


def test_real_synopses_pass():
    for text in (
        "In »The Seer«, Ursina Lardi plays a war photographer who travels to conflict areas around the world "
        "in search of images of dread. She always seems one step ahead of the suffering and horror.",
        "Ein irischer Abenteurer steigt im Europa des 18. Jahrhunderts gesellschaftlich auf. Kubricks "
        "Historienepos ist berühmt für seine Fotografie mit natürlichem Licht und seine langsamen Zooms.",
    ):
        assert S.is_synopsis(text), text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
