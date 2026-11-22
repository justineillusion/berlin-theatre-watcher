from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import List, Optional

from .critics import CriticsRating


@dataclass
class Show:
    """Une représentation dans un théâtre."""

    theater: str
    title: str
    date: str = ""                       # "YYYY-MM-DD" si connu, sinon texte brut
    time: Optional[str] = None
    venue: Optional[str] = None
    url: Optional[str] = None             # page détail de la production
    languages: Optional[str] = None       # ex "In German and English"
    spoken_language: Optional[str] = None # ex "En allemand et arabe" (déduit)
    surtitles: Optional[str] = None       # ex "surtitres allemands et anglais"
    production_type: Optional[str] = None # ex "Lecture Performance"
    has_english_surtitles: bool = False
    sold_out: Optional[bool] = None       # None = inconnu (on notifie quand même)
    booking_url: Optional[str] = None
    summary: Optional[str] = None         # résumé du sujet (page détail), en français
    summary_en: Optional[str] = None      # le même en anglais (si un ami lit en anglais)
    matched_keywords: List[str] = field(default_factory=list)
    other_dates_count: int = 0            # nb d'autres dates dispo pour cette pièce
    available_dates: List[str] = field(default_factory=list)  # dates avec places libres
    available_iso: List[str] = field(default_factory=list)    # idem, brut, pour l'état
    new_dates: List[str] = field(default_factory=list)        # dates inédites ce scan
    critics: Optional[CriticsRating] = None  # note presse estimée (Nachtkritik)
    kind: str = "theatre"                 # "theatre" | "expo"
    end_date: Optional[str] = None        # expos : "YYYY-MM-DD" de fin (date = début)
    venue_id: str = ""                    # slug du lieu dans config.yaml (abonnements)
    venue_name: str = ""                  # nom du lieu tel que dans config.yaml
    aliases: List[str] = field(default_factory=list)  # autres titres (titre original, pour la presse)
    price_min: Optional[float] = None     # € ; seulement si le site du lieu l'affiche (0 = entrée libre)
    price_max: Optional[float] = None
    all_sold: bool = False                # toutes les dates surtitrées sont complètes (carte « Complet »)
    price_from: bool = False              # le site ne donne que le minimum (« dès 28 € »)
    duration_min: Optional[int] = None    # durée écrite sur la page du lieu (« Dauer 2 Stunden »)

    def key(self) -> str:
        """Identité d'une PIÈCE (pour la déduplication : 1 alerte par pièce)."""
        return f"{self.theater}|{self.title.strip().lower()}".strip()

    def item_id(self) -> str:
        """Identifiant court et stable d'une pièce/expo, partagé avec le bot
        multi-utilisateurs (boutons Telegram : 64 octets max par callback).

        Fondé sur le lieu + le titre normalisé : quand une pièce de répertoire
        revient la saison suivante, elle garde le même id, donc un « Vu » ou un
        « Ignorer » reste valable."""
        import hashlib

        base = f"{self.venue_id or self.theater}|{self.title.strip().lower()}"
        return hashlib.sha1(base.encode()).hexdigest()[:12]

    @property
    def display_title(self) -> str:
        """Titre affiché en anglais : « Die Wildente (The Wild Duck) » -> « The Wild Duck »,
        « Die Zauberflöte » -> « The Magic Flute ». L'id reste fondé sur self.title."""
        return english_title(self.title)[0]

    def haystack(self) -> str:
        """Texte concaténé pour la recherche de mots-clés (minuscules)."""
        parts = [
            self.title,
            self.venue,
            self.languages,
            self.production_type,
            self.url,
        ]
        return " ".join(p for p in parts if p).lower()

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Show":
        allowed = set(cls.__dataclass_fields__)  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in allowed})


# Titres allemands courants sans traduction sur les sites (opéra / ballet).
_EN_TITLES = {
    "die zauberflöte": "The Magic Flute", "hänsel und gretel": "Hansel and Gretel",
    "tristan und isolde": "Tristan and Isolde", "die zarenbraut": "The Tsar's Bride",
    "der fliegende holländer": "The Flying Dutchman", "die entführung aus dem serail": "The Abduction from the Seraglio",
    "der rosenkavalier": "Der Rosenkavalier", "die fledermaus": "Die Fledermaus",
    "der nussknacker": "The Nutcracker", "schwanensee": "Swan Lake", "dornröschen": "The Sleeping Beauty",
    "die walküre": "The Valkyrie", "das rheingold": "The Rhine Gold", "götterdämmerung": "Twilight of the Gods",
    "die meistersinger von nürnberg": "The Mastersingers of Nuremberg", "die frau ohne schatten": "The Woman Without a Shadow",
}
_DE = __import__("re").compile(r"[äöüß]|\b(der|die|das|und|des|dem|den|ein|eine|vom|zum|zur|für|mit|im|am|ihr|ist|nicht|wie)\b", __import__("re").I)


def english_title(title: str) -> tuple:
    """(titre anglais, titre original ou None)."""
    import re
    t = (title or "").strip()
    if t.lower() in _EN_TITLES:
        en = _EN_TITLES[t.lower()]
        return (en, None if en == t else t)
    m = re.fullmatch(r"(.+?)\s*\(([^()]+)\)", t)
    if m:
        a, b = m.group(1).strip(), m.group(2).strip()
        if b.upper() in ("AT", "UA", "WA"):           # Arbeitstitel / Uraufführung
            return (a, None)
        if _DE.search(a) and not _DE.search(b):
            return (b, a)
        if _DE.search(b) and not _DE.search(a):        # « Twelfth Night (Was ihr wollt) »
            return (a, b)
    return (t, None)
