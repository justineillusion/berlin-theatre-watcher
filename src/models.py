from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import List, Optional


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
    production_type: Optional[str] = None # ex "Lecture Performance"
    has_english_surtitles: bool = False
    sold_out: Optional[bool] = None       # None = inconnu (on notifie quand même)
    booking_url: Optional[str] = None
    summary: Optional[str] = None         # résumé du sujet (page détail)
    matched_keywords: List[str] = field(default_factory=list)
    other_dates_count: int = 0            # nb d'autres dates dispo pour cette pièce

    def key(self) -> str:
        """Identité d'une PIÈCE (pour la déduplication : 1 alerte par pièce)."""
        return f"{self.theater}|{self.title.strip().lower()}".strip()

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
