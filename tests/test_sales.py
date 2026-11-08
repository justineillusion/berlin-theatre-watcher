"""Calendrier des ventes : règles des théâtres, décalages (dimanche / férié), annonces.

    ./.venv/bin/python -m tests.test_sales
"""
from __future__ import annotations

from datetime import date, datetime, time

from src.sales import TZ, berlin_holidays, next_sale, parse_announcement


def _at(y, m, d, h=12, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=TZ)


def test_holidays():
    h = berlin_holidays(2027)
    assert date(2027, 3, 26) in h and date(2027, 3, 29) in h      # Vendredi saint, lundi de Pâques 2027
    assert date(2027, 3, 8) in h and date(2027, 10, 3) in h


def test_schaubuehne_first_of_month_11h():
    s = next_sale("schaubuhne", _at(2026, 11, 8))
    assert s.at == datetime(2026, 12, 1, 11, 0, tzinfo=TZ) and s.month == "2027-01" and s.source == "rule"
    # 1er janvier férié -> samedi 2 janvier (jour ouvré de la caisse)
    s = next_sale("schaubuhne", _at(2026, 12, 1, 12))
    assert s.day == date(2027, 1, 2) and s.month == "2027-02"
    # le jour même, avant 11:00 : c'est aujourd'hui
    assert next_sale("schaubuhne", _at(2026, 12, 1, 9)).day == date(2026, 12, 1)


def test_berliner_ensemble_third_10h_shifted_on_sunday():
    s = next_sale("berliner-ensemble", _at(2026, 12, 4))
    assert s.day == date(2027, 1, 4) and s.at.time() == time(10, 0)   # 3 jan. 2027 = dimanche
    assert next_sale("berliner-ensemble", _at(2026, 11, 8)).day == date(2026, 12, 3)


def test_volksbuehne_first_working_day_hour_unknown():
    s = next_sale("volksbuhne", _at(2026, 12, 2))
    assert s.day == date(2027, 1, 4) and s.at is None and not s.hour_known   # 1 férié, 2 sam., 3 dim.
    assert next_sale("volksbuhne", _at(2026, 12, 1, 23)).day == date(2026, 12, 1)  # heure inconnue : toute la journée


def test_page_announcement_overrides_rule():
    now = _at(2027, 8, 1, 8)
    txt = "Hinweis: Der Vorverkauf für September beginnt am 15. August um 14.00 Uhr im Webshop."
    assert parse_announcement(txt, now) == (date(2027, 8, 15), time(14, 0))
    s = next_sale("schaubuhne", now, [txt])
    assert s.at == datetime(2027, 8, 15, 14, 0, tzinfo=TZ) and s.source == "page" and s.month == "2027-09"
    # date numérique, sans heure -> heure de la règle
    s = next_sale("berliner-ensemble", now, ["Der Vorverkauf startet am 02.06.2028."])
    assert s.day == date(2028, 6, 2) and s.at.time() == time(10, 0)
    # annonce passée : ignorée, la règle reprend
    s = next_sale("schaubuhne", _at(2027, 8, 20), [txt])
    assert s.source == "rule" and s.day == date(2027, 9, 1)


def test_unknown_venue():
    assert next_sale("hamburger-bahnhof", _at(2026, 11, 8)) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
