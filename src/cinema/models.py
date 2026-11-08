"""Structures de données du module ciné (indépendantes des pièces de théâtre)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional


@dataclass
class Screening:
    """Une séance, telle que lue sur le site / l'API d'un cinéma."""

    cinema: str                      # nom court du cinéma (cinema.yaml)
    start: datetime                  # heure locale Berlin (aware)
    title: str                       # titre affiché par le cinéma (souvent allemand)
    url: Optional[str] = None        # page du film chez le cinéma
    booking_url: Optional[str] = None
    version: Optional[str] = None    # code normalisé : OmU, OmeU, OV, DF, muet… (voir version.py)
    original_title: Optional[str] = None
    alt_titles: List[str] = field(default_factory=list)
    year: Optional[int] = None
    directors: List[str] = field(default_factory=list)
    countries: List[str] = field(default_factory=list)   # libellés bruts (« USA », « D », « Frankreich »…)
    original_language: Optional[str] = None              # ISO 639-1 si connu
    genres: List[str] = field(default_factory=list)
    description: Optional[str] = None
    category: Optional[str] = None   # rubrique du cinéma (Babylon : ORCHESTER, LITERATUR…)
    tags: List[str] = field(default_factory=list)        # flags kinoheld, tags Babylon…
    live_music: bool = False         # ciné-concert (muet + orgue/orchestre)


@dataclass
class Rating:
    source: str                      # "SensCritique" | "Letterboxd"
    value: float                     # SC : /10 ; Letterboxd : /5
    count: int
    url: str
    scale: int = 10
    title: Optional[str] = None      # titre du film côté source (pour vérifier le match)
    original_title: Optional[str] = None
    year: Optional[int] = None
    directors: List[str] = field(default_factory=list)
    genres: List[str] = field(default_factory=list)
    countries: List[str] = field(default_factory=list)
    synopsis: Optional[str] = None
    confidence: str = "high"         # "high" | "low" (match sur le seul titre)

    def label(self) -> str:
        num = f"{self.value:.1f}".replace(".", ",")
        return f"{num}/{self.scale} {self.source}"


@dataclass
class Film:
    """Un film = toutes ses séances du soir dans la semaine, tous cinémas confondus."""

    key: str
    screenings: List[Screening]
    senscritique: Optional[Rating] = None
    letterboxd: Optional[Rating] = None
    pitch: Optional[str] = None
    pitch_en: Optional[str] = None   # pitch anglais (amis qui lisent en anglais) ; None = pas de pitch
    rejected: Optional[str] = None   # raison d'exclusion (None = retenu)
    dropped_screenings: List[str] = field(default_factory=list)  # ex. séances en VF
    dubbed_release: bool = False     # le cinéma le passe aussi en VF (à n'importe quelle heure)
    unrated: bool = False            # aucune source n'a assez de votes pour juger

    def item_id(self) -> str:
        """Id stable côté bot (items, boutons ⭐) : titre original normalisé + année.
        Le même film dans deux cinémas, ou repris l'an prochain, garde le même id."""
        import hashlib

        from .ratings import norm_title
        base = f"film|{norm_title(self.original_title or self.title)}|{self.year or ''}"
        return hashlib.sha1(base.encode()).hexdigest()[:12]

    def is_recent(self, today_year: int, max_age: int = 3) -> bool:
        y = self.year or (self.senscritique.year if self.senscritique else None)
        return bool(y and y >= today_year - max_age)

    # --- métadonnées fusionnées (la 1re séance renseignée gagne) ---
    def _first(self, attr: str):
        for s in self.screenings:
            v = getattr(s, attr)
            if v:
                return v
        return None

    @property
    def title(self) -> str:
        return self.screenings[0].title

    @property
    def original_title(self) -> Optional[str]:
        if self.senscritique and self.senscritique.original_title:
            return self.senscritique.original_title
        return self._first("original_title")

    @property
    def year(self) -> Optional[int]:
        return self._first("year") or (self.senscritique.year if self.senscritique else None)

    @property
    def directors(self) -> List[str]:
        return self._first("directors") or (self.senscritique.directors if self.senscritique else []) or []

    @property
    def best_score(self) -> float:
        """Note sur 10 servant au tri (SC prioritaire, sinon Letterboxd ×2)."""
        if self.senscritique:
            return self.senscritique.value
        if self.letterboxd:
            return self.letterboxd.value * 2
        return 0.0
