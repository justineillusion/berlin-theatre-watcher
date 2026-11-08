# 🎭 Berlin Theatre Watcher

Reçois une **notification push Telegram** quand un spectacle susceptible de te
plaire apparaît à la **Schaubühne**, au **Berliner Ensemble** ou à la
**Volksbühne** — avec **surtitres anglais**, **pas complet**, et le **lien de
réservation**.

> Version **sans clé API, 100 % gratuite**. Le scan lit directement le HTML des
> pages « programme / English surtitles » et filtre par mots-clés. Aucun compte
> à créer pour tester.

> 👥 **Nouveau : mode bande d'amis.** Invitations, choix des lieux par personne,
> boutons ⭐ Intéressé·e / ✅ Vu / 🔕 Ignorer, notes des amis, lieux d'expo
> (Hamburger Bahnhof, Neue Nationalgalerie, KW, C/O Berlin, Berlinische Galerie),
> et 🎬 cinémas (Intimes, Lichtblick, Babylon : chacun reçoit le ciné de la semaine
> de ses cinémas, voir [`docs/cinema.md`](docs/cinema.md)).
> Mise en service : [`worker/README.md`](worker/README.md).

## Comment ça marche

1. **Fetch + parse** — récupère les pages des théâtres et en extrait les
   représentations (titre, date, lieu, langue, sold-out, lien de résa) avec un
   parser dédié par théâtre.
2. **Filtres durs** — on ne garde que : **surtitres anglais** *et* **pas complet**.
3. **Mots-clés** — `keywords_avoid` exclut ; `keywords_love` met en avant (⭐) les
   spectacles qui matchent tes goûts (metteur·ses en scène, autrices/auteurs,
   pays, thèmes).
4. **Dédup + notif** — les nouveautés partent sur Telegram avec le lien de résa.
   `state/seen.json` évite de te spammer deux fois.
5. **Cron** — tourne tout seul chaque jour via GitHub Actions.

```
config.yaml ─┐
             ▼
   fetch → parse → [surtitres EN + pas complet] → mots-clés → 1/pièce → Telegram
             ▲                                                         │
  Schaubühne, Berliner Ensemble, Volksbühne                   state/seen.json
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
60 j). Un échec réseau n'est jamais mis en cache. Les ouvertures de vente
(`--no-critics`) n'interrogent pas Nachtkritik mais reprennent les notes déjà
en cache. ⚠️ Pour que le cache serve d'un run à l'autre, les workflows doivent
committer `state/critics_cache.json` avec `state/seen.json`.

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
