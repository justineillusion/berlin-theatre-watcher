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


# --- Opéras / Philharmonie : le vrai texte, jamais le bandeau cookies -------
def _summary(fixture, theater):
    return S.summary_from_html(theater, (FIX / fixture).read_text())


def test_opera_and_concert_summaries_are_the_intro_not_the_cookie_banner():
    cases = [
        ("staatsoper_orfeo.html", "Staatsoper Unter den Linden", "Few works have had such a profound influence"),
        ("staatsoper_zauberfloete.html", "Staatsoper Unter den Linden", None),
        ("deutsche_oper_la_boheme.html", "Deutsche Oper Berlin", "At its premiere in Turin in 1896"),
        ("deutsche_oper_flying_dutchman.html", "Deutsche Oper Berlin", "With The Flying Dutchman, controversial"),
        ("komische_oper_eugene_onegin.html", "Komische Oper Berlin", "With stunning natural imagery"),
        ("komische_oper_orpheus.html", "Komische Oper Berlin", "Bored by her passionless marriage"),
        ("philharmoniker_57079.html", "Berliner Philharmoniker", "A Christmas oratorio in the French style"),
        ("philharmoniker_57135.html", "Berliner Philharmoniker", "“Listen inwardly and give yourself time”"),
    ]
    for fixture, theater, start in cases:
        text = _summary(fixture, theater)
        assert text and S.is_synopsis(text), (fixture, text)
        assert not S.looks_like_consent(text), (fixture, text)
        if start:
            assert text.startswith(start), (fixture, text)
        assert not text.lower().startswith(("act 1", "opera in", "romantic opera")), (fixture, text)


def test_staatsoper_without_intro_gets_no_summary():
    # Tristan : la page n'a que la fiche de l'œuvre -> pas de 📝 (et surtout pas le bandeau).
    assert _summary("staatsoper_tristan.html", "Staatsoper Unter den Linden") is None


def test_consent_banners_are_never_a_synopsis():
    for banner in (
        "We use tracking technologies to analyse how our website is used. This data helps us to detect errors "
        "and develop new designs. This also allows us to test the effectiveness of our website.",
        "Nous utilisons des technologies de suivi pour analyser l'utilisation de notre site web. Ces données nous "
        "aident à détecter les erreurs et à développer de nouveaux designs.",
        "In order for our website to function optimally, we use cookies for some of our applications. This "
        "includes i.a. the embedded social media, but also a tracking tool that provides us with information.",
        "Mit der Auswahl »Notwendige Cookies verwenden« erlauben Sie der Staatsoper Unter den Linden die "
        "Verwendung von technisch notwendigen Cookies, Pixeln, Tags und ähnlichen Technologien.",
        "Wir verwenden Cookies und ähnliche Technologien, um unsere Website zu verbessern. Ihre Einwilligung "
        "können Sie jederzeit mit Wirkung für die Zukunft widerrufen.",
        "Afin que notre site fonctionne de manière optimale, nous utilisons des cookies pour certaines de nos "
        "applications. Votre consentement peut être retiré à tout moment.",
    ):
        assert S.looks_like_consent(banner), banner
        assert not S.is_synopsis(banner), banner


def test_real_synopses_are_not_mistaken_for_banners():
    for text in (
        "A Christmas oratorio in the French style. In L’Enfance du Christ, Hector Berlioz tells the story of "
        "events following the birth of Jesus: the visit of the Three Wise Men to the cruel King Herod.",
        "Elle garde un secret : une recette de cookies transmise par sa grand-mère, qu'elle refuse de livrer "
        "à quiconque, même à sa fille, jusqu'au soir où tout bascule.",
    ):
        assert not S.looks_like_consent(text), text
        assert S.is_synopsis(text), text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
