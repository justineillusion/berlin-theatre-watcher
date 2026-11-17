from src.models import Show
from src.notify import format_show
from src.price import label, merge, parse_range


def test_parse_range():
    assert parse_range("Tickets: 14 - 110 €") == (14, 110)
    assert parse_range("Main Auditorium 28 to 89 € Introduction 19:15") == (28, 89)
    assert parse_range("23,00 €") == (23, 23)
    assert parse_range("Admission free") == (0, 0)
    assert parse_range("Fri 20.11.2026, 17:00") == (None, None)
    assert parse_range(None) == (None, None)


def test_label_and_merge():
    assert label(*merge([(14, 96), (16, 125), (None, None)])) == "14–125 €"
    assert label(23, 23, only_min=True) == "dès 23 €"
    assert label(0, 0, "en") == "Free admission"
    assert label(None, None) is None


def test_card_line_only_when_known():
    s = Show(theater="Komische Oper Berlin", title="Eugene Onegin", date="2026-12-01")
    assert "💶" not in format_show(s)
    s.price_min, s.price_max = 13, 96
    assert "💶 13–96 €" in format_show(s)
