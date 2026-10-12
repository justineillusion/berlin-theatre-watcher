"""Estimation de la note presse d'une pièce à partir de nachtkritik.de.

Sous chaque critique, Nachtkritik publie une « Kritikenrundschau » : un
paragraphe par journal (SZ, FAZ, taz, Tagesspiegel…) qui résume l'avis du
critique, souvent avec des citations. Il n'y a PAS de note chiffrée : on
l'estime donc, sans LLM, avec un petit lexique allemand pondéré.

C'est volontairement une *estimation* : elle distingue bien « Theatercoup » de
« zähe dreieinhalb Stunden », beaucoup moins bien l'ironie ou les avis très
partagés. D'où l'affichage de la répartition 👍/😐/👎 à côté des étoiles.

    recherche Nachtkritik (titre + théâtre) → page de la critique
      → paragraphes de la Kritikenrundschau → score par critique → moyenne ★
"""
from __future__ import annotations

import re
import time
import unicodedata
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from .fetch import fetch_html

_BASE = "https://nachtkritik.de"
_MIN_CRITICS = 2          # en dessous, une « moyenne » n'a pas de sens
_PAUSE = 1.0              # entre deux requêtes, par politesse
_TIMEOUT = 60.0           # la recherche Nachtkritik met 5 à 30+ secondes

# Nom du théâtre dans le bot -> (mot ajouté à la recherche, fragment d'URL
# Nachtkritik). La critique peut avoir été écrite ailleurs (ex. création à
# Avignon) : le slug mentionne alors quand même la maison berlinoise.
# None = pas de contrainte (Festspiele : spectacles invités de partout).
_THEATERS = {
    "Schaubühne": ("Schaubühne", "schaubuehne"),
    "Berliner Ensemble": ("Berliner Ensemble", "berliner-ensemble"),
    "Volksbühne": ("Volksbühne", "volksbuehne"),
}


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

    def label(self) -> str:
        """« ★★★½☆ 3,5/5 · 8 critiques (👍4 😐3 👎1) »."""
        note = f"{self.stars:g}".replace(".", ",")
        split = f"👍{self.positive} 😐{self.mixed} 👎{self.negative}"
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
# Recherche de la critique
# ---------------------------------------------------------------------------
def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = re.sub(r"[\"'„“”‚‘’«»#!?]", "", text)
    return re.sub(r"\s+", " ", text).strip(" .:–-")


def _title_variants(title: str) -> List[str]:
    """« Die Wildente (The Wild Duck) » -> [titre complet, Die Wildente, The Wild Duck]."""
    m = re.match(r"^(.*?)\s*\((.*?)\)\s*$", title)
    variants = [title] + ([m.group(1), m.group(2)] if m else [])
    return [v for v in dict.fromkeys(variants) if v.strip()]


def _title_matches(nk_title: str, variants: List[str]) -> bool:
    # « Bluets –\xa0Schaubühne Berlin – … » : espaces parfois insécables.
    head = _norm(re.split(r"\s+[–—-]\s+", unicodedata.normalize("NFKC", nk_title))[0])
    for v in map(_norm, variants):
        if head == v or head.startswith(v + ". ") or head.startswith(v + ": "):
            return True
    return False


def _search(query: str) -> List[tuple]:
    """Résultats « nachtkritiken » d'une recherche : [(titre, url, date ISO)]."""
    url = f"{_BASE}/index.php?" + urlencode({"option": "com_finder", "view": "search", "q": query})
    for attempt in range(2):            # la recherche time-oute de temps en temps
        try:
            soup = BeautifulSoup(fetch_html(url, timeout=_TIMEOUT), "html.parser")
            break
        except Exception:  # noqa: BLE001
            if attempt:
                return []
            time.sleep(5)
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
    return results


def _find_reviews(theater: str, title: str) -> List[Tuple[str, bool]]:
    """Critiques candidates, la meilleure d'abord : [(url, sûre)].

    « sûre » = l'URL nomme la maison berlinoise. Sinon (création à Vienne,
    Avignon…), il faudra vérifier sur la page que le théâtre y est cité.
    """
    search_word, url_fragment = _THEATERS.get(theater, ("", None))
    variants = _title_variants(title)
    # Le titre complet « X (Y) » ne donne rien (tous les mots sont exigés). Et
    # ajouter le nom du théâtre à la requête DÉGRADE le classement Joomla
    # (« Call me Paris Schaubühne » ne trouve pas la critique) : on cherche le
    # titre seul, et on ne retente avec le théâtre que pour les titres trop
    # courants (« 1984 », « Hedda »…) qui noient la critique dans la 1re page.
    queries = list(variants[1:] or variants)
    queries += [f"{v} {search_word}" for v in queries if search_word]

    found: dict = {}
    for i, q in enumerate(queries):
        if i:
            time.sleep(_PAUSE)
        for nk_title, url, date in _search(q):
            if _title_matches(nk_title, variants):
                sure = url_fragment is None or url_fragment in url
                found[url] = (sure, date)
        if any(sure for sure, _ in found.values()):
            break
    # sûres d'abord, puis les plus récentes
    ranked = sorted(found.items(), key=lambda kv: kv[1], reverse=True)
    return [(url, sure) for url, (sure, _) in ranked]


def _mentions_theater(html: str, theater: str) -> bool:
    """La fiche (générique) ou la Rundschau de la critique cite-t-elle le théâtre ?"""
    search_word, url_fragment = _THEATERS.get(theater, ("", None))
    soup = BeautifulSoup(html, "html.parser")
    # Pas tout le texte de la page : les encadrés « à lire aussi » citent
    # n'importe quel théâtre.
    blocks = soup.select(".text_besetzung") + [p for p in soup.find_all("p") if p.find_previous(class_="text_rundschau")]
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


def fetch_rating(theater: str, title: str) -> Optional[CriticsRating]:
    """Note presse estimée, ou None si pas de Kritikenrundschau exploitable."""
    review_url, paragraphs = None, []
    try:
        for url, sure in _find_reviews(theater, title)[:3]:
            time.sleep(_PAUSE)
            html = fetch_html(url, timeout=_TIMEOUT)
            if sure or _mentions_theater(html, theater):
                review_url, paragraphs = url, _rundschau_paragraphs(html)
                break
    except Exception:  # noqa: BLE001 — la note est un bonus, jamais bloquante
        return None
    if len(paragraphs) < _MIN_CRITICS:
        return None

    scores = [_score(p) for p in paragraphs]
    mean = sum(map(_to_stars, scores)) / len(scores)
    return CriticsRating(
        stars=round(mean * 2) / 2,
        count=len(scores),
        positive=sum(s > 0.2 for s in scores),
        mixed=sum(-0.2 <= s <= 0.2 for s in scores),
        negative=sum(s < -0.2 for s in scores),
        url=review_url,
    )
