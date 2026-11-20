from src.main import is_workshop


def test_workshops_are_dropped():
    assert is_workshop("May Fall – Offener Tanzworkshop")
    assert is_workshop("Workshop: Voice")
    assert is_workshop("Masterclass mit X")


def test_shows_are_kept():
    assert not is_workshop("Die Räuber")
    assert not is_workshop("Kurs auf Utopia")
    assert not is_workshop("Werkstatt-Premiere: Hamlet")
