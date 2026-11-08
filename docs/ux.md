# Règles d'écriture des cartes (toutes surfaces : push, /programme, groupe, récaps)

- **📝 replié** : le résumé est un `<blockquote expandable>📝 …</blockquote>` (fermé par défaut, on le déroule
  dans Telegram) — pièces, expos, films, fr et en. Une fiche trop longue est coupée sans casser le HTML.

1. **Zéro remplissage.** Une ligne n'existe que si elle apprend quelque chose d'utile.
   Jamais « pas encore de critiques », « pas encore ouvert », « couvert, pas d'avis »,
   « en allemand (probable) », « rien de neuf ». Si on ne sait pas : on n'écrit rien.
2. **Jamais de contradiction.** Une carte ne peut pas dire « pas de critique » et afficher une note.
   La ligne 📰 = note Nachtkritik (sans lien) et/ou buzz presse tranché, sinon absente.
3. **Ce qui est intéressant d'abord :** titre, lieu, dates, puis 📝 synopsis (2–3 phrases, de quoi ça parle —
   pas « mis en scène par X »), puis 📰 si elle existe.
4. **Langue :** uniquement celle de l'utilisateur (fr/en). Langue jouée seulement si ce n'est pas l'allemand.
5. **Crédits courts** (auteur / mise en scène), sans bruit de site (« World Premiere », « Stage A », promos).

## 🎟 Réservé !

- **Une fiche = un message qui évolue** (édition sur place, pas de nouveau message) :
  🎟 transforme LA fiche en sélecteur (en-tête « 🎭 Titre (Lieu) » + « 🎟 Pour quelle date ? ») : les ~6
  prochaines dates connues (expos : Aujourd'hui / Demain / Ce week-end), **📅 Autre date**, **↩︎ Retour**.
  Choisir une date remet la fiche complète, avec « 🎟 Réservé · sam. 9 janv. 20:00 ».
- 📅 Autre date : force_reply (inévitable) ; à la réponse, la fiche d'origine est mise à jour, puis
  l'invitation et la réponse sont supprimées (si Telegram le permet ; erreurs ignorées).
- ✅ Vu : les 1–5★ apparaissent sur la fiche. ✍️ avis : force_reply ; ensuite la fiche affiche
  « ✅ Vu · 4★ · « … » » et l'invitation + la réponse sont supprimées.
- Depuis /sorties : le sélecteur remplace la liste (même message) ; ↩︎ revient à la liste ; une date,
  ✖ Retirer ou ❌ Annuler la réservation la remettent à jour.
- Réserver = ⭐ intéressé·e. La fiche affiche « 🎟 Réservé · sam. 9 janv. 19:30 » et le bouton
  « Annuler / changer la date ».
- Groupe : « 🎟 X a réservé Y — quand · lieu » + **🙋 J'y vais aussi** (⭐ + lien de réservation en privé).
- /interets et « Nos envies » : les réservations d'abord.
- Le lendemain de la date : « Alors, c'était comment ? » 1–5★ (une seule fois) ; la note marque « vu ».
- Un item réservé n'est jamais reproposé.

## Boutons d'une fiche : la prochaine étape seulement

Même code (worker/src/lib.ts `keyboard`) pour fr/en, les fiches privées et /programme. Les messages du groupe
gardent leurs boutons partagés ([🙋 Moi aussi] [✅ Je l'ai vu aussi]) : l'état y est par personne, il se
règle donc en privé.

- **Proposé** : [⭐ Intéressé·e] [🙅 Pas pour moi] (+ [✅ Déjà vu] si à l'affiche : expo ouverte ;
  pièce / film commencé et encore programmé — pour noter ce qu'on a vu ailleurs).
- **⭐** : [🎟 Réserver] [✅ Déjà vu] / [↩︎ annuler ⭐].
- **🎟 réservé** : avant la date [📅 Changer la date] ; dès le lendemain [★ Noter].
- **✅ vu, pas noté** : [1★] … [5★]. **Noté** : [✍️ Critique] tant qu'il n'y a pas d'avis, puis
  [✏️ Modifier] (la fiche affiche « ✅ Vu · ★★★★☆ · « … » »). Plus d'invitation automatique après la note.
- **✏️ Modifier** (sur place, aussi depuis /sorties) : [1★] … [5★] (note actuelle marquée « · 4★ · »),
  puis [✍️ Réécrire la critique] [↩︎ Retour]. Changer la note met la fiche à jour ; le groupe n'est
  annoncé qu'à la 1re note.
- **🙅** : [↩︎ Annuler].
- en : Interested / Not for me / Already seen ; Book / Already seen / undo ⭐ ; Change date / Rate ;
  Review ; Edit / Rewrite review / Back ; Undo.

## Trois commandes

Menu « / » (privé, fr/en) : **/programme** (à l'affiche), **/sorties** (« Mes sorties » / « My outings »),
**/reglages** (« Réglages » / « Settings »). Les anciennes (/interets, /vus, /suivre, /ignores, /langue,
/aide…) restent en alias cachés. Le groupe garde /interets et /programme.

- **/sorties** : une seule liste — 🎟 Réservé (date ↑), ⭐ Intéressé·e, ✅ Vu (10 derniers, ma note) ;
  les noms de la bande sous chaque item ; icône du type (🎭 / 🖼 / 🎬) sur chaque ligne.
  Un bouton pleine largeur par item : « 🎭 Titre · 🎟 » (⭐) ou « 🎭 Titre · 🎟 sam. 9 janv. » (réservé) →
  sélecteur de dates, dont la dernière ligne est [✅ Déjà vu] [✖ Retirer] (✖ = retirer ⭐ et la réservation,
  sans « ignorer » ; /sorties se met à jour sur place). Vu : « 🎭 Titre · ★ » (noter) ou « · ✍️ » (avis).
- **/reglages** : un message, 4 boutons — 📍 Lieux, 🌐 Langue, 🙅 Pas pour moi, 👥 Groupe.
- **🙅 Pas pour moi** remplace 🔕 Ignorer et ✖ partout côté utilisateur (sur une fiche : jamais reproposé ;
  dans /sorties, c'est ✖ Retirer).

## Lot du matin (nouveautés)

- Plus de push par fiche : le scan met en file (D1 `daily_queue`) les pièces / expos nouvelles, les
  nouvelles dates et les « dernières semaines » d'une ⭐.
- À partir de 9:00 (Berlin, cron Worker /15 min) : **au plus un message par jour et par personne**.
  Sections (vides = omises) : « 🆕 Nouveau dans tes lieux (n) », « 🗓 Nouvelles dates (n) » (ligne +
  dates), « ⏳ Dernières semaines (n) ». Une ligne compacte par item (25 max, puis « +n autres : /programme »).
- Un bouton pleine largeur par item (« 🎭 Titre ») → la fiche complète en message à part ; elle devient
  « ma notif » (mises à jour sur place, ⭐, 🎟…).
- Arrivé après le lot du jour : attend le lendemain. Rien en file : rien.
- Restent immédiats : ouvertures de vente, « X a réservé » (groupe), « Alors, c'était comment ? ».
- **Nouvelles dates urgentes, hors lot** (un message compact par personne, une ligne par pièce
  « 🎟 Titre (Lieu) : 12/12 19:30, … » avec le lien de réservation) :
  « 🎟 Nouvelles dates pour tes ⭐ » — toujours, n'importe quel jour (une ⭐ qui reçoit des dates = réserver
  maintenant) ; et le jour d'ouverture des ventes d'un lieu (de l'heure d'ouverture à minuit), toutes ses
  nouvelles dates : « 🗓 Aussi de nouvelles dates (vente ouverte) ». Une pièce nouvelle va quand même au lot.

## Récap du dimanche (9:00 Berlin, Worker)

- Un message d'en-tête par personne, puis les fiches films de la semaine (une par film, ⭐ ✅ 🙅).
  Sections (vides = omises ; tout vide et pas de film = rien) :
  « 🎟 Tes 🎟 cette semaine » (mes réservations d'aujourd'hui à dimanche prochain, date + lieu),
  « 🖼 Expos qui ouvrent cette semaine » (lieux suivis, ni vues ni 🙅), le lot du jour (🆕 / 🗓 / ⏳, avec
  ses boutons), puis le titre du ciné de la semaine (« 🎬 Ciné de la semaine — … »).
- Le job ciné (GitHub, dimanche matin) met les fiches en file (`film_queue`) au lieu de les envoyer ;
  le récap attend les films jusqu'à midi, puis part sans. Films arrivés après midi : envoi direct, comme avant.
- Le dimanche remplace le lot du matin (un seul envoi) ; après 15:00, plus rien jusqu'à lundi.
- L'ancien « Récap du dimanche » par personne (GitHub, 14:23) ne part plus ; le récap hebdo du groupe reste.

## Ouvertures de vente (Schaubühne, Berliner Ensemble, Volksbühne)

- Calendrier recalculé à chaque scan (src/sales.py : règle du théâtre, ou annonce publiée sur sa page).
- La veille à 19:00 (Berlin) : « 🎟 Demain 11h : ouverture des ventes Schaubühne pour janvier. » + mes ⭐
  là-bas (liens 🎟). Heure non publiée (Volksbühne) : « dans la journée ».
- À l'heure d'ouverture : « 🎟 C'est ouvert » + mes ⭐ — seulement si j'en ai là-bas. Heure non publiée
  (Volksbühne) : à 09:00, « 🎟 Ventes Volksbühne pour janvier : ouverture aujourd'hui (heure non publiée) » +
  mes ⭐ — jamais « C'est ouvert », qui ne serait peut-être pas encore vrai.
- Abonné·es au lieu uniquement ; une seule fois par lieu et par ouverture (cron Worker toutes les 15 min).
