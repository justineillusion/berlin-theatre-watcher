"""Parsers HTML par théâtre.

Chaque parser prend le HTML d'une page et renvoie une liste de Show.
Pour ajouter un théâtre : écris une fonction parse(html) -> list[Show]
et enregistre-la dans PARSERS ci-dessous.
"""
from __future__ import annotations

from typing import Callable, List

from ..models import Show
from . import berliner_ensemble, volksbuehne

PARSERS: dict[str, Callable[[str], List[Show]]] = {
    "berliner_ensemble": berliner_ensemble.parse,
    "volksbuehne": volksbuehne.parse,
}
