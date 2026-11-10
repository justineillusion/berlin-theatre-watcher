# 📰 Buzz presse

Un seul signal par expo / pièce / film : **comment c'est reçu dans la presse**.

```
📰 Buzz : 👍 plutôt positif (2 sources) · ex. « klein, aber sehr lohnend » (Jüdische Allgemeine)
📰 Buzz: 😐 mixed (1 source)
📰 Buzz: covered (2 sources), no clear verdict yet
📰 Not open yet — reviews from 28 Nov
📰 No reviews yet
```

Aucun lien n'est affiché. Les URL restent dans `state/press_cache.json` pour déboguer.

## Utilisation (code des cartes)

```python
from src.press import buzz_line, press_for, format_buzz

line = buzz_line(kind, venue, title, url, lang="fr", opens=first_date)   # str, jamais None
# ou, pour décider soi-même :
b = press_for(kind, venue, title, url, opens=first_date)
# b["status"] in {"verdict", "covered", "not_open", "none"}
# b["level"] / b["level_fr"], b["basis"], b["example"] = {"text", "outlet"} | None
```

* Lecture du **cache seul** : aucun appel réseau, quelques millisecondes.
* `opens` (date ou `"AAAA-MM-JJ"`, facultatif) : si rien n'est encore paru et que
  l'ouverture est future → « pas encore ouvert — critiques à partir du … ».
* Pièces : la note Nachtkritik est mélangée au reste (lue dans
  `state/critics_cache.json`, sans réseau ni écriture).

## Rafraîchir le cache

```bash
python -m src.press --refresh                       # flux + API + sitemaps
python -m src.press --refresh --items items.json    # + recherche par item
python -m src.press --report --items items.json --lang en   # rapport de couverture
```

`items.json` : liste `[{kind, venue, title, url, opens?, aliases?}]` ou l'export
`wrangler d1 execute theatre-bot --remote --json --command '…'`. Sans `--items`,
`state/press_items.json` est lu (export local des items actifs, versionné ; le
scan le tiendra à jour). `aliases` = autres titres (ex. titre allemand).

Pour régénérer `state/press_items.json` à la main :

```bash
cd worker && npx wrangler d1 execute theatre-bot --remote --json --command \
  'select v.name venue, i.kind, i.title, i.url, i.start_date opens from items i join venues v on v.id=i.venue_id where v.active=1' \
  | python3 -c 'import json,sys; json.dump(json.load(sys.stdin)[0]["results"], open("../state/press_items.json","w"), ensure_ascii=False, indent=1)'
```

Workflow : `.github/workflows/press.yml`, tous les jours à 04:45 UTC, commit de
`state/press_cache.json`.

Politesse : User-Agent honnête, `robots.txt` respecté, ≥ 1 s entre deux
requêtes au même site, **8 s max par requête** (au-delà : sauté, réessayé au
prochain run), **5 min** de budget global. Un média en panne garde ses anciens
articles.

## Sources

* **The Berliner** — API REST WordPress (Art, Stage, Film, 6 mois) : titre,
  chapô, étoiles, intertitres des listes de sélections, Hits / Misses.
* **tip Berlin** — sitemaps seulement (le pare-feu refuse les robots ailleurs) :
  slug + date (= « couvert »).
* **Tagesspiegel, Berliner Zeitung, taz, Monopol, rbb24, Deutschlandfunk Kultur,
  FAZ (Kunst), SZ, Welt, Zeit, Jüdische Allgemeine, Berlin Art Link, ArtReview**
  — flux RSS accumulés chaque nuit (6 mois) : titre + chapô (≤ 300 car.).
* **Tagesspiegel, Berliner Zeitung** — aussi leurs sitemaps mensuelles (rubriques
  Kultur, 6 mois ; un mois révolu n'est lu qu'une fois) : slug + date.
* **Recherche par item** (Jüdische Allgemeine, Berlin Art Link, The Berliner via
  leur flux de recherche WordPress ; taz via son flux de recherche ; Monopol via
  sa page de recherche), gardée 3 jours, articles jusqu'à 12 mois.
* **Enrichissement** : un article qui correspond à un item mais n'a qu'un slug
  ou un titre (Tagesspiegel, Berliner Zeitung, taz, Monopol) → on lit une fois
  son titre + chapô (meta description), jamais le corps. 40 pages max par run.
* **Nachtkritik** — `critics.py` (cache) : note estimée.
* **Opéras — klassik-begeistert.de** (blog de critiques, robots.txt ouvert) :
  3 pages de flux par nuit + recherche WordPress « titre + maison »
  (« Tosca Staatsoper Linden »). On ne matche que le titre + l'URL (le titre
  nomme l'œuvre ET la maison ; le chapô cite d'autres œuvres), sans les revues
  de presse quotidiennes (« DIE DIENSTAG-PRESSE »). Les titres anglais des sites
  (« The Flying Dutchman ») ont un alias allemand/original (`Show.aliases`).
  Maisons homonymes écartées : Wiener / Hamburgische / Bayerische Staatsoper…,
  Deutsche Oper am Rhein. Tagesspiegel, Welt, rbb24 couvrent aussi l'opéra
  (« an der Staatsoper », « Deutsche Oper », « Komische Oper » sont des alias de lieu).
  Non retenus : bachtrack (pas de flux), concerti.de (flux de 2 articles),
  nmz.de (peu de Berlin), der-opernfreund.de (hors ligne).
* **Philharmonie** : pas de buzz. Les titres de programme (« Rome with Kirill
  Petrenko and Ottorino Respighi ») ne se relient pas sans risque à une critique
  (même chef, autre soir), et aucune source ne publie une critique par programme.

Recherche impossible pour un robot : Berliner Zeitung (`/suche` interdit par
robots.txt → sitemaps), Tagesspiegel et Deutschlandfunk Kultur (résultats rendus
en JavaScript → sitemaps / RSS), rbb24 / radio3 (ni recherche ni sitemap → RSS
seulement). Non utilisés : Frieze (403 pour les robots), pages Zeit (403 ; le flux général
est utilisé), art – Das Kunstmagazin (pas de flux), radio3 (pas de flux ;
couvert par rbb24 Kultur). Les flux ne donnent que les derniers articles :
la couverture des médias « RSS seulement » grandit de nuit en nuit.

## Comment le niveau est calculé

Chaque article qui correspond à l'item (nom d'artiste / titre / slug, normalisés
comme `critics.py` ; un nom court ou générique exige que le lieu soit nommé ; un
article qui ne nomme qu'un autre lieu est écarté) apporte des signaux :

* étoiles : `(étoiles − 3) / 2`, poids 1 ;
* « The Hits » / « The Misses » : ±0,6, poids 0,8 ;
* présence dans une vraie sélection (« Best of », « Editor's pick », « Unmissable ») :
  +0,4, poids 0,6. Un agenda (« What's On », « Guide ») = simple mention ;
* titre + chapô passés au lexique EN + DE (celui de `critics.py` + ajouts) :
  score × 0,8, poids 0,5, seulement si l'indice est net ;
* Nachtkritik : `(étoiles − 3) / 2`, poids 1,5.

Moyenne pondérée → 🔥 ≥ 0,55 · 👍 ≥ 0,2 · 😐 ≥ −0,3 · 👎 sinon. En dessous d'un
poids total de 0,5 (simple mention), pas de verdict.

Droits d'auteur : seuls titres, chapôs de flux, noms et notes sont stockés ;
l'affichage se limite à un fragment de ≤ 15 mots qui porte le verdict.
