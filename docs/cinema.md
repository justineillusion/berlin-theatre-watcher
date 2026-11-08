# 🎬 Ciné de la semaine

Chaque **lundi matin**, un message Telegram avec les films à voir **le soir
(dès 18h) dans les 7 jours** à l'**Intimes** (Friedrichshain), au
**Lichtblick-Kino** (Kastanienallee) et au **Babylon** (Mitte) — uniquement des
films **bien notés**, **en VO** (OmU / OmeU / OV), et **pas grand public**.

```bash
./.venv/bin/python -m src.cinema --dry-run                    # affiche message + rapport, n'envoie rien
./.venv/bin/python -m src.cinema --dry-run --start 2026-11-09 # semaine commençant un autre jour
./.venv/bin/python -m src.cinema                              # envoie (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)
```

Le `--dry-run` imprime aussi un **rapport** : chaque film écarté avec sa raison
(note, VF, jeunesse, blockbuster, pas un film…) et la fiche SensCritique
retenue — pratique pour régler les seuils.

## Sources des programmes

- **Intimes** — API GraphQL kinoheld (`next-live.kinoheld.de/graphql`,
  cinéma 2423). Le site n'affiche les horaires que dans un iframe kinoheld ;
  l'API donne titre original, réalisateur, année et flags de langue.
- **Lichtblick** — HTML de `lichtblick-kino.org` (calendrier `kal_tag`) + page
  de chaque film : version entre parenthèses (OmU, OmeU, OV), crédits
  « USA 2006, 123 min, Regie: … ».
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

`.github/workflows/cinema.yml` : lundi 06:17 UTC (07:17 ou 08:17 à Berlin),
+ bouton *Run workflow*. Utilise les mêmes secrets `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID` que le reste du bot. Aucun état n'est stocké.

⚠️ L'Intimes publie sa semaine de programme le mercredi/jeudi (semaine
cinéma = jeudi→mercredi). Le script demande déjà à kinoheld les 7 jours de la
fenêtre : dès que la semaine suivante est en ligne, elle est prise. Un lundi,
ce n'est en général pas encore le cas (vérifié le 08/11/2026 : rien du 12 au
18/11 hormis la séance spéciale du 13), donc l'Intimes ne couvre que lun.→mer.
Le Lichtblick et le Babylon publient plusieurs semaines à l'avance.
