# 🎭 Berlin Theatre Watcher

Reçois une **notification push Telegram** quand un spectacle susceptible de te
plaire apparaît à la **Schaubühne**, au **Berliner Ensemble** ou à la
**Volksbühne** — avec **surtitres anglais**, **pas complet**, et le **lien de
réservation**.

## Comment ça marche

1. **Fetch** — récupère les pages "programme / English surtitles" des 3 théâtres.
2. **Extraction (LLM)** — Claude lit chaque page et en extrait une liste
   structurée de représentations (titre, date, langue, surtitres EN, sold-out,
   lien de résa). Robuste aux refontes de site, contrairement à des sélecteurs CSS.
3. **Filtres durs** — on ne garde que : surtitres anglais **et** non complet.
4. **Scoring (LLM)** — Claude note chaque candidat 0–10 selon **ton profil de
   goût** (`config.yaml`), avec un bonus fort pour l'international / non-allemand.
5. **Dédup + notif** — au-dessus du seuil et pas déjà vu → message Telegram avec
   le lien de résa. L'état est stocké dans `state/seen.json` pour ne pas te
   spammer deux fois.
6. **Cron** — tourne tout seul chaque jour via GitHub Actions.

```
config.yaml ─┐
             ▼
   fetch → extract(LLM) → filtres → score(LLM) → dédup → Telegram
             ▲                                      │
        3 théâtres                          state/seen.json
```

## Setup

### 1. Bot Telegram
- Sur Telegram, écris à **@BotFather** → `/newbot` → récupère le **token**.
- Envoie « hi » à ton nouveau bot.
- Récupère ton `chat_id` :
  ```bash
  pip install -r requirements.txt
  TELEGRAM_BOT_TOKEN=xx: python -m src.get_chat_id
  ```

### 2. Test en local

**Dry-run** (recommandé pour un premier essai) — affiche les résultats dans le
terminal, sans Telegram, sans modifier l'état. Nécessite **seulement** la clé
Anthropic :
```bash
ANTHROPIC_API_KEY=sk-ant-... ./.venv/bin/python -m src.main --dry-run
```

**Run complet** (envoie sur Telegram) :
```bash
cp .env.example .env       # remplis les 3 valeurs
set -a; source .env; set +a
./.venv/bin/python -m src.main
```

### 3. Automatisation (GitHub Actions)
- Pousse ce repo sur GitHub.
- **Settings → Secrets and variables → Actions** → ajoute :
  `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Onglet **Actions** → *Scan Berlin theatres* → **Run workflow** pour un test.
- Ensuite ça tourne tous les jours à ~10h (Berlin).

## Personnalisation

Tout est dans **`config.yaml`** :
- `taste_profile` — ton texte de goûts (le cœur du système, sois précis).
- `score_threshold` — sévérité des alertes (7 par défaut).
- `theaters` — URLs à scanner + notes.

## Limites connues

- **Sites en JavaScript.** L'extraction lit le HTML servi. Si un théâtre passe à
  un rendu 100 % JS, la page arrivera vide → il faudra soit trouver son endpoint
  JSON, soit ajouter un rendu headless (Playwright). Le Berliner Ensemble
  (`/en/surtitles`) est en HTML statique et marche directement.
- **Détection sold-out** — dépend de ce qu'affiche la page. Si l'info n'est pas
  visible, `sold_out = inconnu` et on t'alerte quand même (mieux vaut trop que pas
  assez).
- **Coût LLM** — quelques centimes par run (2 appels Claude/jour). Négligeable.
- **Dédup par titre+date** — une pièce à 5 dates peut générer jusqu'à 5 alertes.
  Ajuste dans `src/main.py` si tu préfères une alerte par pièce.
