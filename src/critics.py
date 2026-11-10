"""Estimation de la note presse d'une pièce à partir de nachtkritik.de.

Sous chaque critique, Nachtkritik publie une « Kritikenrundschau » : un
paragraphe par journal (SZ, FAZ, taz, Tagesspiegel…) qui résume l'avis du
critique, souvent avec des citations. Il n'y a PAS de note chiffrée : on
l'estime donc, sans LLM, avec un petit lexique allemand pondéré.

C'est volontairement une *estimation* : elle distingue bien « Theatercoup » de
« zähe dreieinhalb Stunden », beaucoup moins bien l'ironie ou les avis très
partagés. D'où l'affichage de la répartition 👍/😐/👎 à côté des étoiles.

    rubrique Nachtkritik du théâtre (ou, à défaut, recherche titre + théâtre)
      → page de la critique → paragraphes de la Kritikenrundschau → score par critique → moyenne ★
"""
from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlencode, urlparse

from bs4 import BeautifulSoup

from .fetch import fetch_html

_BASE = "https://nachtkritik.de"
_MIN_CRITICS = 2          # en dessous, une « moyenne » n'a pas de sens
_PAUSE = 1.0              # entre deux requêtes, par politesse
_TIMEOUT = 60.0           # la recherche Nachtkritik met 5 à 30+ secondes


@dataclass
class CriticsRating:
    stars: float              # 1.0 – 5.0, au demi-point
    count: int                # nb de critiques notées
    positive: int
    mixed: int
    negative: int
    url: str                  # critique Nachtkritik (ancre sur la Rundschau)

    def star_bar(self) -> str:
        full = int(self.stars)
        half = self.stars - full >= 0.5
        return "★" * full + ("½" if half else "") + "☆" * (5 - full - half)

    def label(self, lang: str = "fr") -> str:
        """« ★★★½☆ 3,5/5 · 8 critiques (👍4 😐3 👎1) » (en : « 3.5/5 · 8 reviews »)."""
        split = f"👍{self.positive} 😐{self.mixed} 👎{self.negative}"
        if lang == "en":
            n = self.count
            return f"{self.star_bar()} {self.stars:g}/5 · {n} review{'s' if n > 1 else ''} ({split})"
        note = f"{self.stars:g}".replace(".", ",")
        return f"{self.star_bar()} {note}/5 · {self.count} critiques ({split})"


# ---------------------------------------------------------------------------
# Lexique (radicaux en minuscules ; on matche le début des mots, donc
# « überzeug » couvre überzeugt / überzeugend / überzeugende…)
# ---------------------------------------------------------------------------
_POSITIVE = {
    "großartig": 2, "grandios": 2, "brillant": 2, "meisterhaft": 2,
    "meisterwerk": 2, "exzellent": 2, "herausragend": 2, "hinreißend": 2,
    "fulminant": 2, "famos": 2, "bravourös": 2, "triumph": 2, "chapeau": 2,
    "begeister": 2, "glänzend": 1.5, "theatercoup": 2, "coup": 1.5,
    "mitreiß": 1.5, "mitgerissen": 1.5, "beeindruck": 1.5, "eindrucksvoll": 1.5,
    "berührend": 1.5, "berührt": 1, "fesselnd": 1.5, "packend": 1.5,
    "faszinier": 1.5, "wunderbar": 1.5, "toll": 1.5, "sehenswert": 1.5,
    "virtuos": 1.5, "gelungen": 1.5, "gelingt": 1, "überzeug": 1,
    "eindringlich": 1, "intensiv": 1, "präzise": 1, "klug": 1, "witzig": 1,
    "unterhaltsam": 1, "unterhalten": 0.5, "kurzweilig": 1, "stimmig": 1,
    "souverän": 1, "lohnt": 1.5, "lohnend": 1.5, "stark": 0.5, "starke": 1,
    "jubel": 1.5, "bejubelt": 1.5, "wahnsinn": 1, "hit": 1, "glück": 1,
    "großes theater": 2, "bildmächtig": 1.5, "beglückend": 2, "furios": 2,
    "funkeln": 1, "fein": 0.5, "zauber": 1, "atemberaubend": 2, "bestechend": 1.5,
}
_NEGATIVE = {
    "zäh": 2, "langweil": 2, "langeweile": 2, "langatmig": 2, "ermüd": 2,
    "quälend": 2, "öde": 2, "ärger": 1.5, "misslung": 2, "misslingt": 2,
    "missglück": 2, "scheitert": 2, "gescheitert": 2, "enttäusch": 2,
    "belanglos": 2, "uninspiriert": 2, "banal": 1.5, "unerheblich": 1.5,
    "schwach": 1.5, "flach": 1.5, "oberflächlich": 1.5, "plakativ": 1.5,
    "platt": 1.5, "bieder": 1.5, "überflüssig": 1.5, "substanzlos": 1.5,
    "verschenkt": 1.5, "holzschnitt": 1.5, "prätentiös": 1.5, "peinlich": 1.5,
    "nervt": 1.5, "nervig": 1.5, "zieht sich": 1.5, "zog sich": 1.5,
    "kitsch": 1, "harmlos": 1, "schmal": 1, "dünn": 1, "länglich": 1,
    "einwand": 1, "einwände": 1, "schade": 1, "leider": 1, "ratlos": 1,
    "überladen": 1, "redundant": 1, "fehlt": 0.75, "mangelt": 1,
    "problematisch": 1, "behäbig": 1.5, "lahm": 1.5, "durchhänger": 1.5,
    "leerlauf": 1.5, "beliebig": 1.5, "zerfasert": 1.5, "kalt": 0.5,
    "in sich zusammen": 2, "schieflage": 1.5, "grotesk": 1, "klischee": 1,
    "nicht retten": 2, "nicht ergiebig": 1.5, "nicht gerecht": 0,
}
_NEGATORS = {"nicht", "kein", "keine", "keinen", "keinem", "keiner", "kaum", "wenig", "nie"}
# Après ces mots, l'avis « final » du critique : on pondère plus fort.
_TURNS = {"aber", "doch", "dennoch", "trotzdem", "allerdings", "immerhin", "fazit", "jedoch"}


def _words(text: str) -> List[str]:
    return re.findall(r"[a-zäöüß]+", text.lower())


def _score(text: str) -> float:
    """Score d'un paragraphe de critique, dans [-1, 1]."""
    low = text.lower()
    total = weight_sum = 0.0

    # Expressions de plusieurs mots d'abord (et on les retire du texte).
    for lexicon, sign in ((_POSITIVE, 1), (_NEGATIVE, -1)):
        for term, w in lexicon.items():
            if " " in term and term in low:
                n = low.count(term)
                total += sign * w * n
                weight_sum += w * n
                low = low.replace(term, " ")

    words = _words(low)
    boost = 1.0
    for i, word in enumerate(words):
        if word in _TURNS:
            boost = 1.4
            continue
        for lexicon, sign in ((_POSITIVE, 1), (_NEGATIVE, -1)):
            hit = next((w for t, w in lexicon.items() if " " not in t and word.startswith(t)), None)
            if hit is None:
                continue
            if any(w in _NEGATORS for w in words[max(0, i - 3):i]):
                sign = -sign * 0.7        # « nicht überzeugend », « keine Langeweile »
            total += sign * hit * boost
            weight_sum += hit * boost
            break

    if weight_sum == 0:
        return 0.0
    # +1 au dénominateur : un seul mot positif ne fait pas un 5/5.
    return total / (weight_sum + 1.0)


def _to_stars(score: float) -> float:
    return 1.0 + 2.0 * (score + 1.0)      # [-1, 1] -> [1, 5]


# ---------------------------------------------------------------------------
# Cache (state/critics_cache.json)
#
# La recherche Nachtkritik met 5 à 30+ s et time-oute régulièrement : sans
# cache, un même spectacle avait une note un jour et pas le lendemain. On
# mémorise donc, avec une durée de vie :
#   - les listes de critiques par théâtre (rubrique Nachtkritik de la maison),
#   - les résultats de recherche (repli pour les titres absents des listes),
#   - la note de chaque critique (la Rundschau s'étoffe les jours qui suivent
#     la première : on relit souvent une critique récente, rarement une vieille).
# Un échec réseau n'est JAMAIS mis en cache : il sera retenté au passage
# suivant. Un « pas de critique » ne l'est que brièvement (une critique paraît
# le lendemain de la première).
# ---------------------------------------------------------------------------
_CACHE_PATH = Path(__file__).resolve().parent.parent / "state" / "critics_cache.json"
_HOUR = 3600
_DAY = 24 * _HOUR
_LISTING_PAGES = 4            # 4 × 39 critiques ≈ 10-15 ans de répertoire
_LISTING_TTL_FIRST = 6 * _HOUR    # 1re page : les nouvelles critiques
_LISTING_TTL_OLDER = 30 * _DAY    # pages suivantes : quasi figées
_SEARCH_TTL = 3 * _DAY
_REVIEW_TTL_YOUNG = 12 * _HOUR    # critique < 30 j : la Rundschau grossit encore
_REVIEW_TTL_OLD = 60 * _DAY
_EXPIRE = 120 * _DAY              # ménage : entrées plus vieilles que ça

_lock = threading.RLock()
_cache: Optional[dict] = None
_slug_locks: Dict[str, threading.Lock] = {}


def _now() -> float:
    return time.time()


def _load_cache() -> dict:
    global _cache
    with _lock:
        if _cache is None:
            try:
                _cache = json.loads(_CACHE_PATH.read_text())
            except (OSError, ValueError):
                _cache = {}
            for section in ("listings", "searches", "reviews"):
                _cache.setdefault(section, {})
            # ménage des entrées trop vieilles
            for section in ("searches", "reviews"):
                old = [k for k, v in _cache[section].items() if _now() - v.get("at", 0) > _EXPIRE]
                for k in old:
                    del _cache[section][k]
        return _cache


def _save_cache() -> None:
    with _lock:
        if _cache is None:
            return
        try:
            _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = _CACHE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(_cache, ensure_ascii=False, indent=1, sort_keys=True))
            tmp.replace(_CACHE_PATH)
        except OSError as exc:
            print(f"   ⚠️  cache Nachtkritik non écrit : {exc}")


def _fresh(entry: Optional[dict], ttl: float) -> bool:
    return bool(entry) and _now() - entry.get("at", 0) < ttl


def _get(url: str, timeout: float = _TIMEOUT, attempts: int = 3) -> str:
    """fetch_html avec quelques nouvelles tentatives (timeouts, 5xx, 429)."""
    for attempt in range(attempts):
        try:
            return fetch_html(url, timeout=timeout)
        except Exception:  # noqa: BLE001
            if attempt == attempts - 1:
                raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


# ---------------------------------------------------------------------------
# Normalisation et correspondance des titres
# ---------------------------------------------------------------------------
_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def _key(text: str) -> str:
    """Clé de comparaison : minuscules, sans accents ni ponctuation.

    « Die Affäre Rue de Lourcine » == « die-affaere-rue-de-lourcine » (slug).
    """
    text = unicodedata.normalize("NFKC", text).casefold().translate(_FOLD)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("&", " und ")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = re.sub(r"[\"'„“”‚‘’«»#!?]", "", text)
    return re.sub(r"\s+", " ", text).strip(" .:–-")


def _title_variants(title: str, url: str = "") -> List[str]:
    """Formes possibles du titre allemand sur Nachtkritik.

    « Die Wildente (The Wild Duck) » -> [complet, Die Wildente, The Wild Duck] ;
    « The Last Sky: My Search… (Der letzte Himmel) » -> + « The Last Sky » ;
    « The Miser » + URL …/der-geizige.html -> + « der geizige » (les pages /en/
    des théâtres gardent souvent le slug allemand).
    """
    variants = [title]
    m = re.match(r"^(.*?)\s*\((.*?)\)\s*$", title)
    if m:
        variants += [m.group(1), m.group(2)]
    for v in list(variants):
        # sous-titre (« X: Y », « X – Y ») et suffixe « by / von / nach X »
        variants.append(re.split(r"\s*[:–—]\s+|\s+-\s+", v)[0])
        variants.append(re.split(r"\s+(?:by|von|nach|after)\s+[A-ZÄÖÜ]", v)[0])
    slug = _url_slug(url)
    if slug:
        variants.append(slug.replace("-", " "))
    out = [v.strip() for v in variants if len(_key(v)) >= 2]
    return list(dict.fromkeys(out))


def _url_slug(url: str) -> str:
    """Slug du spectacle dans l'URL du théâtre (« der-geizige », « tin-drum »)."""
    if not url:
        return ""
    path = urlparse(url).path.rstrip("/")
    parts = [p for p in path.split("/") if p]
    # Volksbühne : /en/productions/<slug>/<AAAAMMJJ-HHMM>/
    while parts and re.fullmatch(r"\d{8}-\d{4}", parts[-1]):
        parts.pop()
    if not parts:
        return ""
    slug = re.sub(r"\.html?$", "", parts[-1])
    slug = re.sub(r"-\d+$", "", slug)          # « im-herzen-der-gewalt-2 »
    slug = re.sub(r"^vb\d+-", "", slug)        # « vb04-alles-glueck-der-welt »
    return slug


def _title_matches(nk_title: str, variants: List[str]) -> bool:
    # « Bluets –\xa0Schaubühne Berlin – … » : espaces parfois insécables.
    head = re.split(r"\s+[–—-]\s+", unicodedata.normalize("NFKC", nk_title))[0]
    hk, hn = _key(head), _norm(head)
    for v in variants:
        vk, vn = _key(v), _norm(v)
        if hk == vk:
            return True
        # « Antigone. Der Abschied » pour « Antigone » : sous-titre ponctué
        if hn.startswith(vn + ". ") or hn.startswith(vn + ": "):
            return True
    return False


def _slug_matches(nk_url: str, slug: str, url_fragment: Optional[str]) -> bool:
    """« …/der-geizige-schaubuehne-berlin » commence par « der-geizige- » + théâtre."""
    if not slug or not url_fragment:
        return False
    last = nk_url.rstrip("/").rsplit("/", 1)[-1]
    return last == slug or last.startswith(f"{slug}-{url_fragment}")


# ---------------------------------------------------------------------------
# Où chercher : la rubrique du théâtre, puis la recherche plein texte
# ---------------------------------------------------------------------------
# Nom du théâtre dans le bot -> (mot ajouté à la recherche, fragment d'URL
# Nachtkritik, rubrique Nachtkritik de la maison). La critique peut avoir été
# écrite ailleurs (ex. création à Avignon) : le slug mentionne alors quand même
# la maison berlinoise. Festspiele : pas de contrainte (invités de partout).
_BERLIN = "/nachtkritiken/deutschland/berlin-brandenburg/berlin/"
_THEATERS = {
    "Schaubühne": ("Schaubühne", "schaubuehne", _BERLIN + "schaubuehne-berlin"),
    "Berliner Ensemble": ("Berliner Ensemble", "berliner-ensemble", _BERLIN + "berliner-ensemble"),
    "Volksbühne": ("Volksbühne", "volksbuehne", _BERLIN + "volksbuehne-am-rosa-luxemburg-platz-berlin"),
    # Festspiele : invités de partout, pas de contrainte de maison, mais une rubrique.
    "Berliner Festspiele": ("Berliner Festspiele", None, _BERLIN + "berliner-festspiele"),
}


def refresh_listings() -> int:
    """Télécharge (si périmées) les rubriques Nachtkritik de toutes les maisons.
    Job critics.yml seulement. Renvoie le nombre de critiques connues."""
    sections = dict.fromkeys(sec for _, _, sec in _THEATERS.values() if sec)
    return sum(len(_listing(sec)) for sec in sections)


def _parse_listing(html: str, section: str) -> List[dict]:
    """Critiques d'une page de rubrique : [{title, url, date}].

    Trois gabarits : la « une » (<h2>Titre - Théâtre</h2>), les vignettes
    secondaires (<h3>Titre - Théâtre</h3>) et la grille (.title).
    """
    soup = BeautifulSoup(html, "html.parser")
    items: Dict[str, dict] = {}
    for box in soup.select(".leading-0, .sec-item-content, .item-wrap"):
        a = box.find("a", href=lambda h: h and h.split("#")[0].startswith(section + "/"))
        el = box.select_one(".title a") or box.find(["h2", "h3"])
        if not a or not el:
            continue
        href = a["href"].split("#")[0]
        # « Stereophonic - Schaubühne Berlin » -> « Stereophonic »
        title = re.split(r"\s+[–—-]\s+", unicodedata.normalize("NFKC", el.get_text(" ", strip=True)))[0]
        date_el = box.select_one(".date, .text_datum")
        items.setdefault(href, {
            "title": title,
            "url": _BASE + href,
            "date": date_el.get_text(" ", strip=True) if date_el else "",
        })
    return list(items.values())


def _listing(section: str) -> List[dict]:
    """Toutes les critiques (récentes) de la rubrique d'un théâtre, en cache."""
    cache = _load_cache()
    with _lock:
        lock = _slug_locks.setdefault(section, threading.Lock())
    with lock:                       # un seul thread télécharge une rubrique
        pages = cache["listings"].setdefault(section, {})
        changed = False
        for i in range(_LISTING_PAGES):
            ttl = _LISTING_TTL_FIRST if i == 0 else _LISTING_TTL_OLDER
            entry = pages.get(str(i))
            if _fresh(entry, ttl):
                continue
            try:
                html = _get(f"{_BASE}{section}?start={39 * i}" if i else _BASE + section)
            except Exception:  # noqa: BLE001 — on garde l'ancienne version
                continue
            pages[str(i)] = {"at": _now(), "items": _parse_listing(html, section)}
            changed = True
            time.sleep(_PAUSE)
        if changed:
            _save_cache()
        return [it for i in range(_LISTING_PAGES) for it in pages.get(str(i), {}).get("items", [])]


def _search(query: str) -> Optional[List[tuple]]:
    """Résultats « nachtkritiken » d'une recherche : [(titre, url, date ISO)].

    None = la recherche a échoué (timeout…) : on ne met PAS en cache.
    """
    cache = _load_cache()
    with _lock:
        entry = cache["searches"].get(query)
    if _fresh(entry, _SEARCH_TTL):
        return [tuple(r) for r in entry["results"]]
    url = f"{_BASE}/index.php?" + urlencode({"option": "com_finder", "view": "search", "q": query})
    try:
        soup = BeautifulSoup(_get(url, attempts=2), "html.parser")
    except Exception:  # noqa: BLE001
        return None
    results = []
    for res in soup.select("#search-result-list .result"):
        a = res.select_one(".result-title a[href]")
        if not a or not a["href"].startswith("/nachtkritiken/"):
            continue
        date_el = res.select_one(".result__date")
        results.append((
            a.get_text(" ", strip=True),
            _BASE + a["href"],
            date_el.get("datetime", "") if date_el else "",
        ))
    with _lock:
        cache["searches"][query] = {"at": _now(), "results": results}
    _save_cache()
    return results


def _find_reviews(theater: str, title: str, url: str = "", offline: bool = False,
                  search: bool = True) -> Tuple[List[Tuple[str, bool]], bool]:
    """Critiques candidates, la meilleure d'abord : ([(url, sûre)], échec réseau ?).

    « sûre » = l'URL nomme la maison berlinoise. Sinon (création à Vienne,
    Avignon…), il faudra vérifier sur la page que le théâtre y est cité.
    """
    search_word, url_fragment, section = _THEATERS.get(theater, ("", None, None))
    variants = _title_variants(title, url)
    slug = _url_slug(url)

    # 1) La rubrique Nachtkritik du théâtre : rapide (pages en cache), exhaustive,
    #    et sans les caprices du classement de la recherche Joomla.
    if section:
        if offline:
            pages = _load_cache()["listings"].get(section, {})
            items = [it for p in pages.values() for it in p.get("items", [])]
        else:
            items = _listing(section)
        hits = [it["url"] for it in items
                if _title_matches(it["title"], variants) or _slug_matches(it["url"], slug, url_fragment)]
        if hits:
            return [(u, True) for u in dict.fromkeys(hits)], False   # rubrique : du plus récent au plus ancien
    if not search:
        return [], False

    # 2) Repli : la recherche plein texte (lente). Le titre complet « X (Y) » ne
    #    donne rien (tous les mots sont exigés). Et ajouter le nom du théâtre à
    #    la requête DÉGRADE le classement (« Call me Paris Schaubühne » ne trouve
    #    pas la critique) : on cherche le titre seul, et on ne retente avec le
    #    théâtre que pour les titres trop courants (« 1984 », « Hedda »…).
    slug_variant = slug.replace("-", " ") if slug else None
    named = [v for v in variants if v != slug_variant]
    queries = [v for v in named if v != title or len(named) == 1][:3] or variants[:1]
    queries += [f"{v} {search_word}" for v in queries[:2] if search_word]

    found: dict = {}
    failed = False
    for q in queries:
        if offline:
            entry = _load_cache()["searches"].get(q)
            results = [tuple(r) for r in entry["results"]] if entry else None
        else:
            results = _search(q)
        if results is None:
            failed = True
            continue
        for nk_title, nk_url, date in results:
            if _title_matches(nk_title, variants):
                sure = url_fragment is None or url_fragment in nk_url
                found[nk_url] = (sure, date)
        if any(sure for sure, _ in found.values()):
            break
    # sûres d'abord, puis les plus récentes
    ranked = sorted(found.items(), key=lambda kv: kv[1], reverse=True)
    return [(u, sure) for u, (sure, _) in ranked], failed


def _mentions_theater(html: str, theater: str) -> bool:
    """La fiche (générique) ou la Rundschau de la critique cite-t-elle le théâtre ?"""
    search_word, url_fragment, _ = _THEATERS.get(theater, ("", None, None))
    if url_fragment is None:
        return True
    soup = BeautifulSoup(html, "html.parser")
    # Pas tout le texte de la page : les encadrés « à lire aussi » citent
    # n'importe quel théâtre. Le générique (« Koproduktion der Salzburger
    # Festspiele mit dem Berliner Ensemble ») suffit : une coproduction créée
    # dans un festival partenaire est rangée sous ce festival chez Nachtkritik.
    blocks = soup.select(".text_besetzung")
    if not blocks:
        blocks = [p for p in soup.find_all("p") if p.find_previous(class_="text_rundschau")]
    text = " ".join(b.get_text(" ", strip=True) for b in blocks).lower()
    text += " " + " ".join(a.get("href", "") for b in blocks for a in b.find_all("a"))
    return search_word.lower() in text or url_fragment in text


def _rundschau_paragraphs(html: str) -> List[str]:
    soup = BeautifulSoup(html, "html.parser")
    # Selon l'ancienneté de l'article : <p class="text_rundschau"> ou
    # <p><span class="text_rundschau">.
    marker = soup.find(class_="text_rundschau")
    if not marker:
        return []
    if marker.name != "p":
        marker = marker.find_parent("p") or marker
    # Les <p> sont parfois frères du marqueur, parfois enveloppés dans des
    # <div> recopiés d'ailleurs : on suit donc l'ordre du document.
    paragraphs = []
    for para in marker.find_all_next("p", limit=40):
        if any(c.startswith("text_") for c in para.get("class", [])) or para.find("a", href="/spenden"):
            break                       # fin de la Rundschau (bloc dons, partage…)
        text = para.get_text(" ", strip=True)
        if len(text) > 60:
            paragraphs.append(text)
    return paragraphs


def _published(html: str) -> float:
    """Date de publication de la critique (epoch), 0 si introuvable.

    Les commentaires portent aussi un itemprop="datePublished" : la plus
    ancienne date est celle de l'article.
    """
    dates = []
    for raw in re.findall(r'datetime="([^"]+)"\s+itemprop="datePublished"', html):
        try:
            dates.append(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
        except ValueError:
            pass
    return min(dates, default=0.0)


def _review(url: str, theater: str, sure: bool, offline: bool) -> Optional[dict]:
    """Lecture (en cache) d'une critique : {theater_ok, published, scores}.

    None = pas en cache et lecture impossible (réseau / hors-ligne).
    """
    cache = _load_cache()
    with _lock:
        entry = cache["reviews"].get(url)
    if entry:
        young = _now() - entry.get("published", 0) < 30 * _DAY
        if offline or _fresh(entry, _REVIEW_TTL_YOUNG if young else _REVIEW_TTL_OLD):
            return entry
    if offline:
        return None
    try:
        time.sleep(_PAUSE)
        html = _get(url)
    except Exception:  # noqa: BLE001
        return entry          # ancienne version plutôt que rien
    scores = [_score(p) for p in _rundschau_paragraphs(html)]
    entry = {
        "at": _now(),
        "published": _published(html),
        "theater_ok": bool(sure or _mentions_theater(html, theater)),
        "scores": [round(s, 4) for s in scores],
    }
    with _lock:
        cache["reviews"][url] = entry
    _save_cache()
    return entry


def fetch_rating(theater: str, title: str, url: str = "", offline: bool = False,
                 search: bool = True) -> Optional[CriticsRating]:
    """Note presse estimée, ou None si pas de Kritikenrundschau exploitable.

    url : page du spectacle sur le site du théâtre (son slug est souvent le
    titre allemand, même sur les pages /en/). offline=True : n'utilise que le
    cache, sans réseau (ouvertures de vente, où l'alerte doit partir vite).
    """
    try:
        candidates, _failed = _find_reviews(theater, title, url, offline, search)
        review_url, scores = None, []
        for cand, sure in candidates[:3]:
            entry = _review(cand, theater, sure, offline)
            if entry and entry.get("theater_ok"):
                review_url, scores = cand, entry.get("scores", [])
                break
    except Exception:  # noqa: BLE001 — la note est un bonus, jamais bloquante
        return None
    if len(scores) < _MIN_CRITICS:
        return None

    mean = sum(map(_to_stars, scores)) / len(scores)
    return CriticsRating(
        stars=round(mean * 2) / 2,
        count=len(scores),
        positive=sum(s > 0.2 for s in scores),
        mixed=sum(-0.2 <= s <= 0.2 for s in scores),
        negative=sum(s < -0.2 for s in scores),
        url=review_url,
    )


def in_listing(theater: str, title: str, url: str = "") -> bool:
    """La pièce figure-t-elle dans la rubrique (en cache) de sa maison ? Local, instantané."""
    return bool(_find_reviews(theater, title, url, offline=True, search=False)[0])
