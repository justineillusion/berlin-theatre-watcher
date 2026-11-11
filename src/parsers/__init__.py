"""Sources par théâtre.

Chaque module expose collect(url) -> list[Show] : il gère lui-même la
récupération HTTP (simple GET, ou pagination AJAX pour la Schaubühne) et le
parsing. Pour ajouter un théâtre : écris un module avec collect() et
enregistre-le dans SOURCES ci-dessous.
"""
from __future__ import annotations

from typing import Callable, List

from ..models import Show
from . import berliner_ensemble, chamaeleon, expos, festspiele, gorki, hau, opera, philharmonie, schaubuehne, volksbuehne

SOURCES: dict[str, Callable[[str], List[Show]]] = {
    "berliner_ensemble": berliner_ensemble.collect,
    "volksbuehne": volksbuehne.collect,
    "schaubuehne": schaubuehne.collect,
    "festspiele": festspiele.collect,
    "gorki": gorki.collect,
    "hau": hau.collect,
    "chamaeleon": chamaeleon.collect,
    # Opéras + concerts (optional: true dans config.yaml : pas d'abonnement d'office)
    "staatsoper": opera.staatsoper,
    "deutsche_oper": opera.deutsche_oper,
    "komische_oper": opera.komische_oper,
    "philharmonie": philharmonie.collect,
    # Lieux d'expo (kind: expo dans config.yaml)
    "smb": expos.smb,
    "kw": expos.kw,
    "co_berlin": expos.co_berlin,
    "berlinische_galerie": expos.berlinische_galerie,
    "fotografiska": expos.fotografiska,
    "gropius_bau": expos.gropius_bau,
}
