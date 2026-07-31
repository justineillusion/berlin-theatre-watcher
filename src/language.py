"""Déduit la langue parlée sur scène et les surtitres, rendus en français.

Les théâtres n'annoncent pas ça de façon homogène :

    "In German and Arabic, with German and English surtitles"  (Schaubühne)
    "With German and English surtitles"                        (Volksbühne)
    "By George Orwell, in an adaption by Luk Perceval"          (Berliner Ensemble)

On cherche donc, dans l'ordre :

1. une mention explicite « in <langue(s)> » / « in <…>er Sprache » ;
2. une mention de troupe multilingue (« multilingual », « mehrsprachig ») ;
3. à défaut, une déduction à partir des surtitres : dans une maison
   berlinoise, des surtitres anglais seuls veulent presque toujours dire que
   ça se joue en allemand — on le signale comme « probable ».

Pour éviter les faux positifs (« one of the most important voices in the
French art scene »), on ne lit les pages détail que dans les fragments qui
parlent effectivement de langue ou de surtitres.
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

# clé = nom français ; valeurs = motifs anglais + allemand (déclinaisons incluses)
_LANGS: "dict[str, tuple[str, ...]]" = {
    "allemand": (r"german", r"deutsch(?:e[mnrs]?)?"),
    "anglais": (r"english", r"englisch(?:e[mnrs]?)?"),
    "français": (r"french", r"franz(?:ö|oe)sisch(?:e[mnrs]?)?"),
    "arabe": (r"arabic", r"arabisch(?:e[mnrs]?)?"),
    "espagnol": (r"spanish", r"spanisch(?:e[mnrs]?)?"),
    "italien": (r"italian", r"italienisch(?:e[mnrs]?)?"),
    "portugais": (r"portuguese", r"portugiesisch(?:e[mnrs]?)?"),
    "russe": (r"russian", r"russisch(?:e[mnrs]?)?"),
    "ukrainien": (r"ukrainian", r"ukrainisch(?:e[mnrs]?)?"),
    "polonais": (r"polish", r"polnisch(?:e[mnrs]?)?"),
    "tchèque": (r"czech", r"tschechisch(?:e[mnrs]?)?"),
    "hongrois": (r"hungarian", r"ungarisch(?:e[mnrs]?)?"),
    "roumain": (r"romanian", r"rum(?:ä|ae)nisch(?:e[mnrs]?)?"),
    "grec": (r"greek", r"griechisch(?:e[mnrs]?)?"),
    "turc": (r"turkish", r"t(?:ü|ue)rkisch(?:e[mnrs]?)?"),
    "kurde": (r"kurdish", r"kurdisch(?:e[mnrs]?)?"),
    "hébreu": (r"hebrew", r"hebr(?:ä|ae)isch(?:e[mnrs]?)?"),
    "persan": (r"persian", r"farsi", r"persisch(?:e[mnrs]?)?"),
    "néerlandais": (r"dutch", r"niederl(?:ä|ae)ndisch(?:e[mnrs]?)?"),
    "suédois": (r"swedish", r"schwedisch(?:e[mnrs]?)?"),
    "danois": (r"danish", r"d(?:ä|ae)nisch(?:e[mnrs]?)?"),
    "norvégien": (r"norwegian", r"norwegisch(?:e[mnrs]?)?"),
    "finnois": (r"finnish", r"finnisch(?:e[mnrs]?)?"),
    "serbo-croate": (r"serbian", r"croatian", r"serbisch(?:e[mnrs]?)?", r"kroatisch(?:e[mnrs]?)?"),
    "japonais": (r"japanese", r"japanisch(?:e[mnrs]?)?"),
    "coréen": (r"korean", r"koreanisch(?:e[mnrs]?)?"),
    "chinois": (r"chinese", r"mandarin", r"chinesisch(?:e[mnrs]?)?"),
    "yiddish": (r"yiddish", r"jiddisch(?:e[mnrs]?)?"),
    "langue des signes": (r"sign language", r"geb(?:ä|ae)rdensprache"),
}

_TOKEN = "|".join(p for pats in _LANGS.values() for p in pats)
_ONE = rf"(?:{_TOKEN})"
_SEP = r"\s*(?:,|and|und|&|/|et|or|oder)\s*"
_LIST = rf"{_ONE}(?:{_SEP}{_ONE})*"

# « in German and Arabic, … » / « in deutscher Sprache » — mais pas
# « with subtitles in English », d'où le garde-fou sur (sur|über)titles.
_SPOKEN = re.compile(
    rf"\b(?:in|auf)\s+(?:the\s+)?({_LIST})(?:\s+(?:sprache|language))?\b"
    rf"(?!\s*(?:sur|super|über|ueber)?titel|\s*surtitles?|\s*subtitles?)",
    re.I,
)
_TITLES = r"(?:surtitles?|subtitles?|super\s?titles?|(?:ü|ue)bertiteln?)"
# « English surtitles » (ordre courant)…
_SURTITLES = re.compile(rf"({_LIST})\s+(?:language\s+)?{_TITLES}", re.I)
# …et « surtitles in English », qu'il faut retirer avant de chercher la langue
# parlée, sinon « in English » se fait passer pour la langue de plateau.
_SURTITLES_IN = re.compile(rf"{_TITLES}\s+(?:in|auf)\s+(?:the\s+)?({_LIST})", re.I)
_MULTILINGUAL = re.compile(
    r"multilingual|mehrsprachig\w*|(?:several|various|multiple) languages", re.I
)
# fragments d'une page détail qu'on accepte de lire pour la langue
_LANG_CONTEXT = re.compile(r"surtitles?|(?:ü|ue)bertitel|sprache|language", re.I)


def _to_french(blob: str) -> List[str]:
    """'German and Arabic' -> ['allemand', 'arabe'] (ordre du texte, sans doublon)."""
    found: List[Tuple[int, str]] = []
    for name, patterns in _LANGS.items():
        for pattern in patterns:
            m = re.search(rf"\b{pattern}\b", blob, re.I)
            if m:
                found.append((m.start(), name))
                break
    seen = set()
    ordered = []
    for _, name in sorted(found):
        if name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


def _join_fr(names: List[str]) -> str:
    """['allemand', 'anglais'] -> 'allemand et anglais'."""
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " et " + names[-1]


_PLURALS = {"hébreu": "hébreux", "langue des signes": "langue des signes"}


def _plural(name: str) -> str:
    """'allemand' -> 'allemands' (pour « surtitres allemands »)."""
    if name in _PLURALS:
        return _PLURALS[name]
    return name if name.endswith(("s", "x")) else name + "s"


def _context(text: str) -> str:
    """Ne garde que les fragments qui parlent de langue/surtitres."""
    chunks = re.split(r"(?<=[.!?])\s+|\n+|\s{2,}", text)
    return " | ".join(c for c in chunks if _LANG_CONTEXT.search(c))


def is_pure_language_note(note: Optional[str]) -> bool:
    """La note du programme ne dit-elle QUE la langue/les surtitres ?

    C'est le cas de la Volksbühne ('with english surtitles') : inutile de
    l'afficher en plus de la ligne 🗣. Ailleurs elle porte le générique
    ('by Oscar Wilde …'), qu'on garde.
    """
    if not note:
        return True
    rest = re.sub(rf"{_ONE}|surtitles?|(?:ü|ue)bertiteln?|sprache|language", " ", note, flags=re.I)
    rest = re.sub(r"\b(?:in|with|and|und|mit|auf|the|or|oder)\b|[^\w]", " ", rest, flags=re.I)
    return not rest.strip()


def detect(
    note: Optional[str],
    page_text: Optional[str] = None,
    has_english_surtitles: bool = False,
) -> Tuple[Optional[str], Optional[str]]:
    """Renvoie (langue parlée, surtitres), déjà formatés en français.

    `note`      : la ligne langue/générique du programme (parser).
    `page_text` : le texte de la page détail (facultatif, plus riche).
    """
    note = note or ""
    detail = _context(page_text or "")
    haystack = f"{note} | {detail}"

    surtitle_names: List[str] = []
    for pattern in (_SURTITLES, _SURTITLES_IN):
        for m in pattern.finditer(haystack):
            surtitle_names = _to_french(m.group(1))
            if surtitle_names:
                break
        if surtitle_names:
            break
    # On masque les mentions de surtitres avant de chercher la langue parlée.
    spoken_hay = _SURTITLES_IN.sub(" ", haystack)
    spoken_names: List[str] = []
    for m in _SPOKEN.finditer(spoken_hay):
        spoken_names = _to_french(m.group(1))
        if spoken_names:
            break

    # Pas de surtitres annoncés : on ne les suppose anglais que si la pièce
    # n'est pas déjà jouée en anglais (là, c'est l'allemand qui est surtitré).
    if not surtitle_names and has_english_surtitles and spoken_names != ["anglais"]:
        surtitle_names = ["anglais"]

    surtitles = (
        "surtitres " + _join_fr([_plural(n) for n in surtitle_names])
        if surtitle_names
        else None
    )

    if spoken_names:
        return f"En {_join_fr(spoken_names)}", surtitles

    # Pas de mention explicite : troupe multilingue ?
    if _MULTILINGUAL.search(page_text or note or ""):
        return "Multilingue", surtitles

    # Déduction : surtitres anglais seuls dans une maison berlinoise -> allemand.
    if surtitle_names == ["anglais"]:
        return "En allemand (probable)", surtitles

    return None, surtitles
