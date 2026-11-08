# 🎭 Bot multi-utilisateurs (Cloudflare Worker + D1)

Transforme le watcher en bot pour une bande d'amis :

- **Invitation** par lien secret (`/invite`), régénérable (`/nouveaulien`).
- **Chacun choisit ce qu'il suit** (`/suivre`) : théâtre par théâtre, lieu d'expo par lieu d'expo,
  cinéma par cinéma (🎬 : le ciné de la semaine ne contient que les cinémas suivis, voir `docs/cinema.md`).
- **Sous chaque notif** : ⭐ Intéressé·e · ✅ Vu · 🔕 Ignorer
  - ⭐ : la notif de chacun affiche « 👥 Intéressé·es : Léa, Max, toi » (mise à jour en direct) ;
    `/interets` liste ce qui tente la bande.
  - ✅ : plus aucune notif sur cette pièce/expo (même si elle revient la saison suivante),
    puis note 1–5★ et un petit mot facultatif, visibles par les autres sur leurs notifs et dans le récap.
  - 🔕 : plus jamais de notif sur cette pièce/expo, même si elle revient. `/ignores` pour annuler.
- **Notes** : la note presse Nachtkritik (théâtre) reste ; s'y ajoutent les notes des amis.
- **Expos** : une notif quand l'expo est annoncée, puis un rappel « ⏳ Dernières semaines »
  (14 j avant la fin, `expo_last_weeks_days`) à qui a mis ⭐ et ne l'a pas encore vue.
- **Groupe Telegram (facultatif)**, dans la langue de qui a tapé `/groupe` (`settings.group_lang`) :
  - annonces ⭐ avec « Moi aussi » / « ✅ Je l'ai vu aussi » ; dès 2 partant·es, l'annonce devient
    « 🎟 Plan ! A et B veulent voir X » avec les prochaines dates et le lien ;
  - avis complets (note, petit mot en entier, lieu, dates, lien) : posté à la note, puis complété
    (édition) quand le petit mot arrive ; « ✅ Je l'ai vu aussi » lance la note en privé et l'avis
    est posté en réponse au message du groupe ;
  - `/interets`, `/programme` (liste + boutons ⭐), `/aide` répondent DANS le groupe ;
  - le dimanche, « Le plan de la semaine » (ce qui tente au moins un membre) ;
  - un non-membre qui clique est envoyé vers le bot avec le lien d'invitation.
  Les notifs restent en privé : « vu » et « ignoré » sont personnels.
- **Parcourir le catalogue** : `/programme` (liste + choix d'un lieu), `/expos`, `/theatre` : une notif
  par pièce/expo du lieu choisi, avec ⭐ ✅ 🔕. Tout le catalogue a une version courte (`basic`
  dans `/api/render`), même ce qui n'a jamais été envoyé.
- **Langue par personne** (`/langue` ou `/language`, proposé à l'inscription) : 🇫🇷 français (défaut)
  ou 🇬🇧 anglais. Tous les textes du bot (commandes, boutons, récaps) et les notifs : le scraper
  rédige une variante anglaise (`items.text_en` / `line_en`, résumé repris de la page anglaise du
  théâtre ou traduit) seulement si un ami lit en anglais. Les annonces du groupe sont dans la
  langue de qui a tapé `/groupe`. Textes : `src/i18n.ts`.
- **Récap du dimanche** et `/programme` : par personne, sans ce qu'elle a vu/ignoré, avec la ligne 👥.
- Un nouvel ami (ou un lieu nouvellement coché) ne reçoit **pas** tout le catalogue en notifs :
  le scan suivant l'enregistre en silence ; `/programme` montre ce qui est déjà à l'affiche.

## Architecture

```
GitHub Actions (Python, inchangé : scraping, résumés, Nachtkritik)
   │  1. POST /api/plan    lieux + pièces           → ids à rédiger (seulement ce que quelqu'un doit recevoir)
   │  2. enrichit ces pièces (pages détail, critiques)
   │  3. POST /api/render  textes                    → messages par ami (+ boutons, ligne 👥)
   │  4. envoie sur Telegram, puis POST /api/sent    → mémorise dates + message_id
   │  (ciné) POST /api/cinema-recipients cinémas     → [{chat_id, venue_ids}], récap par ami
   ▼
Cloudflare Worker + D1  ◀── webhook Telegram (clics ⭐ ✅ 🔕, commandes)
   amis · abonnements · réactions · notes · ce qui a été envoyé à qui
```

Les envois des scans partent de GitHub Actions : le plan gratuit Cloudflare limite un Worker
à 50 requêtes sortantes par appel, insuffisant pour 10 amis × 20 nouveautés. Les clics
(quelques éditions de messages) sont gérés par le Worker, instantanément.

Sans les secrets `BOT_API_URL` / `BOT_API_TOKEN`, le scraper reste en mode « un seul chat » comme avant.

## Mise en service (≈ 15 min, gratuit)

Il faut un compte Cloudflare (gratuit). Le bot Telegram existant est réutilisé.

```bash
cd worker
npm install
npx wrangler login                                  # ouvre le navigateur
npx wrangler d1 create theatre-bot                  # → copie database_id dans wrangler.toml
npx wrangler d1 execute theatre-bot --remote --file=schema.sql
```

Dans `wrangler.toml`, renseigne :
- `OWNER_CHAT_ID` = ton `TELEGRAM_CHAT_ID` actuel (tu es l'admin) ;
- `BOT_USERNAME` = le @ du bot, sans @.

Secrets (garde `API_TOKEN` sous la main pour GitHub) :

```bash
npx wrangler secret put BOT_TOKEN          # = TELEGRAM_BOT_TOKEN actuel
openssl rand -hex 24                        # → à coller comme API_TOKEN
npx wrangler secret put API_TOKEN
openssl rand -hex 16                        # → à coller comme WEBHOOK_SECRET
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy                         # → https://theatre-bot.<toi>.workers.dev
```

Brancher Telegram sur le Worker (webhook + menu des commandes) :

```bash
curl -X POST -H "Authorization: Bearer <API_TOKEN>" https://theatre-bot.<toi>.workers.dev/api/setup
```

GitHub → Settings → Secrets → Actions, ajoute :
- `BOT_API_URL` = `https://theatre-bot.<toi>.workers.dev`
- `BOT_API_TOKEN` = le même `API_TOKEN`

Puis :
1. Sur Telegram, envoie `/start` au bot.
2. Onglet Actions → *Scan Berlin theatres* → **Run workflow** : le 1er passage enregistre le
   catalogue en silence ; les nouveautés arrivent à partir du suivant.
3. `/invite` → partage le lien. Tu es prévenue à chaque inscription.
4. (Facultatif) crée un groupe Telegram avec tes amis, ajoute le bot, tape `/groupe` dedans.

> Une fois le webhook posé, `python -m src.get_chat_id` (qui utilise getUpdates) ne marche
> plus : c'est normal.

## Commandes

Tout le monde : `/suivre` `/programme` `/expos` `/theatre` `/interets` `/vus` `/ignores` `/langue` (`/language`) `/aide` `/stop`
Dans le groupe : `/interets` `/programme` `/aide`
Admin : `/invite` `/nouveaulien` `/membres` `/groupe` (dans un groupe) `/plusdegroupe`

## Tests

```bash
npm run typecheck
npm test        # wrangler dev + D1 local + faux Telegram : scénario complet en 36 étapes
```

## Mettre à jour une base existante

`schema.sql` ne crée que ce qui manque ; une colonne ajoutée à une table existante passe par
`migrations/` (à lancer une seule fois) :

```bash
npx wrangler d1 execute theatre-bot --remote --file=migrations/001_lang.sql   # users.lang, items.text_en/line_en
```

Après un changement du menu des commandes (`COMMANDS` dans `src/index.ts`), relancer `/api/setup`.

## Ajouter un lieu

Ajoute-le dans `config.yaml` (avec `kind: expo` pour une expo, et un parser dans
`src/parsers/`). Au scan suivant il apparaît dans `/suivre` ; les amis qui suivaient
déjà tout y sont abonnés d'office, en silence pour le catalogue existant.
