"""« Buzz » presse : comment une expo / pièce / film est reçu·e dans la presse
berlinoise, allemande et internationale, résumé en UN signal.

Deux temps, comme critics.py :

    python -m src.press --refresh [--items items.json]     (réseau, ≤ 5 min)
        robots.txt → flux RSS / API / sitemaps des médias (+ recherche par item
        si une liste d'items est fournie) → state/press_cache.json

    press_for(kind, venue, title, url, opens=None)          (cache seul, AUCUN réseau)
        → {"status": "verdict", "level": "👍 positive", "basis": "2 sources", ...}
    buzz_line(...) → « 📰 Buzz : 👍 plutôt positif (2 sources) · ex. « … » (Monopol) »

Sources (vérifiées le 2026-11-08, voir docs/press.md) :
  flux RSS : Tagesspiegel Kultur, Berliner Zeitung, taz Kultur, Monopol,
    rbb24 Kultur, Deutschlandfunk Kultur (Bühne, Film, Kulturnachrichten,
    Themen), FAZ Kunst, SZ Kultur, Welt Kultur, Zeit (flux général), Jüdische
    Allgemeine, Berlin Art Link, ArtReview. Un flux ne donne que les derniers
    articles : le cache les ACCUMULE de nuit en nuit (fenêtre de 6 mois).
  The Berliner : API REST WordPress (6 mois d'Art / Stage / Film d'un coup,
    étoiles « 2.5 out of 5 stars », listes de sélections, « Hits / Misses »).
  tip Berlin : uniquement les sitemaps (le pare-feu refuse les robots sur les
    articles, /feed/ et /wp-json ; on ne contourne pas) → slug + date.
  recherche par item (si --items ou state/press_items.json) : flux de recherche
    WordPress (?s=…&feed=rss2) de Jüdische Allgemeine, Berlin Art Link et The
    Berliner, page de recherche Monopol. Résultats gardés 3 jours.
  Opéras : klassik-begeistert.de (blog de critiques d'opéra/concert, WordPress,
    robots.txt ouvert) : 3 pages de flux + recherche « titre + maison » ; titres
    originaux via Show.aliases (« Der fliegende Holländer »). Les maisons
    homonymes (Wiener Staatsoper, Deutsche Oper am Rhein…) sont écartées.
    Concerts de la Philharmonie : pas couverts (titres de programme du type
    « Petrenko conducts Respighi », impossibles à relier sans risque à une critique).
  Nachtkritik (pièces) : note estimée lue dans state/critics_cache.json via
    critics.fetch_rating(offline=True) — lecture seule, sans réseau.
  Inaccessibles aux robots / sans flux : Frieze (403), pages Zeit (403),
    art – Das Kunstmagazin (pas de flux), radio3 (pas de flux ; rbb24 Kultur).

Droits d'auteur : le cache garde titre + chapô (≤ 300 caractères, tels que
diffusés dans les flux) pour le lexique ; l'affichage ne montre qu'un fragment
de ≤ 15 mots porteur du verdict, jamais de lien (les URL restent dans le cache
pour déboguer).

Politesse : User-Agent honnête, robots.txt respecté, ≥ 1 s entre deux requêtes
au même site, 8 s max par requête (au-delà : sauté, réessayé au prochain run),
5 min de budget global.
"""
from __future__ import annotations

import argparse
import html as _html
import json
import re
import sys
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple
from urllib import robotparser
from urllib.parse import quote_plus, urlparse

import httpx
from bs4 import BeautifulSoup

_ROOT = Path(__file__).resolve().parent.parent
_CACHE_PATH = _ROOT / "state" / "press_cache.json"
_ITEMS_PATH = _ROOT / "state" / "press_items.json"
_UA = "berlin-theatre-watcher/1.0 (+personal Telegram culture bot; polite, 1 req/s)"
_PAUSE = 1.0             # ≥ 1 s entre deux requêtes au même site
_REQ_TIMEOUT = 8.0       # plafond par requête / par item : au-delà, on saute
_BUDGET = 300.0          # 5 min de wall-clock pour tout le refresh
_RESERVE = 10.0          # on garde 10 s pour écrire le cache
_WINDOW_DAYS = 183       # ~6 mois d'articles
_SEARCH_TTL_DAYS = 3
_SEARCH_WINDOW_DAYS = 365  # une expo longue peut avoir été critiquée il y a 8 mois
_DEK_MAX = 300

TIP = "tip Berlin"
BERLINER = "The Berliner"
NACHTKRITIK = "Nachtkritik"
MONOPOL = "Monopol"
JA = "Jüdische Allgemeine"
BAL = "Berlin Art Link"
KB = "klassik-begeistert"

# outlet -> [URL de flux RSS/Atom]
_FEEDS: Dict[str, List[str]] = {
    "Tagesspiegel": ["https://www.tagesspiegel.de/contentexport/feed/kultur"],
    "Berliner Zeitung": ["https://www.berliner-zeitung.de/feed.xml"],
    "taz": ["https://taz.de/!p4639;rss/"],
    MONOPOL: ["https://www.monopol-magazin.de/rss.xml"],
    "rbb24": ["https://www.rbb24.de/kultur/index.xml/feed=rss.xml"],
    "Deutschlandfunk Kultur": [
        "https://www.deutschlandfunkkultur.de/buehne-100.rss",
        "https://www.deutschlandfunkkultur.de/film-serie-100.rss",
        "https://www.deutschlandfunkkultur.de/kulturnachrichten-116.rss",
        "https://www.deutschlandfunkkultur.de/aktuelle-kultur-themen-100.rss",
    ],
    "FAZ": ["https://www.faz.net/rss/aktuell/feuilleton/kunst/"],
    "SZ": ["https://rss.sueddeutsche.de/rss/Kultur"],
    "Welt": ["https://www.welt.de/feeds/section/kultur.rss"],
    "Zeit": ["https://newsfeed.zeit.de/index"],
    JA: ["https://www.juedische-allgemeine.de/feed/",
         "https://www.juedische-allgemeine.de/feed/?paged=2"],
    BAL: ["https://www.berlinartlink.com/feed/"],
    "ArtReview": ["https://artreview.com/rss.xml"],
    # Opéra / concerts : blog de critiques (WordPress, robots.txt ouvert), titres du type
    # « Giacomo Puccini, Tosca, Bernheim  Staatsoper Unter den Linden, 28. Oktober 2026 ».
    # 10 articles par page de flux, ~4 par jour (toute l'Europe) : 3 pages.
    KB: ["https://klassik-begeistert.de/feed/", "https://klassik-begeistert.de/feed/?paged=2",
         "https://klassik-begeistert.de/feed/?paged=3"],
}
# recherche par item : outlet -> gabarit d'URL ({q} = requête encodée)
_WP_SEARCH = {
    JA: "https://www.juedische-allgemeine.de/?s={q}&feed=rss2",
    BAL: "https://www.berlinartlink.com/?s={q}&feed=rss2",
    BERLINER: "https://www.the-berliner.com/?s={q}&feed=rss2",
    KB: "https://klassik-begeistert.de/?s={q}&feed=rss2",
}
# Recherche klassik-begeistert : titre + maison (« Tosca » seul = Sofia, Vienne…).
_SEARCH_HOUSE = {
    "Staatsoper Unter den Linden": "Staatsoper Linden",
    "Deutsche Oper Berlin": "Deutsche Oper Berlin",
    "Komische Oper Berlin": "Komische Oper",
}
# Revues de presse quotidiennes (« DIE DIENSTAG-PRESSE – 10. NOVEMBER 2026 ») :
# vingt maisons et vingt œuvres dans un même chapô, pas une critique.
_ROUNDUP_RE = re.compile(r"\b\w+TAG-PRESSE\b|\bPRESSE\s+[–—-]\s+\d", re.I)
_MONOPOL_SEARCH = "https://www.monopol-magazin.de/suche?search_api_fulltext={q}"
_TAZ_SEARCH = "https://taz.de/!s={q};rss/"           # flux RSS de la recherche taz

# Sitemaps mensuelles (Tagesspiegel, Berliner Zeitung) : toutes les URL culture
# d'un mois, avec un slug parlant. Les mois révolus ne sont lus qu'une fois.
_MONTHLY_SITEMAPS = {
    "Tagesspiegel": {
        "index": "https://www.tagesspiegel.de/contentexport/static/sitemap-index_{year}.xml",
        "month_re": r"sitemap_(\d{2})_(\d{4})\.xml", "month_order": ("m", "y"),
        "section": "/kultur/",
    },
    "Berliner Zeitung": {
        "index": "https://www.berliner-zeitung.de/sitemap.xml",
        "month_re": r"sitemap\.articles\.(\d{4})-(\d{2})_\d+\.xml", "month_order": ("y", "m"),
        # pas de rubrique dans l'URL (/article/<slug>-<id>) : ~2000 articles/mois,
        # on ne garde que ceux dont le slug nomme un item (et on relit chaque nuit).
        "section": None,
    },
}
# Médias dont on peut lire le chapô (meta description) d'un article qui
# correspond à un item mais n'a qu'un slug (sitemap) ou un titre (recherche).
_ENRICHABLE = {"Tagesspiegel", "Berliner Zeitung", "taz", MONOPOL}
_ENRICH_MAX = 40

_TIP_BASE = "https://www.tip-berlin.de"
_TB_BASE = "https://www.the-berliner.com"
_TB_CATEGORIES = {"art": 5416, "stage": 5506, "film": 5405}
_TB_PICK_TAG_SLUGS = ("editors-pick", "editors-picks", "pick", "critics-picks")
_TIP_SECTIONS = {
    "/kultur/kunst/": "expo", "/kultur/ausstellungen/": "expo",
    "/kultur/buehne/": "theatre", "/kultur/theater/": "theatre",
    "/kultur/film/": "film", "/kino-stream/": "film",
}


# ---------------------------------------------------------------------------
# Normalisation (même logique que critics._key)
# ---------------------------------------------------------------------------
_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "æ": "ae", "ø": "o"})


def _key(text: str) -> str:
    """« Lovis Corinth — Dann kam Berlin! » -> « lovis corinth dann kam berlin »."""
    text = unicodedata.normalize("NFKC", text or "").casefold().translate(_FOLD)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("&", " und ")
    text = re.sub(r"[’'`´]s\b", "", text)          # « Shilpa Gupta’s » -> « shilpa gupta »
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _contains(hay: str, needle: str) -> bool:
    return bool(needle) and f" {needle} " in f" {hay} "


def _clean(fragment: str) -> str:
    return re.sub(r"\s+", " ", _html.unescape(re.sub(r"<[^>]+>", " ", fragment or ""))).strip()


_VENUE_ALIASES: Dict[str, Tuple[str, ...]] = {
    "Hamburger Bahnhof": ("hamburger bahnhof",),
    "Neue Nationalgalerie": ("neue nationalgalerie", "neuen nationalgalerie"),
    "KW Institute for Contemporary Art": ("kw institute", "kunst werke", "kunstwerke", "kw berlin"),
    "C/O Berlin": ("c o berlin", "co berlin"),
    "Berlinische Galerie": ("berlinische galerie", "berlinischen galerie"),
    "Fotografiska Berlin": ("fotografiska",),
    "Schaubühne": ("schaubuehne",),
    "Berliner Ensemble": ("berliner ensemble",),
    "Volksbühne": ("volksbuehne", "volksbuhne"),
    "Berliner Festspiele": ("berliner festspiele", "haus der berliner festspiele", "theatertreffen"),
    # Opéras : « an der Staatsoper », « Deutsche Oper », « Komische Oper » (au Schillertheater
    # pendant les travaux). Les homonymes d'autres villes sont écartés par _VENUE_FOREIGN.
    "Staatsoper Unter den Linden": ("staatsoper unter den linden", "staatsoper berlin", "lindenoper",
                                    "staatsoper"),
    "Deutsche Oper Berlin": ("deutsche oper berlin", "deutschen oper berlin", "deutsche oper", "deutschen oper"),
    "Komische Oper Berlin": ("komische oper", "komischen oper", "schillertheater", "schiller theater"),
    # lieux fréquents ailleurs (pour écarter un homonyme : Schlingensief au Gropius Bau…)
    "Gropius Bau": ("gropius bau",),
    "HAU": ("hau1", "hau2", "hau3", "hebbel am ufer"),
    "Maxim Gorki Theater": ("gorki",),
    "Deutsches Theater": ("deutsches theater",),
    "Sophiensaele": ("sophiensaele",),
    "Haus der Kulturen der Welt": ("hkw", "haus der kulturen der welt"),
    "Kindl": ("kindl",),
    "Haus am Waldsee": ("haus am waldsee",),
    "Alte Nationalgalerie": ("alte nationalgalerie",),
    "Kunsthalle": ("kunsthalle",),
    "Museum Barberini": ("barberini",),
}


# Même nom, autre maison : « Wiener Staatsoper », « Deutsche Oper am Rhein »… Si l'un
# d'eux est nommé sans la forme berlinoise explicite, l'article parle d'ailleurs.
_VENUE_FOREIGN: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {
    "Staatsoper Unter den Linden": (
        ("wiener staatsoper", "staatsoper wien", "hamburgische staatsoper", "hamburgischen staatsoper",
         "staatsoper hamburg", "bayerische staatsoper", "bayerischen staatsoper", "staatsoper muenchen",
         "staatsoper stuttgart", "staatsoper hannover", "staatsoper prag", "saechsische staatsoper",
         "staatsoper dresden", "semperoper", "staatsoper budapest", "ungarische staatsoper"),
        ("staatsoper unter den linden", "staatsoper berlin", "lindenoper"),
    ),
    "Deutsche Oper Berlin": (
        ("deutsche oper am rhein", "deutschen oper am rhein"),
        ("deutsche oper berlin", "deutschen oper berlin"),
    ),
}


def _foreign_house(venue: str, unit_text: str) -> bool:
    for name, (others, home) in _VENUE_FOREIGN.items():
        if _key(venue) and (_key(name) == _key(venue) or _key(venue) in _key(name)):
            return any(_contains(unit_text, o) for o in others) and not any(_contains(unit_text, h) for h in home)
    return False


def _venue_keys(venue: str) -> Tuple[str, ...]:
    for name, aliases in _VENUE_ALIASES.items():
        if _key(name) and (_key(name) in _key(venue) or _key(venue) in _key(name)):
            return aliases
    return (_key(venue),) if _key(venue) else ()


def _venues_in(text_key: str) -> List[str]:
    found = {name for name, aliases in _VENUE_ALIASES.items()
             if any(_contains(text_key, a) for a in aliases)}
    if "Alte Nationalgalerie" in found and not re.search(r"(?<!alte )neue nationalgalerie", text_key):
        found.discard("Neue Nationalgalerie")
    return sorted(found)


# ---------------------------------------------------------------------------
# Notes : étoiles et lexique (EN + DE) sur titre + chapô
# ---------------------------------------------------------------------------
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}


def parse_stars(text: str) -> Optional[float]:
    """« (2.5 out of 5 stars) », « (four stars) », « three and a half stars » -> float."""
    t = _html.unescape(text or "").lower()
    m = re.search(r"(\d(?:[.,]5)?)\s*(?:/|out of)\s*5\s*stars?", t)
    if m:
        return float(m.group(1).replace(",", "."))
    m = re.search(r"\b(one|two|three|four|five)( and a half)? stars?\b", t)
    if m:
        return _NUM_WORDS[m.group(1)] + (0.5 if m.group(2) else 0)
    m = re.search(r"(★+)(½)?", text or "")
    if m and len(m.group(1)) <= 5:
        return len(m.group(1)) + (0.5 if m.group(2) else 0)
    return None


_EN_POSITIVE = {
    "masterpiece": 2, "masterful": 2, "masterclass": 2, "brilliant": 2, "stunning": 2,
    "triumph": 2, "triumphant": 2, "unmissable": 2, "must see": 2, "sensational": 2,
    "outstanding": 2, "superb": 2, "dazzling": 2, "breathtaking": 2, "extraordinary": 1.5,
    "magnificent": 2, "captivating": 1.5, "gripping": 1.5, "compelling": 1.5,
    "powerful": 1.5, "moving": 1, "wonderful": 1.5, "beautiful": 1, "delight": 1.5,
    "joyful": 1, "endearing": 1, "impressive": 1.5, "excellent": 1.5, "highlight": 1,
    "gem": 1.5, "best": 1, "great": 1, "particularly good": 1.5, "good": 0.5,
    "clever": 1, "witty": 1, "enjoyable": 1, "pleasant": 0.5, "thrilling": 1.5,
    "greatest asset": 1, "worth": 1, "recommend": 1, "favourite": 1, "favorite": 1,
    "tour de force": 2, "revelatory": 2, "poignant": 1, "radiant": 1,
}
_EN_NEGATIVE = {
    "disappointing": 2, "disappoints": 2, "dull": 2, "boring": 2, "tedious": 2,
    "misfire": 2, "misfires": 2, "fails": 1.5, "flop": 2, "misses": 1,
    "overlong": 1.5, "self indulgent": 1.5, "pretentious": 1.5, "messy": 1.5,
    "underwhelming": 2, "underwhelms": 2, "weak": 1.5, "shallow": 1.5, "bland": 1.5,
    "flat": 1, "jarring": 1, "overlook": 1, "waffle": 1, "confusing": 1, "clumsy": 1.5,
    "unsuccessful": 1.5, "lacks": 1, "lacking": 1, "forgettable": 1.5, "mediocre": 1.5,
    "lukewarm": 1.5, "uneven": 1, "flawed": 1, "falls short": 1.5, "hollow": 1.5,
    "stale": 1.5, "tired": 1, "gimmick": 1.5, "gimmicky": 1.5, "one note": 1.5,
}
# DE en plus de critics.py (titres / chapôs de presse, pas Rundschau)
_DE_POSITIVE = {"lohnend": 1.5, "lohnenswert": 1.5, "sehenswert": 1.5, "unbedingt": 1,
                "muss man sehen": 2, "grossartig": 2, "glanzvoll": 1.5, "meisterlich": 2,
                "betoerend": 1.5, "fabelhaft": 1.5, "empfehlenswert": 1.5, "beglueckend": 2,
                "ein spektakel": 1.5, "tiefsinn": 1, "sehr lohnend": 2}
_DE_NEGATIVE = {"enttaeuschend": 2, "verzichtbar": 1.5, "misslungen": 2, "duerftig": 1.5,
                "zaeh": 2, "oede": 2, "lauwarm": 1.5, "ueberschaetzt": 1.5,
                "abgestanden": 1.5, "effekthascherei": 1.5, "schrumpft zum": 1.5, "schrumpft zur": 1.5}
_MAYBE_NEGATED = {"successful": 1.0, "successfully": 1.0, "success": 1.0}
_NEGATORS = {"not", "never", "no", "hardly", "isn", "isnt", "nicht", "kein", "keine",
             "keinen", "kaum", "wenig", "nie"}


def _lexicons() -> Tuple[Dict[str, float], Dict[str, float]]:
    pos = {**_EN_POSITIVE, **_MAYBE_NEGATED, **_DE_POSITIVE}
    neg = {**_EN_NEGATIVE, **_DE_NEGATIVE}
    try:  # lexique allemand pondéré de critics.py (lecture seule)
        from .critics import _NEGATIVE as de_neg, _POSITIVE as de_pos
        for k, v in de_pos.items():
            pos.setdefault(_key(k), v)
        for k, v in de_neg.items():
            neg.setdefault(_key(k), v)
    except Exception:  # noqa: BLE001
        pass
    # mots trop ambigus dans un titre de presse (« stark » = « fort », « hit », « coup »…)
    for w in ("stark", "starke", "hit", "coup", "fein", "kalt", "fehlt", "leider", "grotesk",
              "intensiv", "glueck", "toll", "einwand", "schmal", "duenn", "schade"):
        pos.pop(w, None)
        neg.pop(w, None)
    return {_key(k): v for k, v in pos.items()}, {_key(k): v for k, v in neg.items()}


_POS, _NEG = _lexicons()


def text_score(text: str) -> Tuple[float, float]:
    """(score dans [-1, 1], poids des indices trouvés) d'un titre / chapô."""
    low = _key(text)
    total = weight = 0.0
    for lexicon, sign in ((_POS, 1), (_NEG, -1)):
        for term, w in lexicon.items():
            if " " in term and _contains(low, term):
                total += sign * w
                weight += w
                low = f" {low} ".replace(f" {term} ", " ").strip()
    words = low.split()
    for i, word in enumerate(words):
        for lexicon, sign in ((_POS, 1), (_NEG, -1)):
            hit = lexicon.get(word)
            if hit is None and len(word) >= 6:   # radicaux allemands (« begeister… »)
                hit = next((v for t, v in lexicon.items()
                            if " " not in t and len(t) >= 6 and word.startswith(t)), None)
            if hit is None:
                continue
            s = sign
            if any(w in _NEGATORS for w in words[max(0, i - 3):i]):
                s = -sign * 0.7
            total += s * hit
            weight += hit
            break
    if weight == 0:
        return 0.0, 0.0
    return total / (weight + 1.0), weight


def verdict_fragment(headline: str, dek: str, max_words: int = 15) -> Optional[str]:
    """Le bout de phrase (≤ 15 mots) qui porte le verdict, ou None."""
    best, best_w = None, 0.0
    for chunk in re.split(r"(?<=[.!?;:])\s+|\s+[–—]\s+|\s*\|\s*", f"{headline}. {dek}"):
        chunk = chunk.strip(" .\"'“”„«»‘’")
        if not chunk or chunk.endswith("?"):
            continue
        s, w = text_score(chunk)
        if w > best_w and abs(s) >= 0.2:
            best, best_w = chunk, w
    if not best:
        return None
    words = best.split()
    return " ".join(words[:max_words]) + ("…" if len(words) > max_words else "")


# ---------------------------------------------------------------------------
# Réseau poli
# ---------------------------------------------------------------------------
class _Fetcher:
    """≥ 1 s entre deux requêtes au même site, 8 s max par requête, budget global."""

    def __init__(self, budget: float = _BUDGET):
        self.deadline = time.monotonic() + budget
        self.robots: Dict[str, robotparser.RobotFileParser] = {}
        self.host_locks: Dict[str, threading.Lock] = {}
        self.last: Dict[str, float] = {}
        self.lock = threading.Lock()
        self.client = httpx.Client(follow_redirects=True, headers={
            "User-Agent": _UA, "Accept-Language": "de,en;q=0.8"})
        self.log: List[str] = []

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def _host_lock(self, host: str) -> threading.Lock:
        with self.lock:
            return self.host_locks.setdefault(host, threading.Lock())

    def _raw(self, url: str, params: Optional[dict] = None) -> httpx.Response:
        host = urlparse(url).netloc
        with self._host_lock(host):
            if self.remaining() < _RESERVE:
                raise TimeoutError("budget global épuisé")
            wait = self.last.get(host, 0.0) + _PAUSE - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            timeout = min(_REQ_TIMEOUT, self.remaining() - _RESERVE)
            try:
                return self.client.get(url, params=params, timeout=httpx.Timeout(timeout))
            finally:
                self.last[host] = time.monotonic()

    def allowed(self, url: str) -> bool:
        host = "{0.scheme}://{0.netloc}".format(urlparse(url))
        with self._host_lock("robots:" + host):
            if host not in self.robots:
                rp = robotparser.RobotFileParser()
                try:
                    r = self._raw(host + "/robots.txt")
                    rp.parse(r.text.splitlines() if r.status_code == 200 else [])
                except Exception:  # noqa: BLE001 — robots illisible : on s'abstient
                    rp.parse(["User-agent: *", "Disallow: /"])
                self.robots[host] = rp
        return self.robots[host].can_fetch(_UA, url)

    def get(self, url: str, params: Optional[dict] = None) -> Optional[httpx.Response]:
        """Réponse 200, ou None (robots, 4xx/5xx, > 8 s, budget)."""
        if not self.allowed(url):
            self._note(f"robots.txt interdit {url}")
            return None
        try:
            r = self._raw(url, params)
        except Exception as exc:  # noqa: BLE001
            self._note(f"{type(exc).__name__} {url}")
            return None
        if r.status_code != 200:
            self._note(f"HTTP {r.status_code} {url}")
            return None
        return r

    def _note(self, msg: str) -> None:
        with self.lock:
            self.log.append(msg)


# ---------------------------------------------------------------------------
# Article : un enregistrement commun à toutes les sources
# ---------------------------------------------------------------------------
def _article(outlet: str, url: str, day: str, headline: str, dek: str = "", *,
             section: str = "", stars: Optional[float] = None, is_pick: bool = False,
             subjects: Optional[List[str]] = None, entries: Optional[List[dict]] = None,
             origin: str = "feed") -> dict:
    dek = dek[:_DEK_MAX]
    path_words = _key(urlparse(url).path.replace("/", " ").replace("-", " "))
    return {
        "outlet": outlet, "url": url, "date": day, "headline": headline[:200], "dek": dek,
        "section": section, "stars": stars if stars is not None else (parse_stars(dek) or parse_stars(headline)),
        "is_pick": is_pick, "subjects": subjects or [], "match": path_words,
        "venues": _venues_in(_key(" ".join([headline, dek, path_words]))),
        "entries": entries or [], "origin": origin,
    }


def _parse_date(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        return parsedate_to_datetime(raw).date().isoformat()
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return raw[:10] if re.match(r"\d{4}-\d{2}-\d{2}", raw) else ""


def parse_feed(xml_text: str, outlet: str, origin: str = "feed") -> List[dict]:
    """RSS 2.0 ou Atom -> articles (titre + chapô, sans le corps)."""
    try:
        root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    except ET.ParseError:
        return []
    out = []
    for node in root.iter():
        tag = node.tag.rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        fields: Dict[str, str] = {}
        for child in node:
            name = child.tag.rsplit("}", 1)[-1]
            if name == "link" and child.get("href"):
                fields.setdefault("link", child.get("href"))
            elif child.text and name not in fields:
                fields[name] = child.text
        link = (fields.get("link") or fields.get("guid") or "").strip()
        title = _clean(fields.get("title", ""))
        if not link.startswith("http") or not title:
            continue
        dek = _clean(fields.get("description") or fields.get("summary") or "")
        dek = re.sub(r"\s*(The post|Der Beitrag) .*? (appeared first on|erschien zuerst auf) .*$", "", dek)
        dek = re.sub(r"\s*(\[…\]|\[\.\.\.\]|Weiterlesen.*|Read more.*)$", "", dek)
        day = _parse_date(fields.get("pubDate") or fields.get("published") or fields.get("updated")
                          or fields.get("date") or "")
        out.append(_article(outlet, link, day, title, dek, origin=origin))
    return out


# ---------------------------------------------------------------------------
# The Berliner (API REST WordPress)
# ---------------------------------------------------------------------------
# Une vraie SÉLECTION (« Best of », « Editor's picks », « Unmissable »…). Un agenda
# (« What's On », « Guide », « What to See ») n'est qu'une mention : « covered ».
_PICK_LIST_RE = re.compile(
    r"\b(best|highlights?|unmissable|must[- ]see|picks?|recommend\w*|don'?t miss|top \d+)\b", re.I)
_DATE_HEADING_RE = re.compile(
    r"^(through|throgh|throguh|until|from|ongoing|\d|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)",
    re.I)
_SKIP_LIST_RE = re.compile(r"photo[- ]of[- ]the[- ]week", re.I)


def _subjects(excerpt: str) -> List[str]:
    """Noms cités dans l'extrait : ‘Next Door’, « Marina Abramović’s ‘…’ », « by X »."""
    out = re.findall(r"[‘'“\"]([^‘’'“”\"]{3,120})[’'”\"]", excerpt)
    out += re.findall(r"((?:[A-ZÄÖÜ][\w\-]+\s){1,3}[A-ZÄÖÜ][\w\-]+)[’']s\s+[‘'“]", excerpt)
    out += re.findall(r"\bby\s+((?:[A-ZÄÖÜ][\w\-–.]+\s?){1,4})", excerpt)
    return list(dict.fromkeys(s.strip(" .,") for s in out if len(_key(s)) >= 3))


def _list_entries(content_html: str) -> List[dict]:
    """Intertitres d'une liste : [{name, venues, section}] (section : hits/misses/'')."""
    soup = BeautifulSoup(content_html or "", "html.parser")
    entries: List[dict] = []
    section = ""
    current: Optional[dict] = None
    for el in soup.find_all(["h2", "h3", "h4", "p", "ul", "ol", "figure"]):
        if el.name in ("h2", "h3", "h4"):
            name = el.get_text(" ", strip=True)
            low = name.lower().strip(" :")
            if low in ("the hits", "hits", "the misses", "misses"):
                section = "hits" if "hit" in low else "misses"
                current = None
                continue
            if not name or _DATE_HEADING_RE.match(name) or len(name) > 160:
                continue
            current = {"name": name, "venues": [], "section": section, "_ctx": ""}
            entries.append(current)
        elif current is not None and len(current["_ctx"]) < 600:
            current["_ctx"] += " " + el.get_text(" ", strip=True)
    for e in entries:
        e["venues"] = _venues_in(_key(e.pop("_ctx") + " " + e["name"]))   # noms de lieux seulement
    return entries


def _berliner(f: _Fetcher, since: datetime) -> Optional[List[dict]]:
    pick_tags: set = set()
    r = f.get(f"{_TB_BASE}/wp-json/wp/v2/tags",
              params={"slug": ",".join(_TB_PICK_TAG_SLUGS), "_fields": "id,slug"})
    if r is not None:
        pick_tags = {t["id"] for t in r.json()}
    posts: Dict[int, dict] = {}
    page, pages, failed = 1, 1, False
    while page <= pages:
        r = f.get(f"{_TB_BASE}/wp-json/wp/v2/posts", params={
            "categories": ",".join(map(str, _TB_CATEGORIES.values())),
            "after": since.strftime("%Y-%m-%dT%H:%M:%S"),
            "per_page": 20, "page": page, "orderby": "date", "order": "desc",
            "_fields": "id,date,link,title,excerpt,content,categories,tags"})
        if r is None:
            failed = True
            break
        pages = int(r.headers.get("X-WP-TotalPages", "1") or 1)
        for p in r.json():
            posts[p["id"]] = p
        page += 1
    if not posts and failed:
        return None
    cat_kind = {v: k for k, v in _TB_CATEGORIES.items()}
    out = []
    for p in posts.values():
        link = p.get("link", "")
        title = _clean(p.get("title", {}).get("rendered", ""))
        excerpt = _clean(p.get("excerpt", {}).get("rendered", ""))
        if _SKIP_LIST_RE.search(link + " " + title):
            continue
        slug_words = _key(urlparse(link).path.replace("/", " ").replace("-", " "))
        stars = parse_stars(excerpt) or parse_stars(title)
        entries = _list_entries(p.get("content", {}).get("rendered", ""))
        is_list = len(entries) >= 3 and stars is None
        tagged = bool(pick_tags.intersection(p.get("tags", [])))
        out.append(_article(
            BERLINER, link, (p.get("date") or "")[:10], title, excerpt,
            section="/".join(sorted(cat_kind[c] for c in p.get("categories", []) if c in cat_kind)),
            stars=stars,
            is_pick=tagged or bool(is_list and _PICK_LIST_RE.search(title + " " + slug_words)),
            subjects=_subjects(excerpt), entries=entries if is_list else [], origin="rest"))
        out[-1]["tagged_pick"] = tagged
    return out


# ---------------------------------------------------------------------------
# tip Berlin (sitemaps Yoast uniquement)
# ---------------------------------------------------------------------------
def _tip(f: _Fetcher, since: datetime) -> Optional[List[dict]]:
    r = f.get(f"{_TIP_BASE}/sitemap_index.xml")
    if r is None:
        return None
    cutoff = since.strftime("%Y-%m-%d")
    maps = re.findall(r"<loc>([^<]*post-sitemap\d*\.xml)</loc>\s*<lastmod>([^<]+)</lastmod>", r.text)
    out, failed = [], False
    for sm in [u for u, lm in maps if lm[:10] >= cutoff]:
        r = f.get(sm)
        if r is None:
            failed = True
            continue
        for loc, lastmod in re.findall(r"<url>\s*<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", r.text):
            if lastmod[:10] < cutoff:
                continue
            path = urlparse(loc).path
            kind = next((k for pre, k in _TIP_SECTIONS.items() if path.startswith(pre)), None)
            if kind is None:
                continue
            words = path.rstrip("/").rsplit("/", 1)[-1].replace("-", " ")
            out.append(_article(TIP, loc, lastmod[:10], words[:1].upper() + words[1:], section=kind,
                                is_pick=bool(re.search(r"\b(tipps?|highlights|empfehlung\w*|besten)\b", words)),
                                origin="sitemap"))
    if not out and failed:
        return None
    return out


_KB_NAME_RE = re.compile(r"\s*klassik-begeistert(?:\.de)?[-:,]?\s*", re.I)


def _tidy(outlet: str, arts: List[dict]) -> List[dict]:
    """klassik-begeistert : sans les revues de presse quotidiennes, et sans le nom du
    blog dans le titre (« begeistert » ferait passer n'importe quoi pour un éloge)."""
    if outlet != KB:
        return arts
    out = []
    for a in arts:
        if _ROUNDUP_RE.search(a["headline"]):
            continue
        a["headline"] = _KB_NAME_RE.sub(" ", a["headline"]).strip()
        a["dek"] = _KB_NAME_RE.sub(" ", a["dek"]).strip()
        out.append(a)
    return out


def _feeds(f: _Fetcher, outlet: str, urls: List[str]) -> Optional[List[dict]]:
    out, ok = [], False
    for u in urls:
        r = f.get(u)
        if r is None:
            continue
        ok = True
        out += _tidy(outlet, parse_feed(r.text, outlet))
    return out if ok else None


# ---------------------------------------------------------------------------
# Recherche par item
# ---------------------------------------------------------------------------
def search_query(title: str) -> str:
    """Requête courte et précise : l'artiste (« Maurizio Cattelan ») sinon le titre."""
    head = re.split(r"\s+[—–]\s+|\.\s+|:\s+|,\s+", title.strip(" []"))[0].strip(" []")
    head = re.sub(r"^.*?\b(commission|presents?)\b\s*", "", head, flags=re.I) or head
    k = _key(head)
    if len(k) < 6 or k in _GENERIC:
        head = title.strip(" []")
    return f'"{head}"' if " " in head else head


def _search_monopol(f: _Fetcher, query: str) -> Optional[List[dict]]:
    r = f.get(_MONOPOL_SEARCH.format(q=quote_plus(query.strip('"'))))
    if r is None:
        return None
    out = []
    qk = _key(query)
    for href, label in re.findall(r'<h[23][^>]*>\s*<a href="([^"]+)"[^>]*>([^<]+)</a>', r.text)[:10]:
        url = href if href.startswith("http") else "https://www.monopol-magazin.de" + href
        title, dek, day = _clean(label), "", ""
        # La page de recherche n'a ni chapô ni date : pour les résultats qui nomment
        # vraiment l'item (slug ou titre), on lit le chapô (meta description) + la date.
        if _contains(_key(title), qk) or _contains(_key(url.replace("-", " ")), qk):
            meta = _page_meta(f, url)
            if meta:
                dek, day = meta.get("dek", ""), meta.get("date", "")
        out.append(_article(MONOPOL, url, day, title, dek, origin="search"))
    return out


def _page_meta(f: _Fetcher, url: str) -> Optional[dict]:
    """Titre, chapô (meta description) et date d'une page d'article — pas le corps."""
    page = f.get(url)
    if page is None:
        return None
    t = page.text[:400_000]

    def meta(*names: str) -> str:
        for n in names:
            m = (re.search(rf'<meta[^>]+(?:name|property)="{n}"[^>]+content="([^"]*)"', t)
                 or re.search(rf'<meta[^>]+content="([^"]*)"[^>]+(?:name|property)="{n}"', t))
            if m and m.group(1).strip():
                return _clean(m.group(1))
        return ""
    m = re.search(r'(?:"datePublished"\s*:\s*"|article:published_time"\s+content=")([0-9T:.\-+Z]+)', t)
    return {"headline": meta("og:title", "twitter:title"),
            "dek": meta("og:description", "description", "twitter:description")[:_DEK_MAX],
            "date": _parse_date(m.group(1)) if m else ""}


def _search_taz(f: _Fetcher, query: str) -> Optional[List[dict]]:
    r = f.get(_TAZ_SEARCH.format(q=quote_plus(query)))
    if r is None:
        return None
    out = parse_feed(r.text, "taz", origin="search")[:10]
    for a in out:   # « …/!6211637&s=Ryuichi+Sakamoto// » -> URL propre
        a["url"] = re.sub(r"&s=[^/]*/*$", "/", a["url"])
    return out


def _monthly(f: _Fetcher, outlet: str, since: datetime, done: List[str],
             item_phrases: Iterable[str] = ()) -> Optional[Tuple[List[dict], List[str]]]:
    """Articles culture des sitemaps mensuelles depuis `since` (mois révolus : une fois)."""
    cfg = _MONTHLY_SITEMAPS[outlet]
    now = datetime.now(timezone.utc)
    indexes = sorted({cfg["index"].format(year=y) for y in range(since.year, now.year + 1)})
    maps = []
    for idx in indexes:
        r = f.get(idx)
        if r is None:
            continue
        for loc in re.findall(r"<loc>([^<]+)</loc>", r.text):
            m = re.search(cfg["month_re"], loc)
            if not m:
                continue
            parts = dict(zip(cfg["month_order"], m.groups()))
            month = f'{parts["y"]}-{parts["m"]}'
            if month >= since.strftime("%Y-%m"):
                maps.append((month, loc))
    if not maps:
        return None
    current = {now.strftime("%Y-%m"), (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")}
    out, newly_done = [], []
    for month, loc in sorted(maps, reverse=True):
        if cfg["section"] and loc in done and month not in current:
            continue                     # mois révolu déjà indexé
        r = f.get(loc)
        if r is None:
            continue                     # > 8 s : réessai au prochain run
        for u, lm in re.findall(r"<loc>([^<]+)</loc>\s*(?:<lastmod>([^<]*)</lastmod>)?", r.text):
            slug = urlparse(u).path.rstrip("/").rsplit("/", 1)[-1]
            if cfg["section"]:
                if cfg["section"] not in u:
                    continue
            elif not any(_contains(_key(slug.replace("-", " ")), ph) for ph in item_phrases):
                continue
            slug = re.sub(r"(-li\.\d+|-\d{5,})(\.html)?$|\.html$", "", slug)
            slug = re.sub(r"^dpa-", "", slug).replace("-", " ")
            out.append(_article(outlet, u, (lm or "")[:10] or f"{month}-01",
                                slug[:1].upper() + slug[1:], origin="sitemap"))
        if month not in current and cfg["section"]:
            newly_done.append(loc)
    return out, newly_done


def _search_wp(f: _Fetcher, outlet: str, query: str) -> Optional[List[dict]]:
    r = f.get(_WP_SEARCH[outlet].format(q=quote_plus(query)))
    if r is None:
        return None
    return _tidy(outlet, parse_feed(r.text, outlet, origin="search")[:10])


def _searches(f: _Fetcher, items: List[dict], old: dict, now: datetime) -> Tuple[dict, List[dict]]:
    """Recherche les items (expos d'abord) chez les médias à moteur de recherche.

    Résultats gardés 3 jours ; ordre : jamais cherchés, puis les plus vieux.
    Un site par fil (≥ 1 s entre ses requêtes), plusieurs sites en parallèle.
    """
    searches = {k: v for k, v in old.get("searches", {}).items()
                if now.timestamp() - v.get("at", 0) < _WINDOW_DAYS * 86400}
    queries = []
    house_queries = []      # « Tosca Staatsoper Linden » : klassik-begeistert seulement
    for it in sorted(items, key=lambda i: i.get("kind") != "expo"):
        house = _SEARCH_HOUSE.get(it.get("venue", ""))
        for t in [it.get("title", "")] + list(it.get("aliases") or []):
            q = search_query(t)
            if q and q not in queries:
                queries.append(q)
            if house and q and f"{q} {house}" not in house_queries:
                house_queries.append(f"{q} {house}")
    engines: Dict[str, Callable[[str], Optional[List[dict]]]] = {
        o: (lambda q, o=o: _search_wp(f, o, q)) for o in _WP_SEARCH}
    engines[MONOPOL] = lambda q: _search_monopol(f, q)
    engines["taz"] = lambda q: _search_taz(f, q)
    found: List[dict] = []
    lock = threading.Lock()

    def run(outlet: str) -> None:
        mine = (house_queries + queries) if outlet == KB else queries   # sort stable : maisons d'abord
        todo = sorted(mine, key=lambda q: searches.get(f"{outlet}|{q}", {}).get("at", 0))
        for q in todo:
            k = f"{outlet}|{q}"
            if now.timestamp() - searches.get(k, {}).get("at", 0) < _SEARCH_TTL_DAYS * 86400:
                continue
            if f.remaining() < _RESERVE + _REQ_TIMEOUT:
                return
            res = engines[outlet](q)
            if res is None:          # > 8 s ou erreur : réessai au prochain run
                continue
            with lock:
                searches[k] = {"at": now.timestamp(), "urls": [a["url"] for a in res]}
                found.extend(res)

    with ThreadPoolExecutor(max_workers=len(engines)) as pool:
        list(pool.map(run, engines))
    return searches, found


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
def _load(path: Path = _CACHE_PATH) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        data = {}
    data.setdefault("articles", [])
    data.setdefault("sources", {})
    data.setdefault("searches", {})
    for a in data["articles"]:
        # règle « sélection » appliquée aussi aux listes déjà en cache
        if a.get("outlet") == BERLINER and a.get("entries"):
            a["is_pick"] = bool(a.get("tagged_pick")) or bool(
                _PICK_LIST_RE.search(f'{a.get("headline", "")} {a.get("match", "")}'))
    return data


_cache: Optional[dict] = None
_cache_mtime = 0.0


def _cached(path: Path = _CACHE_PATH) -> dict:
    global _cache, _cache_mtime
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    if _cache is None or mtime != _cache_mtime:
        _cache, _cache_mtime = _load(path), mtime
    return _cache


def _merge(old: List[dict], new: List[dict]) -> List[dict]:
    """Par URL ; une version plus riche (entrées, étoiles, date) l'emporte."""
    by_url: Dict[str, dict] = {a["url"]: a for a in old}
    for a in new:
        prev = by_url.get(a["url"])
        if prev and prev.get("origin") in ("rest", "sitemap") and a.get("origin") == "search":
            continue
        if prev and not a.get("date"):
            a = {**a, "date": prev.get("date", "")}
        if prev and prev.get("enriched") and not a.get("dek"):
            a = {**a, **{k: prev[k] for k in ("dek", "headline", "stars", "enriched") if k in prev}}
        by_url[a["url"]] = a
    return list(by_url.values())


def load_items(path: Optional[str] = None) -> List[dict]:
    """Items à chercher : --items (export wrangler --json ou liste) ou state/press_items.json."""
    p = Path(path) if path else _ITEMS_PATH
    try:
        raw = json.loads(p.read_text())
    except (OSError, ValueError):
        return []
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "results" in raw[0]:
        raw = raw[0]["results"]
    return [i for i in raw if isinstance(i, dict) and i.get("title")]


def refresh(path: Path = _CACHE_PATH, budget: float = _BUDGET,
            items: Optional[List[dict]] = None) -> dict:
    """Reconstruit le cache. Une source en échec garde ses anciens articles."""
    f = _Fetcher(budget)
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=_WINDOW_DAYS)
    cutoff = since.date().isoformat()
    search_cutoff = (now - timedelta(days=_SEARCH_WINDOW_DAYS)).date().isoformat()
    old = _load(path)
    old_by_outlet: Dict[str, List[dict]] = {}
    for a in old["articles"]:
        old_by_outlet.setdefault(a["outlet"], []).append(a)

    jobs: Dict[str, Callable[[], Optional[List[dict]]]] = {
        BERLINER: lambda: _berliner(f, since),
        TIP: lambda: _tip(f, since),
    }
    for outlet, urls in _FEEDS.items():
        jobs[f"{outlet} (RSS)"] = (lambda o=outlet, u=urls: _feeds(f, o, u))
    months_done: Dict[str, List[str]] = dict(old.get("sitemap_months", {}))
    # phrases d'items assez précises pour filtrer une sitemap sans rubrique
    item_phrases = sorted({ph for it in (items or []) for t in [it.get("title", "")] + list(it.get("aliases") or [])
                           for ph in _phrases(t) if _strong(ph) or ph in _artist_phrases(t)})
    monthly_new: Dict[str, List[str]] = {}

    def monthly_job(o: str) -> Optional[List[dict]]:
        res = _monthly(f, o, since, months_done.get(o, []), item_phrases)
        if res is None:
            return None
        arts, newly = res
        monthly_new[o] = newly
        return arts
    for outlet in _MONTHLY_SITEMAPS:
        jobs[f"{outlet} (sitemap)"] = (lambda o=outlet: monthly_job(o))

    results: Dict[str, Tuple[Optional[List[dict]], float]] = {}

    def run(name: str) -> None:
        t0 = time.monotonic()
        try:
            got = jobs[name]()
        except Exception as exc:  # noqa: BLE001
            f._note(f"{name}: {type(exc).__name__}: {exc}")
            got = None
        results[name] = (got, time.monotonic() - t0)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(run, jobs))

    sources = dict(old.get("sources", {}))
    fresh: Dict[str, List[dict]] = {}
    for name, (got, secs) in results.items():
        outlet = name.replace(" (RSS)", "").replace(" (sitemap)", "")
        if got is None:
            sources[name] = {**sources.get(name, {}), "ok": False, "last_try": now.isoformat(timespec="seconds")}
        else:
            fresh.setdefault(outlet, []).extend(got)
            sources[name] = {"ok": True, "at": now.isoformat(timespec="seconds"),
                             "count": len(got), "seconds": round(secs, 1)}

    searches = old.get("searches", {})
    found: List[dict] = []
    if items:
        searches, found = _searches(f, items, old, now)
        sources["search"] = {"ok": True, "at": now.isoformat(timespec="seconds"),
                             "queries": len(searches), "results": len(found)}

    articles: List[dict] = []
    outlets = set(old_by_outlet) | set(fresh) | {a["outlet"] for a in found}
    for outlet in outlets:
        prev = old_by_outlet.get(outlet, [])
        new = fresh.get(outlet)
        if outlet in (BERLINER, TIP) and new is not None:
            # source exhaustive : on remplace (en gardant les résultats de recherche)
            prev = [a for a in prev if a.get("origin") == "search"]
        merged = _merge(prev, (new or []) + [a for a in found if a["outlet"] == outlet])
        articles += [a for a in merged if not a.get("date") or a["date"] >= cutoff
                     or (a.get("origin") == "search" and a["date"] >= search_cutoff)]
    articles.sort(key=lambda a: (a["outlet"], a.get("date", ""), a["url"]), reverse=True)
    for o, newly in monthly_new.items():
        months_done[o] = sorted(set(months_done.get(o, [])) | set(newly))
    data = {"version": 3, "refreshed_at": now.isoformat(timespec="seconds"),
            "window_days": _WINDOW_DAYS, "sources": sources, "log": [],
            "searches": searches, "sitemap_months": months_done, "articles": articles}
    _write(path, data)
    if items:
        n = _enrich(f, path, items)
        data = _load(path)
        data["sources"]["enrich"] = {"ok": True, "at": now.isoformat(timespec="seconds"), "pages": n}
    data["log"] = f.log[-40:]
    _write(path, data)
    return data


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True))
    tmp.replace(path)


def _enrich(f: _Fetcher, path: Path, items: List[dict]) -> int:
    """Chapô + date des articles qui correspondent à un item mais n'ont qu'un slug
    ou un titre (sitemaps, recherches) : une page par article, une seule fois."""
    data = _load(path)
    by_url = {a["url"]: a for a in data["articles"]}
    todo: List[str] = []
    for it in items:
        for h in press_hits(it.get("kind", ""), it.get("venue", ""), it.get("title", ""),
                            it.get("url", ""), path, it.get("aliases") or ()):
            a = by_url.get(h["url"])
            if (a and a["outlet"] in _ENRICHABLE and not a.get("dek") and not a.get("enriched")
                    and a["url"] not in todo):
                todo.append(a["url"])
    done = 0
    for u in todo[:_ENRICH_MAX]:
        if f.remaining() < _RESERVE + _REQ_TIMEOUT:
            break
        meta = _page_meta(f, u)
        if meta is None:
            continue
        a = by_url[u]
        a["enriched"] = True
        a["dek"] = meta["dek"] or a.get("dek", "")
        if meta["headline"]:
            a["headline"] = re.sub(r"\s*[|–-]\s*(taz|Tagesspiegel|Berliner Zeitung|Monopol).*$", "",
                                   meta["headline"])[:200]
        a["date"] = a.get("date") or meta["date"]
        a["stars"] = a.get("stars") or parse_stars(a["dek"])
        a["venues"] = _venues_in(_key(" ".join([a["headline"], a["dek"], a.get("match", "")])))
        done += 1
    _write(path, data)
    global _cache
    _cache = None
    return done


# ---------------------------------------------------------------------------
# Correspondance item <-> articles
# ---------------------------------------------------------------------------
_GENERIC = {"exhibition", "ausstellung", "guided tour", "fuehrung", "hamlet", "faust",
            "collection", "sammlung", "night", "berlin", "the", "die", "der", "das",
            "photographs", "recent painting from berlin", "exit"}


def _phrases(title: str, url: str = "") -> List[str]:
    """« Lovis Corinth — Then Came Berlin! » -> [complet, lovis corinth, then came berlin]."""
    title = title.strip(" []")
    parts = [title]
    m = re.match(r"^(.*?)\s*\((.*?)\)\s*$", title)
    if m:
        parts += [m.group(1), m.group(2)]
    for p in list(parts):
        parts += re.split(r"\s+[—–-]\s+|:\s+|\.\s+|,\s+|\s+/\s+", p)
    for p in list(parts):
        parts.append(re.sub(r"^.*?\b(commission|presents?|zeigt)\b\s*", "", p, flags=re.I))
    if url:
        slug = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
        slug = re.sub(r"\.html?$|-\d+$", "", slug)
        if len(slug) >= 6 and not slug.isdigit():
            parts.append(slug.replace("-", " "))
    out = []
    for p in parts:
        k = _key(p)
        if len(k) >= 3 and k not in _GENERIC:
            out.append(k)
    return list(dict.fromkeys(out))


def _artist_phrases(title: str) -> set:
    """Le nom d'artiste seul (« Katharina Sieverding », « Christoph Schlingensief ») :
    l'artiste expose ailleurs aussi, donc il faut que le lieu soit nommé."""
    t = title.strip(" []")
    parts = re.split(r"\s+[—–]\s+|\.\s+|:\s+", t)
    head = re.sub(r"^.*?\b(commission|presents?)\b\s*", "", parts[0], flags=re.I)
    out = {_key(head)}
    if len(parts) == 1 and not re.fullmatch(r"(?:[A-ZÄÖÜ][\w’'\-]+\s?){2,3}", t.strip()):
        return set()           # « Ruin and Rush » : un titre, pas un nom
    if len(parts) == 1:
        out.add(_key(t))
    return {k for k in out if k}


def _strong(phrase: str) -> bool:
    """Assez spécifique pour matcher sans que le lieu soit nommé ?"""
    return len(phrase.split()) >= 2 and len(phrase) >= 12


def _match_unit(phrases: List[str], unit_text: str, unit_venues: List[str],
                item_venue_keys: Tuple[str, ...], item_venue: str, require_venue: bool = False,
                weak: Iterable[str] = ()) -> bool:
    venue_named = any(_contains(unit_text, a) for a in item_venue_keys) or any(
        set(_venue_keys(v)) == set(item_venue_keys) for v in unit_venues)
    if venue_named and _foreign_house(item_venue, unit_text):
        return False           # « Tosca » à la Wiener Staatsoper, pas Unter den Linden
    other_venue_only = bool(unit_venues) and not venue_named
    for ph in phrases:
        if not _contains(unit_text, ph):
            continue
        if other_venue_only:
            continue           # « Christoph Schlingensief » … au Gropius Bau : autre expo
        if (require_venue or ph in weak) and not venue_named:
            continue           # « Hamlet », « De Profundis », un nom d'artiste seul : il y en a partout
        if _strong(ph) or (venue_named and len(ph) >= 4):
            return True
    return False


def press_hits(kind: str, venue: str, title: str, url: str = "",
               cache_path: Path = _CACHE_PATH, aliases: Iterable[str] = ()) -> List[dict]:
    """Articles qui parlent de l'item (cache seul ; débogage : avec URL).

    aliases : autres titres (titre allemand « Ruin und Rausch »…).
    Pièces et articles non datés : le lieu doit être nommé.
    """
    data = _cached(cache_path)
    phrases = list(dict.fromkeys(_phrases(title, url) + [p for a in aliases for p in _phrases(a)]))
    weak = _artist_phrases(title) if kind == "expo" else set()
    vkeys = _venue_keys(venue)
    hits: Dict[Tuple[str, str], dict] = {}
    for a in data["articles"]:
        if kind == "film" and a["outlet"] == TIP and a.get("section") != "film":
            continue
        if _ROUNDUP_RE.search(a.get("headline", "")):
            continue
        # klassik-begeistert : le titre nomme l'œuvre ET la maison (« Puccini, Tosca …
        # Deutsche Oper Berlin, 29. September 2026 ») ; le chapô cite d'autres rôles
        # et œuvres (« Carmen ») : on ne matche que titre + URL.
        dek = "" if a["outlet"] == KB else _key(a.get("dek", ""))
        text = " ".join([_key(a.get("headline", "")), dek, a.get("match", "")]
                        + [_key(s) for s in a.get("subjects", [])])
        need_venue = kind == "theatre" or not a.get("date")
        if not a.get("entries"):
            if _match_unit(phrases, text, a.get("venues", []), vkeys, venue, need_venue, weak):
                hits[(a["url"], "")] = {k: a.get(k) for k in
                                        ("outlet", "url", "date", "headline", "dek", "stars", "is_pick")}
                hits[(a["url"], "")]["section"] = ""
            continue
        for e in a["entries"]:
            if _match_unit(phrases, _key(e["name"]), e.get("venues", []), vkeys, venue, kind == "theatre", weak):
                hits[(a["url"], e["name"])] = {
                    "outlet": a["outlet"], "url": a["url"], "date": a["date"],
                    "headline": e["name"], "dek": "", "stars": None,
                    "is_pick": bool(a.get("is_pick")) or e.get("section") == "hits",
                    "section": e.get("section", ""), "list": a["headline"],
                }
                break
    return sorted(hits.values(), key=lambda h: h.get("date") or "", reverse=True)


# ---------------------------------------------------------------------------
# Le « buzz » : un signal unique, mélangé
# ---------------------------------------------------------------------------
LEVELS = {
    "enthusiastic": ("🔥", "enthusiastic", "enthousiaste"),
    "positive": ("👍", "positive", "plutôt positif"),
    "mixed": ("😐", "mixed", "mitigé"),
    "negative": ("👎", "negative", "plutôt négatif"),
}
_MIN_WEIGHT = 0.5
_GIVEAWAY_RE = re.compile(r"verlost|gewinnspiel|gewinnen|giveaway|win tickets|/gewinnspiele/", re.I)        # en dessous : pas de verdict (simple mention)
_MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
_MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _signals(hit: dict) -> List[Tuple[float, float]]:
    """[(score [-1,1], poids)] d'un article."""
    if _GIVEAWAY_RE.search(f'{hit.get("headline", "")} {hit.get("url", "")}'):
        return []                      # « Monopol verlost 2 Karten für… » : pas un avis
    sig = []
    if hit.get("stars") is not None:
        sig.append(((hit["stars"] - 3.0) / 2.0, 1.0))
    if hit.get("section") == "misses":
        sig.append((-0.6, 0.8))
    elif hit.get("section") == "hits":
        sig.append((0.6, 0.8))
    elif hit.get("is_pick"):
        sig.append((0.4, 0.6))          # dans une sélection : « plutôt positif »
    s, w = text_score(f'{hit.get("headline", "")}. {hit.get("dek", "")}')
    if w and abs(s) >= 0.25:
        sig.append((s * 0.8, 0.5))      # le lexique est moins fiable qu'une note : atténué
    return sig


def _level(score: float) -> str:
    if score >= 0.55:
        return "enthusiastic"
    if score >= 0.2:
        return "positive"
    if score >= -0.3:          # 2.5/5 = -0.25 : « mitigé », pas « négatif »
        return "mixed"
    return "negative"


def _nachtkritik(kind: str, venue: str, title: str, url: str):
    if kind != "theatre":
        return None
    try:
        from .critics import fetch_rating     # offline=True : cache seul, aucune écriture
        return fetch_rating(venue, title, url, offline=True)
    except Exception:  # noqa: BLE001
        return None


def _as_date(opens) -> Optional[date]:
    if opens is None or opens == "":
        return None
    if isinstance(opens, datetime):
        return opens.date()
    if isinstance(opens, date):
        return opens
    try:
        return datetime.fromisoformat(str(opens)[:10]).date()
    except ValueError:
        return None


def press_for(kind: str, venue: str, title: str, url: str = "", opens=None,
              cache_path: Path = _CACHE_PATH, use_nachtkritik: bool = True,
              today: Optional[date] = None, aliases: Iterable[str] = ()) -> dict:
    """Buzz presse d'un item, depuis les caches uniquement (aucun réseau).

    status :
      "verdict"  -> level / level_fr (« 👍 positive »), basis (« 2 sources »), example
      "covered"  -> des articles, mais aucun indice évaluatif net
      "not_open" -> rien encore, ouverture future (opens) : « reviews from 28 Nov »
      "none"     -> rien trouvé (« no reviews yet »)
    hits : articles trouvés (avec URL, pour déboguer — à ne pas afficher).
    """
    try:
        hits = press_hits(kind, venue, title, url, cache_path, aliases)
    except Exception:  # noqa: BLE001 — bonus, jamais bloquant
        hits = []
    d_open = _as_date(opens)
    if d_open and d_open > (today or date.today()) and not any(h.get("stars") is not None for h in hits):
        # pas encore ouvert : une annonce ou une liste « à venir » n'est pas une critique
        return {"status": "not_open", "key": None, "level": None, "level_fr": None, "basis": "",
                "basis_fr": "", "score": None, "sources": [], "covered_by": sorted({h["outlet"] for h in hits}),
                "example": None, "opens": d_open.isoformat(), "hits": hits}
    weighted: List[Tuple[float, float, str]] = []
    example = None
    for h in hits:
        sig = _signals(h)
        weighted += [(s, w, h["outlet"]) for s, w in sig]
    nk = _nachtkritik(kind, venue, title, url) if use_nachtkritik else None
    if nk is not None:
        weighted.append(((nk.stars - 3.0) / 2.0, 1.5, NACHTKRITIK))
    covered = sorted({h["outlet"] for h in hits} | ({NACHTKRITIK} if nk else set()))
    total_w = sum(w for _, w, _ in weighted)
    result = {"status": "none", "key": None, "level": None, "level_fr": None,
              "basis": "", "basis_fr": "", "score": None, "sources": [],
              "covered_by": covered, "example": None, "opens": None, "hits": hits}

    if total_w >= _MIN_WEIGHT:
        score = sum(s * w for s, w, _ in weighted) / total_w
        key = _level(score)
        emoji, en, fr = LEVELS[key]
        sources = sorted({o for _, _, o in weighted})
        n = len(sources)
        # exemple : le fragment le plus net allant dans le sens du verdict
        best = 0.0
        for h in hits:
            frag = verdict_fragment(h.get("headline", ""), h.get("dek", ""))
            if not frag:
                continue
            s, w = text_score(frag)
            if (s > 0) == (score > 0) and w > best:
                best, example = w, {"text": frag, "outlet": h["outlet"]}
        result.update(status="verdict", key=key, level=f"{emoji} {en}", level_fr=f"{emoji} {fr}",
                      basis=f"{n} source{'s' if n > 1 else ''}", basis_fr=f"{n} source{'s' if n > 1 else ''}",
                      score=round(score, 3), sources=sources, example=example)
        return result
    if hits:
        n = len(covered)
        result.update(status="covered", basis=f"{n} source{'s' if n > 1 else ''}",
                      basis_fr=f"{n} source{'s' if n > 1 else ''}")
    return result


def buzz_line(kind: str, venue: str, title: str, url: str = "", lang: str = "fr",
              opens=None, cache_path: Path = _CACHE_PATH, with_example: bool = True,
              aliases: Iterable[str] = ()) -> str:
    """Ligne prête pour la carte, sans lien.

    fr : « 📰 Buzz : 👍 plutôt positif (2 sources) · ex. « klein, aber sehr lohnend » (Jüdische Allgemeine) »
    en : « 📰 Buzz: 👍 positive (2 sources) · e.g. “klein, aber sehr lohnend” (Jüdische Allgemeine) »
    """
    b = press_for(kind, venue, title, url, opens=opens, cache_path=cache_path, aliases=aliases)
    return format_buzz(b, lang, with_example)


def format_buzz(b: dict, lang: str = "fr", with_example: bool = True) -> str:
    fr = lang == "fr"
    if b["status"] == "verdict":
        line = (f"📰 Buzz : {b['level_fr']} ({b['basis_fr']})" if fr
                else f"📰 Buzz: {b['level']} ({b['basis']})")
        ex = b.get("example")
        if with_example and ex:
            line += (f" · ex. « {ex['text']} » ({ex['outlet']})" if fr
                     else f" · e.g. “{ex['text']}” ({ex['outlet']})")
        return line
    # « couvert sans avis », « pas encore ouvert », « pas de critiques » : rien
    # d'utile pour la lectrice -> pas de ligne du tout (règle : zéro remplissage).
    return ""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _report(items: Iterable[dict], lang: str, verbose: bool = True) -> None:
    from collections import Counter
    stats: Counter = Counter()
    n = 0
    for it in items:
        n += 1
        b = press_for(it["kind"], it["venue"], it["title"], it.get("url", ""), opens=it.get("opens"),
                      aliases=it.get("aliases") or ())
        stats[b["status"]] += 1
        print(f"- [{it['kind']}] {it['venue']} — {it['title']}\n    {format_buzz(b, lang)}")
        if verbose:
            for h in b["hits"]:
                star = f" ★{h['stars']:g}" if h.get("stars") is not None else ""
                pick = " pick" if h.get("is_pick") else ""
                sec = f" [{h['section']}]" if h.get("section") else ""
                print(f"      · {h['outlet']}{star}{pick}{sec} {h.get('date') or '?'} {h['url']}")
    print(f"\n{n} items : " + ", ".join(f"{k} {v}" for k, v in stats.most_common()))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Buzz presse (cache state/press_cache.json).")
    ap.add_argument("--refresh", action="store_true", help="reconstruit le cache (réseau, ≤ 5 min)")
    ap.add_argument("--items", help="items JSON (export wrangler d1 --json ou liste) : recherche + rapport")
    ap.add_argument("--report", action="store_true", help="affiche le buzz des items (--items)")
    ap.add_argument("--lang", default="fr", choices=("fr", "en"))
    ap.add_argument("--budget", type=float, default=_BUDGET)
    args = ap.parse_args(argv)
    items = load_items(args.items)
    if args.refresh:
        t0 = time.monotonic()
        data = refresh(budget=args.budget, items=items)
        for name, s in sorted(data["sources"].items()):
            print(f"{name}: {s}")
        for line in data["log"]:
            print("  ·", line)
        print(f"{len(data['articles'])} articles en cache ({time.monotonic() - t0:.0f} s).")
    if args.report and items:
        _report(items, args.lang)
    if not args.refresh and not args.report:
        ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
