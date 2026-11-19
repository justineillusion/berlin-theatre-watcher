from src.summary import summary_from_html

_HTML = """<div class="event-info" id="e1"><div class="event-description"><p>%s</p></div></div>
<div class="event-info" id="e2"><div class="event-description"><p>%s</p></div></div>""" % ("A" * 10 + " first band plays loud indie rock songs. " * 6, "Second band, completely different noisy punk songs here. " * 5)


def test_each_concert_gets_its_own_block():
    a, b = summary_from_html("Schokoladen", _HTML, "e1"), summary_from_html("Schokoladen", _HTML, "e2")
    assert a and b and a != b and "first band" in a and "Second band" in b


def test_missing_anchor_gives_nothing():
    assert summary_from_html("Schokoladen", _HTML, "e9") is None
