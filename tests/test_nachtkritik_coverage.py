"""Chaque théâtre de config.yaml a sa rubrique Nachtkritik (ou est déclaré sans)."""
from pathlib import Path

import yaml

from src.critics import NO_NACHTKRITIK, _THEATERS
from src.parsers import SOURCES

ROOT = Path(__file__).resolve().parents[1]
# Parsers qui ne sont pas du théâtre parlé (opéra, concerts, danse, expos) : hors Nachtkritik.
NOT_THEATRE = {"staatsoper", "deutsche_oper", "komische_oper", "philharmonie", "schokoladen", "urban_spree",
               "staatsballett", "smb", "kw", "co_berlin", "berlinische_galerie", "fotografiska", "gropius_bau"}


def _theatre_names():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    for t in cfg.get("theaters") or cfg.get("venues") or []:
        if t.get("kind", "theatre") == "theatre" and t.get("parser") not in NOT_THEATRE and t.get("parser") in SOURCES:
            yield t["parser"], t["name"]


def test_every_theatre_has_a_nachtkritik_section():
    import importlib
    missing = []
    for parser, name in _theatre_names():
        mod = importlib.import_module(SOURCES[parser].__module__)
        shown = getattr(mod, "THEATER", None) or name
        if shown not in _THEATERS and name not in _THEATERS and shown not in NO_NACHTKRITIK and name not in NO_NACHTKRITIK:
            missing.append(f"{name} ({parser})")
    assert not missing, f"Ajoute la rubrique Nachtkritik (src/critics.py _THEATERS) ou NO_NACHTKRITIK : {missing}"
