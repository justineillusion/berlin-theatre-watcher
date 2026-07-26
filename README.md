# 🎭 Berlin Theatre Watcher

Reçois une **notification push Telegram** quand un spectacle susceptible de te
plaire apparaît à la **Schaubühne**, au **Berliner Ensemble** ou à la
**Volksbühne** — avec **surtitres anglais**, **pas complet**, et le **lien de
réservation**.

> Version **sans clé API, 100 % gratuite**. Le scan lit directement le HTML des
> pages « programme / English surtitles » et filtre par mots-clés. Aucun compte
> à créer pour tester.

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

## Personnalisation — `config.yaml`

- `keywords_love` — tes goûts (mis en avant avec ⭐).
- `keywords_avoid` — ce que tu ne veux jamais voir (exclu).
- `require_keyword_match` — `false` : tout ce qui est surtitré EN et dispo ;
  `true` : uniquement ce qui matche `keywords_love`. Commence à `false` pour
  voir le volume, passe à `true` si trop de bruit.

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
| `src/parsers/` | un parser HTML par théâtre |
| `src/matching.py` | filtres durs + mots-clés |
| `src/notify.py` | message Telegram |
| `src/state.py` | `seen.json` (anti-doublon) |
| `src/main.py` | orchestration (`--dry-run` dispo) |
| `.github/workflows/scan.yml` | cron quotidien |
