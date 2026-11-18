from datetime import date

from src.parsers.concerts import parse_schokoladen, parse_urban_spree_event, urban_spree_cards

SK = """
<div class="main">
<div class="event"><div class="container"><div class="title"><a href="#e20261120"><div class="row">
 <div class="event-date"><h6 class="category">Musik</h6><p class="h3"><span>Freitag</span><br><span>20.11.</span><br><span class="d-none">19:00 Uhr</span></p></div>
 <div class="event-header"><h6><span class="promoter">little league shows prsnt: &nbsp;</span></h6><h2 class="fw-bold mb-0">AUSVERKAUFT! ParkPunk (deutschpunk) + FCKSCHNTZL</h2></div>
</div></a></div></div>
<div class="container"><div id="e20261120" data-event-date="2026-11-20" class="event-info collapse"><div class="event-facts">
 <a class="d-block ticket-btn" href="https://vvk.link/abc"><span>Tickets</span></a>
 <p><strong>Time</strong><br><span>doors 19:00 - show 20:00</span></p></div></div></div></div>
<div class="event"><div class="container"><div class="title"><a href="#e20261121"><div class="row">
 <div class="event-date"><h6 class="category">Lesung</h6><p class="h3"><span>21.11.</span></p></div>
 <div class="event-header"><h2>Eine Lesung</h2></div></div></a></div></div>
<div class="container"><div id="e20261121" data-event-date="2026-11-21" class="event-info collapse"></div></div></div>
</div>
"""


def test_schokoladen_concert_only_and_sold_out():
    xs = parse_schokoladen(SK, today=date(2026, 11, 1))
    assert len(xs) == 1                       # la lecture est écartée
    s = xs[0]
    assert s.title == "ParkPunk (deutschpunk) + FCKSCHNTZL"
    assert (s.date, s.time) == ("2026-11-20", "20:00")
    assert s.sold_out is True and s.booking_url == "https://vvk.link/abc"
    assert s.has_english_surtitles and s.production_type == "Concert"
    assert s.url.endswith("#e20261120") and s.languages == "little league shows"


US_LIST = """<div id="output">
<a href="program/concerts/coilguns-berlin-urban-spree.html" data-dateStart="2026-12-05 19:00:00" class="stealth swiper-slide card">
 <div class="card-body"><p class="card-text cat">Concerts</p><p class="card-text title">COILGUNS</p></div></a>
<a href="program/exhibitions/x.html" data-dateStart="2026-12-06 19:00:00" class="card"><p class="title">Expo</p></a>
</div>"""

US_EVENT = """<h1>Coilguns - Berlin - Urban Spree</h1>
<ul><li class="price"><div class="ct-price"> 24.90€ </div></li></ul>
<div class="ct-btns"><a href="https://www.eventim.de/event/coilguns-1">Buy tickets</a></div>"""


def test_urban_spree_card_and_event():
    cards = urban_spree_cards(US_LIST)
    assert [c["date"] for c in cards] == ["2026-12-05"]       # seulement la rubrique Concerts
    s = parse_urban_spree_event(US_EVENT, cards[0])
    assert s.title == "Coilguns" and s.time == "19:00"
    assert (s.price_min, s.price_max) == (24.9, 24.9)
    assert s.booking_url == "https://www.eventim.de/event/coilguns-1"
    assert s.url == "https://www.urbanspree.com/program/concerts/coilguns-berlin-urban-spree.html"
