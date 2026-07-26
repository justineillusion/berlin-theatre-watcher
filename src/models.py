from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional


@dataclass
class Show:
    """Une représentation dans un théâtre."""

    theater: str
    title: str
    date: str = ""                       # "YYYY-MM-DD" si connu, sinon texte brut
    time: Optional[str] = None
    venue: Optional[str] = None
    original_language: Optional[str] = None
    is_german_production: Optional[bool] = None   # True = répertoire allemand
    has_english_surtitles: bool = False
    sold_out: Optional[bool] = None       # None = inconnu (on notifie quand même)
    booking_url: Optional[str] = None
    description: Optional[str] = None

    # rempli par le scoring LLM
    score: Optional[int] = None
    reason: Optional[str] = None

    def key(self) -> str:
        """Identité stable d'une représentation (pour la déduplication)."""
        return f"{self.theater}|{self.title.strip().lower()}|{self.date}".strip()

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Show":
        allowed = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in allowed})
