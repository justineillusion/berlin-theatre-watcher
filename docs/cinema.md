# 🎬 Ciné de la semaine

Chaque **dimanche matin**, un message Telegram avec les films à voir **le soir
de la semaine qui vient (lundi → dimanche)** — dès 18h, et pas après 22h en
semaine — plus une section « **Ce soir** » (le dimanche même) si un film passe
les filtres, à l'**Intimes** (Friedrichshain), au
**Lichtblick-Kino** (Kastanienallee), au **B-ware! Ladenkino** (Gärtnerstraße 19, Friedrichshain) et au **Babylon** (Mitte) — uniquement des
films **bien notés**, **en VO** (OmU / OmeU / OV), et **pas grand public**.

```bash
./.venv/bin/python -m src.cinema --dry-run                    # affiche message + rapport, n'envoie rien
./.venv/bin/python -m src.cinema --dry-run --start 2026-11-15 # un autre dimanche (un autre jour : jour J + 6)
./.venv/bin/python -m src.cinema                              # envoie (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)
```

Le `--dry-run` imprime aussi un **rapport** : chaque film écarté avec sa raison
(note, VF, jeunesse, blockbuster, pas un film…) et la fiche SensCritique
retenue — pratique pour régler les seuils.

## Sources des programmes

- **Intimes** — API GraphQL kinoheld (`next-live.kinoheld.de/graphql`,
  cinéma 2423). Le site n'affiche les horaires que dans un iframe kinoheld ;
  l'API donne titre original, réalisateur, année et flags de langue.
- **Lichtblick** — HTML de `lichtblick-kino.org` (calendrier `kal_tag`) + pages film.
- **B-ware! Ladenkino** — API kinoheld (cinéma 108, `b-ware-ladenkino`) : le site
  `ladenkino.de` n'affiche les séances que dans un eframe kinoheld.

Chaque ami ne reçoit que les films des cinémas qu'il suit (/suivre), et sur la
fiche d'un film seulement les séances de ces cinémas-là.
- **Babylon** — HTML de `babylonberlin.eu/programm` (une vignette par séance)
  + page du film : rubrique (FILM, ORCHESTER, LITERATUR…), tags
  (english-ov, stummfilm-live…).

Ajouter un cinéma vendu via kinoheld = une entrée `source: kinoheld` avec son
`kinoheld_cinema_id` dans `cinema.yaml` (id trouvable via la requête GraphQL
`cinemas(search: "nom")`).

## Notes

1. **SensCritique** (principal) — API GraphQL publique du site
   (`apollo.senscritique.com`, requête `searchProductExplorer`). La recherche
   couvre les titres originaux : « Der Himmel über Berlin » → *Les Ailes du désir*.
   Le bon film est choisi par **titre + réalisateur + année (±2)** ; sans
   réalisateur ni année, seul un titre identique et récent est accepté.
2. **Letterboxd** (repli) — si SensCritique ne trouve pas le film ou a trop peu
   de votes. Page film devinée par slug (`the-killer`, `primetime-2026`) et
   vérifiée par réalisateur/année.

Seuils par défaut : SensCritique ≥ 7,0 (≥ 50 votes) ou Letterboxd ≥ 3,6
(≥ 300 votes). Le synopsis SensCritique (en français) sert de pitch.

## Filtres de goût (`cinema.yaml`)

- **Versions** : une séance en version allemande d'un film non germanophone
  (doublée) est écartée ; les films allemands en VO sont gardés.
- **Pas un film** : rubriques Babylon `LITERATUR`, `KONZERTE`, `THEATER`… et
  titres « Talk », « Workshop », « Networking »… — sauf ciné-concerts (muet +
  orgue/orchestre).
- **Jeunesse / grand public** : genres (Familie, Famille…), mots-clés (Pixar,
  Marvel, Kinderkino…), flags kinoheld (`family`), blockbusters récents
  (beaucoup de votes + genre spectacle), sorties « aussi en VF » de genre
  spectacle (animation familiale, fantasy).
- `always_include` / `always_exclude` pour forcer un titre.
- `max_films: 10` — tri par note, avec `min_recent: 3` places réservées aux
  films de moins de `recent_max_age` (3) ans quand il y en a, pour que les
  rétrospectives ne prennent pas tout.
- `show_unrated: true` — les films récents qui passent tous les filtres mais
  n'ont pas encore assez de votes (premières, festivals, docs) sont listés en
  une ligne « 🆕 Pas encore notés » (titre · cinéma · jour).

## Le message

Une section par soir (« 📅 Lundi 9 »), séances par ordre d'heure. Chaque
séance : heure (lien de réservation) · film (année, réalisateur) · ★ note
(lien SensCritique/Letterboxd) · cinéma · version. La première fois qu'un film
apparaît dans la semaine : bloc complet avec le pitch ; les soirs suivants :
une ligne compacte « (↑ lun. 9) ».

## Automatisation

`.github/workflows/cinema.yml` : **dimanche 05:17 UTC** (06:17 ou 07:17 à
Berlin) + un créneau de secours à 07:17 UTC (GitHub saute ou retarde parfois
un cron). Le Worker mémorise la semaine envoyée (`settings.cinema_week`) : le
second créneau n'envoie rien si le premier est passé. Le bouton *Run workflow*
force un renvoi (`--force`). Sans bot multi-utilisateurs (pas de mémoire), le
créneau de secours n'envoie rien. Mêmes secrets `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID` que le reste du bot.

## Horaires

- `evening_from: "18:00"` — séances du soir seulement (les séances après minuit
  comptent pour la veille).
- `latest_start: {time: "22:00", days: [0,1,2,3,4]}` — du lundi au vendredi,
  pas de séance qui commence après 22:00 (22:00 pile passe) ; le week-end, pas
  de limite. L'en-tête l'annonce : « séances 18:00–22:00 en semaine, 18:00+ le
  week-end ».

## Programme pas encore publié

Les cinémas publient à des rythmes différents : le dimanche, l'Intimes (semaine
jeudi→mercredi, publiée le mercredi/jeudi) n'a en général que lun.→mer. Le
récap montre ce qui est connu et ajoute une ligne discrète
« ⏳ Intimes : programme connu jusqu'au mer. 12 » (date de la dernière soirée
publiée, si elle s'arrête plus d'un jour avant la fin de la semaine).

Pas de complément du jeudi pour l'instant : il faudrait mémoriser les séances
déjà envoyées à chacun ; le récap du dimanche reste la seule source.

## Bot multi-utilisateurs : chacun ses cinémas

Avec les secrets `BOT_API_URL` / `BOT_API_TOKEN` (voir `worker/README.md`),
les cinémas de `cinema.yaml` apparaissent dans `/suivre` (groupe 🎬, après les
théâtres et les expos) et le récap part **à chaque ami, limité aux cinémas
qu'il suit** — rien s'il n'en suit aucun :

1. `POST /api/cinema-recipients` enregistre les cinémas (`venues.kind =
   'cinema'`, id `cinema-<slug>`) et renvoie `[{chat_id, venue_ids}]`. Les amis
   qui suivaient tout y sont abonnés d'office, comme pour un nouveau théâtre.
   Le scan théâtre ne désactive jamais un cinéma, et inversement.
2. Lecture des programmes, notes et filtres : **une seule fois**.
3. La sélection (plafond `max_films`, places « récents ») est **refaite par
   combinaison de cinémas** : qui ne suit que le B-ware! reçoit le top 10
   du B-ware!, pas les 2 films du B-ware! qui ont survécu au top 10
   global. Les pitchs (traductions) sont calculés une fois par film.
4. Envoi depuis GitHub Actions (429 respectés, petite pause entre messages) ;
   un ami qui a bloqué le bot (403) est désactivé via `POST /api/sent`.

Chaque ami le reçoit dans **sa langue** (`/langue`) : en anglais, jours/mois
anglais, pas de titre français SensCritique, et le pitch vient de la
description du cinéma traduite en anglais (le synopsis SensCritique est en
français) — pas de pitch plutôt qu'un pitch dans une autre langue.

Sans ces secrets : un seul récap, tous cinémas, sur `TELEGRAM_CHAT_ID`.

```bash
./.venv/bin/python -m src.cinema --dry-run --only "B-ware! Ladenkino,Babylon"   # le récap d'un ami qui ne suit que ces deux-là
./.venv/bin/python -m src.cinema --dry-run --lang en                    # version anglaise
```

Le Babylon publie plusieurs semaines à l'avance.
