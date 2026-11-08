# Règles d'écriture des cartes (toutes surfaces : push, /programme, groupe, récaps)

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

- Sur chaque fiche privée (pièce, expo, film) : **🎟 Réservé !** → les ~6 prochaines dates connues
  (expos : Aujourd'hui / Demain / Ce week-end) + **📅 Autre date** (réponse « 14/12 20:00 »).
- Réserver = ⭐ intéressé·e. La fiche affiche « 🎟 Réservé · sam. 9 janv. 19:30 » et le bouton
  « Annuler / changer la date ».
- Groupe : « 🎟 X a réservé Y — quand · lieu » + **🙋 J'y vais aussi** (⭐ + lien de réservation en privé).
- /interets et « Nos envies » : les réservations d'abord.
- Le lendemain de la date : « Alors, c'était comment ? » 1–5★ (une seule fois) ; la note marque « vu ».
- Un item réservé n'est jamais reproposé.

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

## Ouvertures de vente (Schaubühne, Berliner Ensemble, Volksbühne)

- Calendrier recalculé à chaque scan (src/sales.py : règle du théâtre, ou annonce publiée sur sa page).
- La veille à 19:00 (Berlin) : « 🎟 Demain 11h : ouverture des ventes Schaubühne pour janvier. » + mes ⭐
  là-bas (liens 🎟). Heure non publiée (Volksbühne) : « dans la journée ».
- À l'heure d'ouverture : « 🎟 C'est ouvert » + mes ⭐ — seulement si j'en ai là-bas. Heure non publiée
  (Volksbühne) : à 09:00, « 🎟 Ventes Volksbühne pour janvier : ouverture aujourd'hui (heure non publiée) » +
  mes ⭐ — jamais « C'est ouvert », qui ne serait peut-être pas encore vrai.
- Abonné·es au lieu uniquement ; une seule fois par lieu et par ouverture (cron Worker toutes les 15 min).
