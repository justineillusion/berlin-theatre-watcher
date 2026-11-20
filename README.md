# 🎭 Berlin Encore!

Ce qui se joue à Berlin quand on ne parle pas (assez) allemand : **théâtre et opéra avec surtitres
anglais**, **films en VO**, **expos**, **concerts**. Et surtout : voir ce qui tente ses amis et **y aller
ensemble**.

- **App web** : [berlinencore.app](https://berlinencore.app) (s'installe sur l'écran d'accueil, notifications
  push, Face ID, marche hors ligne avec les dernières données).
- **Bot Telegram** : les mêmes données, alertes et récap ciné du dimanche.

## Ce que fait l'app

- **À l'affiche** : tout le programme, filtrable par type (théâtre, musique, ciné, expo), par moment
  (ce soir, demain, week-end, 7 jours) et par lieu. Étiquettes : surtitres EN, VO, genre du film,
  🏆 festival (Cannes, Berlinale, Venise…), complet, fin d'expo proche.
- **Fiche** : dates, langue, prix, résumé (FR/EN), avis presse (Nachtkritik, buzz presse,
  SensCritique / Letterboxd pour les films), lien billets, plan.
- **Mes sorties** : propositions reçues (oui en un toucher, ou non avec une raison), billets (« C'est
  calé »), envies, avis à donner ; calendrier du mois ; tirer vers le bas pour actualiser.
- **Entre amis** : ★ envies visibles par les amis, propositions avec dates (l'organisateur peut inviter
  d'autres amis en cours de route), « Ils viennent » sur un billet, notifications (🔔 + push).
- **Lieux** (≈ 37) : Schaubühne, Berliner Ensemble, Volksbühne, Deutsches Theater, Gorki, HAU,
  Sophiensæle, Festspiele, English Theatre, Chamäleon, ACUD ; opéras (Staatsoper, Deutsche Oper,
  Komische Oper), Philharmonie, Staatsballett, Schokoladen, Urban Spree ; expos (Hamburger Bahnhof,
  Neue Nationalgalerie, Gropius Bau, KW, C/O, Berlinische Galerie, Fotografiska) ; cinémas (Babylon,
  Kino International, Delphi LUX, FaF, Passage, Odeon, Rollberg, Wolf, Intimes, Lichtblick, B-ware!).

## Comment ça marche

```
GitHub Actions (cron)                         Cloudflare
  scan.yml     théâtres, opéras, expos  ─┐
  cinema.yml   films (lun → dim)         ├─►  Worker (worker/)  ──►  D1 « theatre-bot »  ──►  app web + bot
  critics.yml  Nachtkritik (nuit)        │      API, push, bot          items, reactions,
  press.yml    buzz presse               ┘                              proposals, users…
```

1. **Scrapers Python** (`src/parsers/`, `src/cinema/sources/`) : un lecteur par lieu.
2. **Règles** : théâtre seulement si surtitré EN, joué en anglais ou sans paroles ; films en VO ;
   résumés traduits FR/EN (`state/summary_cache.json`).
3. **Envoi au Worker** (`src/botapi.py`) : les fiches arrivent dans D1. Un lieu dont le site plante
   garde son dernier programme ; rien n'est jamais supprimé (`last_seen` dit quand la pièce a été vue).
4. **App** : `worker/src/app.html` (une page), API `worker/src/app.ts`.

**Base de données** : Cloudflare D1 `theatre-bot` (dash.cloudflare.com → Storage & Databases → D1 →
Console pour le SQL).

**Ajouter un lieu** : un parser dans `src/parsers/` (enregistré dans `SOURCES`), une entrée dans
`config.yaml` (ou `cinema.yaml`), le quartier dans `worker/src/districts.ts`, un test avec une page
enregistrée dans `tests/fixtures/`. Théâtre : sa rubrique Nachtkritik dans `src/critics.py`
(`tests/test_nachtkritik_coverage.py` échoue sinon).

## Tests

```bash
python3 -m pytest -q tests          # scrapers, langues, prix, presse, festivals (≈ 110)
cd worker && npm test               # API du Worker (47 étapes) ; npx tsc --noEmit -p . pour les types
```

## Tester tout de suite (aucune clé requise)

```bash
cd berlin-theatre-watcher
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m src.main --dry-run
./.venv/bin/python -m src.main --dry-run --lang en   # les notifs telles que les lit un ami anglophone
```

Ça affiche dans le terminal tous les spectacles retenus, avec ⭐ pour ceux qui
matchent tes mots-clés. Rien n'est envoyé, rien n'est modifié.

## Recevoir les push (Telegram)

### 1. Créer le bot
- Sur Telegram, écris à **@BotFather** → `/newbot` → récupère le **token**.
- Envoie « hi » à ton nouveau bot.
- Récupère ton `chat_id` :
  ```bash
  TELEGRAM_BOT_TOKEN=xxx ./.venv/bin/python -m src.get_chat_id
  ```

### 2. Run complet en local
```bash
cp .env.example .env       # remplis les 2 valeurs
set -a; source .env; set +a
./.venv/bin/python -m src.main
```

### 3. Automatisation (GitHub Actions)
- Pousse ce repo sur GitHub.
- **Settings → Secrets and variables → Actions** → ajoute
  `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID`.
- Onglet **Actions** → *Scan Berlin theatres* → **Run workflow** pour un test.
- Ensuite ça tourne tous les jours à ~10h (Berlin).

## 🔕 Ne plus suivre une pièce (mode un seul chat)

Chaque notification (pièce ou expo) porte un bouton **🔕 Ne plus suivre**.
Touche-le et la pièce disparaît des scans quotidiens, des ouvertures de vente
et du récap du dimanche — fini les « 🆕 Nouvelles dates » pour une pièce qui ne
t'intéresse pas.

- **Pas instantané** : aucun serveur n'écoute Telegram en continu. Le clic
  reste en attente chez Telegram et c'est le **prochain scan** (2 par jour) qui
  le lit (`getUpdates`), modifie le bouton en « ↩️ Réactiver » et t'envoie une
  petite confirmation silencieuse. Telegram garde ces clics **24 h** : avec
  deux scans par jour, aucun ne se perd.
- **Réactiver** : bouton « ↩️ Réactiver » sous la notification, ou envoie
  `/muets` au bot : il répond (au scan suivant) avec la liste des pièces
  masquées, une touche « Réactiver » par pièce.
- **État** : `state/muted.json` (pièces masquées + position de lecture
  Telegram), committé par les workflows *scan* et *presale*. Le *récap* ne fait
  que le lire (il applique en mémoire les clics pas encore traités, sans rien
  écrire). Pour démasquer à la main : supprime l'entrée du fichier.
- L'identifiant d'une pièce est un hash court du couple théâtre + titre
  (`Show.key()`) : une pièce de répertoire qui revient reste masquée.
- Envie de boutons instantanés ? C'est ce que fait le bot multi-utilisateurs
  ([`worker/`](worker/README.md), bouton 🔕 Ignorer) une fois déployé. Attention :
  avec son webhook actif, `getUpdates` ne marche plus, donc ce mode-ci s'éteint
  de lui-même (le scan affiche un avertissement et garde la liste connue).

Test hors-ligne : `./.venv/bin/python -m tests.test_mute`.

## Personnalisation — `config.yaml`

- `keywords_love` — tes goûts (mis en avant avec ⭐).
- `keywords_avoid` — ce que tu ne veux jamais voir (exclu).
- `require_keyword_match` — `false` : tout ce qui est surtitré EN et dispo ;
  `true` : uniquement ce qui matche `keywords_love`. Commence à `false` pour
  voir le volume, passe à `true` si trop de bruit.

## Note presse (Nachtkritik)

Quand la pièce a été critiquée sur [nachtkritik.de](https://nachtkritik.de), le
bot lit la **Kritikenrundschau** (le résumé des critiques de la SZ, FAZ, taz,
Tagesspiegel…) et affiche une **note estimée** :

```
📰 Presse : ★★★☆☆ 3/5 · 10 critiques (👍4 😐1 👎5)
```

Nachtkritik ne donne pas de note : chaque paragraphe est noté avec un petit
lexique allemand pondéré (`src/critics.py`), puis on fait la moyenne. C'est
une **estimation** — fiable pour distinguer un triomphe d'un four, moins pour
l'ironie ; la répartition 👍/😐/👎 aide à repérer les avis partagés. Pas de
ligne 📰 = pas de critique trouvée (ou moins de 2 avis). Désactivable avec
`critics_rating: false`.

Pour trouver la critique, le bot lit d'abord la **rubrique Nachtkritik du
théâtre** (`/nachtkritiken/…/berlin/schaubuehne-berlin`, 4 pages ≈ 150
critiques) et y compare le titre — y compris le titre allemand tiré de l'URL
du spectacle (`…/en/produktionen/der-geizige.html` → « Der Geizige » pour
« The Miser »). La recherche plein texte de Nachtkritik, lente (5–30 s) et
capricieuse, ne sert plus que de repli (Festspiele, créations à l'étranger).

Tout est mis en cache dans `state/critics_cache.json` (rubriques : 6 h pour la
1re page, 30 j pour les suivantes ; recherches : 3 j ; notes : 12 h tant que la
critique a moins d'un mois — la Rundschau s'étoffe après la première — puis
60 j). Un échec réseau n'est jamais mis en cache.

**Seul le job de nuit `critics.yml` (04:30 UTC) va sur Nachtkritik**
(`python -m src.critics_refresh`) : rubriques des maisons (BE, Schaubühne,
Volksbühne, Deutsches Theater, Gorki, HAU, Sophiensæle, English Theatre, Chamäleon, Festspiele), lecture des critiques (≤ 10 s par pièce), recherche du
site seulement pour les pièces absentes des rubriques (≤ 45 s par pièce), 5 min
en tout ; il logue la durée de chaque pièce (listing / search / missed) et le
taux de notes, puis committe le cache. Tous les autres jobs (scan, ventes,
récap) lisent le cache **sans réseau** : instantané. Une pièce « missed » est
retentée la nuit suivante. Coproduction critiquée sous un festival partenaire :
acceptée si le générique de la critique nomme la maison berlinoise.

## Horizon : maintenant ou la semaine prochaine

`horizon_expo_days: 7` et `horizon_theatre_days: 365` (config.yaml) : partout
(notifs, /programme, /interets, groupe, récaps), une expo n'apparaît que si elle
est ouverte ou ouvre sous 7 jours, une pièce dès qu’une date est en vente (365 j)
(et seules ces dates sont affichées). Le reste est gardé en base sans bruit et
annoncé une fois en entrant dans la fenêtre.

Une pièce pas encore créée n'a pas de critique : la note apparaît dans les
alertes suivantes (nouvelles dates) et dans le récap du dimanche.

## Limites connues

- **Schaubühne** — son programme est chargé en AJAX (POST paginé). Le parser
  (`src/parsers/schaubuehne.py`) reproduit cet appel ; c'est donc un peu plus
  fragile que les deux autres si le site change son mécanisme de chargement.
- **Structure des sites** — si un théâtre refait son
  site, les parsers (`src/parsers/`) peuvent casser et devront être ajustés.
- **Sold-out** — détecté via la page (absence de bouton Tickets au BE, classe
  `ticket-status--sold-out` à la Volksbühne). Si l'info manque, on notifie quand
  même (mieux vaut trop que pas assez).
- **1 alerte par pièce** — les multiples dates d'une même pièce sont regroupées
  (prochaine date + « +N autres dates »). Tu es notifiée une fois par production.

## Structure

| Fichier | Rôle |
|---|---|
| `config.yaml` | mots-clés + théâtres à scanner |
| `src/parsers/` | un parser HTML par théâtre (+ `expos.py` pour les lieux d'expo) |
| `src/botapi.py` | mode multi-utilisateurs : dialogue avec le Worker |
| `worker/` | bot Telegram multi-utilisateurs (Cloudflare Worker + D1) |
| `src/matching.py` | filtres durs + mots-clés |
| `src/notify.py` | message Telegram |
| `src/state.py` | `seen.json` (anti-doublon) |
| `src/mute.py` | bouton 🔕 Ne plus suivre + `/muets` (`state/muted.json`) |
| `src/main.py` | orchestration (`--dry-run` dispo) |
| `.github/workflows/scan.yml` | cron quotidien |
| `src/cinema/` | films : séances (Yorck, kinoheld, Babylon…), notes, genres et festivals (`tags.py`) |
| `src/critics.py` / `src/press.py` | note Nachtkritik / buzz presse |
