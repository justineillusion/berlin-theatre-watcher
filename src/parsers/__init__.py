"""Sources par théâtre.

Chaque module expose collect(url) -> list[Show] : il gère lui-même la
récupération HTTP (simple GET, ou pagination AJAX pour la Schaubühne) et le
parsing. Pour ajouter un théâtre : écris un module avec collect() et
enregistre-le dans SOURCES ci-dessous.
"""
from __future__ import annotations

from typing import Callable, List

from ..models import Show
from . import berliner_ensemble, schaubuehne, volksbuehne

SOURCES: dict[str, Callable[[str], List[Show]]] = {
    "berliner_ensemble": berliner_ensemble.collect,
    "volksbuehne": volksbuehne.collect,
    "schaubuehne": schaubuehne.collect,
}
