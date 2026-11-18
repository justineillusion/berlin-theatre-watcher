"""QA de l'app en production : lit les fiches à l'affiche dans D1 (wrangler) et vérifie.

    python3 scripts/qa.py            # rapport complet
    python3 scripts/qa.py --no-links # sans tester les liens (rapide)

Contrôles (docs/ux.md : zéro remplissage, jamais de lien mort) :
  links      : chaque lien de la fiche (page, billets) répond (HTTP < 400)
  synopsis   : pièce / film / expo sans bloc 📝 (description)
  duplicate  : même œuvre deux fois (titre normalisé, ou même lien, ou mêmes séances)
  mixed      : générique traduit à moitié (« a project de », « based on the novella de »)
  empty      : à l'affiche sans aucune date (ni libre ni complète)
  venue_low  : lieu suivi par défaut avec moins de 2 fiches
Code de sortie 1 s'il y a des erreurs (links, duplicate, mixed, empty).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def d1(sql: str) -> list:
    out = subprocess.run(["npx", "wrangler", "d1", "execute", "theatre-bot", "--remote", "--json", "--command", sql],
                         cwd=ROOT / "worker", capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]["results"]


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().lower()
    t = re.sub(r"\(.*?\)", " ", t)
    t = re.sub(r"^(the|la|le|les|der|die|das|el|il|a|an)\s+", "", t.strip())
    return re.sub(r"[^a-z0-9]+", "", t)


def items() -> list:
    return d1("""SELECT i.id, i.kind, i.title, i.url, i.venue_id, v.name venue, v.optional, i.dates, i.sold, i.text, i.end_date
      FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
      WHERE (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
                  ELSE i.last_seen >= (SELECT value FROM settings WHERE key = 'current_since') END)
        AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= date('now'))""")


# Billetteries / sites qui bloquent les robots ou ce réseau : non vérifiables d'ici (avertissement, pas erreur).
_SHOPS = re.compile(r"eventim|shotgun\.live|vvk\.link|ra\.co|ticketmaster|yp\.events|eventbrite|yorck\.de|tixforgigs|reservix", re.I)
_SOFT404 = re.compile(r"<title>[^<]*(?:404|not found|nicht gefunden|seite existiert nicht|page introuvable)[^<]*</title>", re.I)


def alive(url: str) -> tuple[str, int | str]:
    try:
        with httpx.Client(follow_redirects=True, timeout=20, headers={"User-Agent": UA}) as c:
            r = c.get(url)
            if r.status_code < 400 and _SOFT404.search(r.text[:5000]):
                return url, "soft-404"
            return url, r.status_code
    except Exception as e:  # noqa: BLE001
        return url, type(e).__name__


_MIXED = re.compile(r"\b(?:a|an|the|by|based on|after|project|play|novella|novel|opera|text)\s+de\b", re.I)


def main() -> int:
    check_links = "--no-links" not in sys.argv
    rows = items()
    issues: dict = defaultdict(list)
    today = __import__("datetime").date.today().isoformat()
    for r in rows:
        text = r["text"] or ""
        dates = json.loads(r["dates"] or "[]") + json.loads(r["sold"] or "[]")
        tag = f"{r['venue']} · {r['title']}"
        if r["kind"] != "expo" and not [d for d in dates if d[:10] >= today]:
            issues["empty"].append(tag)
        if "📝" not in text and r["optional"] == 0:
            issues["synopsis"].append(tag)
        if r["optional"] == 1 and "📝" not in text and r["kind"] != "film":
            issues["synopsis_optional"].append(tag)
        for line in text.split("\n"):
            if line.startswith("✍️") and _MIXED.search(line):
                issues["mixed"].append(f"{tag} : {line[:90]}")
    # Doublons : même titre normalisé (même lieu, ou films partout), même lien, mêmes séances
    by = defaultdict(list)
    for r in rows:
        key = (r["kind"], norm(r["title"]), "" if r["kind"] == "film" else r["venue_id"])
        by[key].append(r)
        if r["url"]:
            by[("url", r["url"], r["venue_id"])].append(r)
    for k, rs in by.items():
        if len({x["id"] for x in rs}) > 1:
            issues["duplicate"].append(" = ".join(sorted({f"{x['venue']} · {x['title']}" for x in rs})))
    issues["duplicate"] = sorted(set(issues["duplicate"]))
    # Lieux maigres
    per = defaultdict(int)
    for r in rows:
        per[(r["venue"], r["optional"])] += 1
    for v in d1("SELECT name, optional FROM venues WHERE active = 1 AND kind != 'cinema'"):
        if v["optional"] == 0 and per[(v["name"], 0)] < 2:
            issues["venue_low"].append(f"{v['name']} : {per[(v['name'], 0)]} fiche(s)")
    # Liens
    if check_links:
        import html as _h
        urls = sorted({_h.unescape(u) for r in rows for u in [r["url"], *re.findall(r'href="([^"]+)"', r["text"] or "")] if u and u.startswith("http")})
        with ThreadPoolExecutor(16) as ex:
            for u, code in ex.map(alive, urls):
                if not (isinstance(code, int) and code < 400):
                    who = [f"{r['venue']} · {r['title']}" for r in rows if u == r["url"] or u in _h.unescape(r["text"] or "")][:2]
                    bucket = "links_unverifiable" if _SHOPS.search(u) and not isinstance(code, int) or (_SHOPS.search(u) and code in (401, 403)) else "links"
                    issues[bucket].append(f"{code} {u[:110]}  ({'; '.join(who)})")
    print(f"QA : {len(rows)} fiches, {len(per)} lieux")
    for k in ["links", "duplicate", "mixed", "empty", "synopsis", "synopsis_optional", "venue_low", "links_unverifiable"]:
        xs = issues.get(k, [])
        print(f"\n[{k}] {len(xs)}")
        for x in xs[:40]:
            print("  -", x)
        if len(xs) > 40:
            print(f"  … +{len(xs) - 40}")
    return 1 if any(issues.get(k) for k in ("links", "duplicate", "mixed", "empty")) else 0


if __name__ == "__main__":
    sys.exit(main())
