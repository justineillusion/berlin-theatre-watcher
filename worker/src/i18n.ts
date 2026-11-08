// Textes du bot, par langue (users.lang : 'fr' par défaut, ou 'en').
// Ajouter une langue = ajouter un objet du même type que `fr` et l'entrée dans LANGS.

export type Lang = "fr" | "en";
export const LANGS: Lang[] = ["fr", "en"];

export function asLang(x: unknown): Lang {
  return x === "en" ? "en" : "fr";
}

/** Langue d'un inconnu (pas encore inscrit) : celle de son appli Telegram si ce n'est pas du français. */
export function guessLang(code?: string): Lang {
  return code && !code.toLowerCase().startsWith("fr") ? "en" : "fr";
}

const fr = {
  you: "toi",
  youBold: "<b>toi</b>",
  help: `🎭 <b>Comment ça marche</b>

Je t'envoie les nouvelles pièces (surtitrées en anglais) et expos des lieux que tu suis, et chaque dimanche 🎬 les films de la semaine (VO, bien notés). Sous chaque fiche :
⭐ <b>Intéressé·e</b> : la bande voit que ça te tente
🎟 <b>Réservé !</b> : ta date, annoncée à la bande
✅ <b>Vu</b> : une note ★ et un petit mot
🙅 <b>Pas pour moi</b> : plus jamais proposé

/programme — ce qui est à l'affiche
/sorties — réservé, envies ⭐, vu
/reglages — lieux, langue, pas pour moi, groupe`,
  ownerHelp: `\n\n👑 <b>Admin</b>
/invite — lien d'invitation à partager
/nouveaulien — invalider l'ancien lien
/membres — qui est inscrit
/groupe — (à taper DANS un groupe Telegram) y annoncer les ⭐ et les avis, dans ta langue
/plusdegroupe — arrêter les annonces dans le groupe`,
  groupOn: "👋 C'est noté : j'annoncerai ici les ⭐ de la bande et les avis après spectacle.",
  unsubscribed: "Tu t'étais désinscrit·e. Tape /start pour revenir 🙂",
  privateBot: "🔒 Ce bot est réservé à une bande d'amis. Demande le lien d'invitation à la personne qui t'en a parlé.",
  followPrompt: "Que veux-tu suivre ? Touche pour cocher / décocher :",
  nowShowing: "📅 <b>À l'affiche</b>",
  stopped: "🔕 C'est fait, tu ne recevras plus rien. /start pour revenir.",
  notUnderstood: "Je n'ai pas compris 🙂 /aide pour la liste des commandes.",
  newLinkDone: "🔁 Ancien lien désactivé.\n\n",
  groupOff: "OK, plus d'annonces dans le groupe.",
  welcomeBack: (name: string) => `Re-bonjour ${name} 👋\n\n`,
  badInvite: "🔒 Ce lien d'invitation n'est pas (ou plus) valable. Demande-en un nouveau.",
  welcome: (name: string) => `Bienvenue ${name} 🎉\n\n`,
  noSpam: "Pour ne pas t'inonder, je ne t'envoie pas le programme actuel en notifs : seulement les nouveautés à partir de demain. Tape /programme pour voir ce qui est déjà à l'affiche.",
  defaultAll: "Par défaut tu suis tout. Décoche ce qui ne t'intéresse pas :",
  joined: (who: string) => `🎉 ${who} a rejoint le bot.`,
  invite: (link: string) => `🔗 Lien d'invitation à partager avec tes amis :\n${link}\n\nIls ouvrent le lien, appuient sur « Démarrer », et c'est tout. /nouveaulien pour l'invalider.`,
  members: (n: number) => `👥 <b>${n} membre(s)</b>\n`,
  memberLine: (subs: number, stars: number) => `${subs} lieu(x), ${stars} ⭐`,
  groupStatus: (on: boolean) => `\n\nGroupe d'annonces : ${on ? "activé" : "aucun (/groupe dans un groupe)"}`,
  noVenues: "Aucun lieu encore — réessaie après le prochain scan",
  all: "Tout ✅",
  none: "Rien ⬜️",
  done: "Terminé 👍",
  saved: "👍 C'est enregistré. /suivre pour changer plus tard.",
  noInterests: "Personne n'a encore mis ⭐ sur une pièce ou une expo à l'affiche.",
  interestsTitle: "⭐ <b>Ce qui tente la bande</b>",
  noneSeen: "Rien de marqué ✅ Vu pour l'instant.",
  seenTitle: "✅ <b>Tes sorties</b>",
  noneIgnored: "Rien en « Pas pour moi » pour l'instant.",
  ignoredTitle: "🙅 <b>Pas pour moi</b> — touche pour le reproposer :",
  openFirst: (bot: string) => `Ouvre d'abord le bot en privé (@${bot}) avec le lien d'invitation 🙂`,
  gone: "Cette pièce n'est plus au programme.",
  toastStar: "⭐ Noté, la bande est au courant",
  toastUnstar: "Retiré de tes ⭐",
  toastSeen: "✅ Plus de notif sur celle-ci. Une note ?",
  toastRated: (s: string) => `${s} — merci !`,
  askComment: (s: string, title: string) => `${s} pour <b>${title}</b>.\n\nUn petit mot pour la bande ? Réponds à ce message (ou /passer).`,
  toastIgnored: "🙅 Pas pour moi : plus jamais proposé",
  toastUndo: "↩️ C'est annulé",
  thanksComment: "💬 Merci, c'est partagé avec la bande !",
  commentSaved: (title: string) => `💬 Avis enregistré pour <b>${title}</b> — partagé avec la bande !`,
  reviewPlaceholder: (title: string) => `Ton avis sur ${title}…`,
  askReview: (title: string) => `✍️ Ton avis sur <b>${title}</b> ? Réponds à ce message (ou /passer).`,
  btnReview: "✍️ Écrire / modifier mon avis",
  annStar: (who: string, what: string) => `⭐ <b>${who}</b> est intéressé·e par ${what}`,
  annSeen: (who: string, what: string, s: string) => `✅ <b>${who}</b> a vu ${what} : ${s}`,
  annComment: (who: string, what: string) => `💬 <b>${who}</b> sur ${what}`,
  meToo: "🙋 Moi aussi",
  interestedList: "Intéressé·es :",
  // lib.ts
  band: "👥 <b>La bande</b>",
  interested: (names: string) => `⭐ Intéressé·es : ${names}`,
  avg: (s: string, avg: string, n: number) => `✅ Note moyenne : ${s} ${avg}/5 (${n} avis)`,
  avgCompact: (s: string, n: number) => `✅ ${s} (${n} avis)`,
  seenBy: (names: string) => `✅ vu par ${names}`,
  btnUnignore: "↩️ Finalement si",
  btnNotSeen: "↩️ Pas vu finalement",
  btnInterested: "⭐ Intéressé·e",
  btnInterestedOn: "⭐ Intéressé·e ✓",
  btnSeen: (expo: boolean): string => (expo ? "✅ Vue" : "✅ Vu"),
  btnIgnore: "🙅 Pas pour moi",
  stIgnored: (_expo: boolean) => `\n🙅 <i>Pas pour moi</i>`,
  stRated: (s: string, c: string) => `\n✅ <i>Vu · ${s}${c ? ` · « ${c} »` : ""}</i>`,
  stSeen: (expo: boolean) => `\n✅ <i>${expo ? "Vue" : "Vu"}</i>`,
  // scan.ts
  newDates: (d: string) => `🆕 <b>Nouvelles dates</b> : ${d}`,
  newSessions: (d: string) => `🆕 <b>Nouvelles séances</b> : ${d}`,
  lastWeeks: (d: string) => `⏳ <b>Dernières semaines !</b> Fin le ${d} — tu avais mis ⭐`,
  sundayDigest: "📅 <b>Récap du dimanche</b>",
  digestEmpty: "Rien de neuf dans tes lieux suivis (ou tout est déjà vu / ignoré). /suivre pour en ajouter.",
  plays: (n: number) => `${n} pièce${n > 1 ? "s" : ""}`,
  expos: (n: number) => `${n} expo${n > 1 ? "s" : ""}`,
  theatreSection: "\n🎭 <b>THÉÂTRE</b>",
  expoSection: "\n🖼 <b>EXPOS</b>",
  filmSection: "\n🎬 <b>CINÉ</b>",
  films: (n: number) => `${n} film${n > 1 ? "s" : ""}`,
  legend: "<i>⭐ = tes mots-clés · 👥 = la bande</i>",
  // langue
  langPrompt: "🌍 Langue des messages · Message language :",
  langSet: "🇫🇷 C'est noté : je te parle en français.",
  // groupe
  groupHelp: `🎭 <b>Le bot de la bande, dans le groupe</b>
/interets — ce qui tente la bande (qui, quelles dates, où réserver)
/programme — ce qui est à l'affiche dans nos lieux, avec des boutons ⭐ « Ça me tente »
/aide — cette aide

Ici, ⭐ « Moi aussi » sous une annonce = tu es partant·e. Les notifs perso, les « vu » et les notes se gèrent en privé avec le bot.`,
  groupInterestsTitle: "⭐ <b>Ce qui tente la bande</b>",
  groupNoInterests: "Personne n'a encore mis ⭐ sur une pièce ou une expo à l'affiche. /programme pour choisir !",
  groupProgrammeTitle: "📅 <b>À l'affiche dans nos lieux</b>",
  groupProgrammeHint: "<i>Touche ⭐ pour dire que ça te tente — la bande le verra.</i>",
  groupNothingOn: "Rien à l'affiche pour l'instant dans les lieux suivis.",
  weeklyGroupTitle: "📅 <b>Le plan de la semaine</b>",
  pickButton: (title: string) => `⭐ ${title}`,
  plan: (names: string, what: string) => `🎟 <b>Plan !</b> ${names} veulent voir ${what}`,
  nextDates: (d: string) => `Prochaines dates : ${d}`,
  until: (d: string) => `jusqu'au ${d}`,
  closingSoon: "ferme bientôt",
  and: "et",
  joinHint: "Rejoins d'abord le bot en privé : il s'ouvre, appuie sur Démarrer 🙂",
  days: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  months: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
  btnBook: "🎟 Réservé !",
  btnBookChange: "🎟 Annuler / changer la date",
  btnAlreadySeen: "✅ Déjà vu", btnRemove: "✖ Retirer", btnBack: "↩︎ Retour",
  btnReserve: "🎟 Réserver", btnChangeDate: "📅 Changer la date", btnRate: "★ Noter", btnCritique: "✍️ Critique",
  batchNew: (n: number) => `🆕 <b>Nouveau dans tes lieux</b> (${n})`,
  batchNewDates: (n: number) => `🗓 <b>Nouvelles dates</b> (${n})`,
  batchLastWeeks: (n: number) => `⏳ <b>Dernières semaines</b> (${n})`,
  batchMore: (n: number) => `+${n} autres : /programme`,
  urgentStars: "🎟 <b>Nouvelles dates pour tes ⭐</b>",
  sunBooked: "🎟 <b>Tes 🎟 cette semaine</b>",
  btnList: "↩︎ Liste", filterAll: "Tout", listEmpty: "Rien ici pour l'instant.",
  progHead: (n: number) => `📅 <b>À l'affiche</b> (${n})`,
  noFollowedAny: "📅 Rien à l'affiche dans tes lieux pour l'instant. /reglages → 📍 Lieux pour en suivre d'autres.",
  sunExpos: "🖼 <b>Expos qui ouvrent cette semaine</b>",
  urgentSale: "🗓 <b>Aussi de nouvelles dates</b> (vente ouverte)",
  btnUnstar: "↩︎ annuler ⭐", btnUndo: "↩︎ Annuler", btnEdit: "✏️ Modifier", btnRewrite: "✍️ Réécrire la critique",
  bookWhich: "Pour quelle date ?",
  toastBooked: (when: string) => `🎟 Réservé · ${when}`,
  outingsTitle: "🗂 <b>Mes sorties</b>",
  settingsTitle: "⚙️ <b>Réglages</b>",
  monthsFull: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  saleHour: (hm: string) => `${Number(hm.slice(0, 2))}h${hm.slice(3) === "00" ? "" : hm.slice(3)}`,
  saleSomeTime: "dans la journée",
  saleTomorrow: (when: string, venue: string, month: string) => `🎟 Demain ${when} : ouverture des ventes ${venue} pour ${month}.`,
  saleYourStars: "Tes ⭐ là-bas :",
  saleOpen: (venue: string, month: string) => `🎟 C'est ouvert : ventes ${venue} pour ${month}.`,
  saleToday: (venue: string, month: string) => `🎟 Ventes ${venue} pour ${month} : ouverture aujourd'hui (heure non publiée)`,
  toastNotForMe: "🙅 Retiré de tes sorties",
  setVenues: "📍 Lieux", setLang: "🌐 Langue", setIgnored: "🙅 Pas pour moi", setGroup: "👥 Groupe",
  groupInfo: (on: boolean): string => on ? "👥 Le groupe de la bande est relié : les ⭐, 🎟 et avis y sont annoncés."
    : "👥 Pas de groupe relié pour l'instant.",
  outBooked: "🎟 <b>Réservé</b>",
  outInterested: "⭐ <b>Intéressé·e</b>",
  outSeen: "✅ <b>Vu</b>",
  outEmpty: "🗂 <b>Mes sorties</b>\n\nRien pour l'instant : mets ⭐ sur une fiche de /programme.",
  bookPick: (title: string) => `🎟 <b>${title}</b> : pour quelle date ?`,
  bookOther: "📅 Autre date",
  bookCancel: "❌ Annuler la réservation",
  bookToday: "Aujourd'hui", bookTomorrow: "Demain", bookWeekend: "Ce week-end",
  bookAskDate: (title: string) => `📅 <b>${title}</b> : quelle date ? Réponds à ce message, ex. <code>14/12 20:00</code>.`,
  bookDatePlaceholder: "ex. 14/12 20:00",
  bookBadDate: "🤔 Je n'ai pas compris la date. Exemple : 14/12 20:00 (ou 14/12).",
  booked: (title: string, when: string) => `🎟 <b>${title}</b> : réservé pour le ${when}. Bonne soirée !`,
  bookCancelled: "Réservation annulée.",
  stBooked: (when: string) => `\n🎟 <i>Réservé · ${when}</i>`,
  groupBooked: (who: string, title: string, when: string, venue: string) =>
    `🎟 <b>${who}</b> a réservé <b>${title}</b> — ${when}${venue ? ` · ${venue}` : ""}`,
  imIn: "🙋 J'y vais aussi",
  openApp: "📖 Ouvrir dans Berlin Encore!",
  imInLink: "🔗 Réserver",
  joinDm: (title: string, when: string, url: string) =>
    `🎟 Pour rejoindre la bande à <b>${title}</b> le ${when}${url ? ` : <a href="${url}">réserver ici</a>` : ""}.`,
  toastJoin: "🙋 Noté ! Je t'envoie le lien en privé.",
  bookingsHead: "🎟 <b>Réservations</b>",
  howWasIt: (title: string) => `🎭 Alors, c'était comment, <b>${title}</b> ? Une note pour la bande :`,
  book: "réserver",
  annSaw: (who: string) => `✅ <b>${who}</b> a vu`,
  starHead: (who: string) => `⭐ <b>${who}</b> est intéressé·e`,
  planHead: (names: string) => `🎟 <b>Plan !</b> ${names} veulent y aller`,
  sawToo: "✅ Je l'ai vu aussi",
  checkPrivate: "Regarde ton chat privé avec le bot ✉️",
  rateIt: (what: string) => `✅ ${what}\n\nTa note pour la bande ?`,
  browsePrompt: "📅 <b>À l'affiche</b> — choisis une catégorie ou un lieu :",
  catTheatre: "🎭 Théâtre",
  catExpo: "🖼 Expos",
  catFilm: "🎬 Films de la semaine",
  catStar: "⭐ Nos envies",
  more: "Il y en a d'autres :",
  moreButton: "Plus ▸",
  browseEmpty: "Rien à l'affiche dans ce lieu pour l'instant.",
  noFollowed: "Tu ne suis aucun lieu de ce type. /suivre pour en ajouter.",
};

const en: typeof fr = {
  you: "you",
  youBold: "<b>you</b>",
  help: `🎭 <b>How it works</b>

I send you new plays (with English surtitles) and exhibitions from the venues you follow, and every Sunday 🎬 the week's films (original version, well rated). Under each card:
⭐ <b>Interested</b>: the gang sees you're keen
🎟 <b>Booked!</b>: your date, announced to the gang
✅ <b>Seen</b>: a ★ rating and a short note
🙅 <b>Not for me</b>: never suggested again

/programme — what's on
/sorties — booked, ⭐ wishlist, seen
/reglages — venues, language, not for me, group`,
  ownerHelp: `\n\n👑 <b>Admin</b>
/invite — invitation link to share
/nouveaulien — revoke the old link
/membres — who's signed up
/groupe — (type it IN a Telegram group) announce ⭐ and reviews there, in your language
/plusdegroupe — stop group announcements`,
  groupOn: "👋 Got it: I'll announce the gang's ⭐ and post-show reviews here.",
  unsubscribed: "You had unsubscribed. Type /start to come back 🙂",
  privateBot: "🔒 This bot is for a group of friends. Ask whoever told you about it for the invitation link.",
  followPrompt: "What do you want to follow? Tap to tick / untick:",
  nowShowing: "📅 <b>Now on</b>",
  stopped: "🔕 Done, you won't receive anything any more. /start to come back.",
  notUnderstood: "I didn't get that 🙂 /aide for the list of commands.",
  newLinkDone: "🔁 Old link revoked.\n\n",
  groupOff: "OK, no more group announcements.",
  welcomeBack: (name: string) => `Welcome back ${name} 👋\n\n`,
  badInvite: "🔒 This invitation link isn't valid (any more). Ask for a new one.",
  welcome: (name: string) => `Welcome ${name} 🎉\n\n`,
  noSpam: "So as not to flood you, I won't send the current programme as alerts: only what's new from tomorrow. Type /programme to see what's already on.",
  defaultAll: "By default you follow everything. Untick what you're not interested in:",
  joined: (who: string) => `🎉 ${who} joined the bot.`,
  invite: (link: string) => `🔗 Invitation link to share with your friends:\n${link}\n\nThey open the link, tap “Start”, and that's it. /nouveaulien to revoke it.`,
  members: (n: number) => `👥 <b>${n} member(s)</b>\n`,
  memberLine: (subs: number, stars: number) => `${subs} venue(s), ${stars} ⭐`,
  groupStatus: (on: boolean) => `\n\nAnnouncement group: ${on ? "on" : "none (/groupe in a group)"}`,
  noVenues: "No venues yet — try again after the next scan",
  all: "All ✅",
  none: "None ⬜️",
  done: "Done 👍",
  saved: "👍 Saved. /suivre to change it later.",
  noInterests: "Nobody has ⭐-ed a current play or exhibition yet.",
  interestsTitle: "⭐ <b>What the gang fancies</b>",
  noneSeen: "Nothing marked ✅ Seen yet.",
  seenTitle: "✅ <b>Your outings</b>",
  noneIgnored: "Nothing in “Not for me” right now.",
  ignoredTitle: "🙅 <b>Not for me</b> — tap to see it again:",
  openFirst: (bot: string) => `First open the bot privately (@${bot}) with the invitation link 🙂`,
  gone: "This play is no longer on.",
  toastStar: "⭐ Noted, the gang knows",
  toastUnstar: "Removed from your ⭐",
  toastSeen: "✅ No more alerts for this one. A rating?",
  toastRated: (s: string) => `${s} — thanks!`,
  askComment: (s: string, title: string) => `${s} for <b>${title}</b>.\n\nA short note for the gang? Reply to this message (or /skip).`,
  toastIgnored: "🙅 Not for me: never suggested again",
  toastUndo: "↩️ Undone",
  thanksComment: "💬 Thanks, shared with the gang!",
  commentSaved: (title: string) => `💬 Review saved for <b>${title}</b> — shared with the gang!`,
  reviewPlaceholder: (title: string) => `Your thoughts on ${title}…`,
  askReview: (title: string) => `✍️ Your thoughts on <b>${title}</b>? Reply to this message (or /skip).`,
  btnReview: "✍️ Write / edit my review",
  annStar: (who: string, what: string) => `⭐ <b>${who}</b> is interested in ${what}`,
  annSeen: (who: string, what: string, s: string) => `✅ <b>${who}</b> saw ${what}: ${s}`,
  annComment: (who: string, what: string) => `💬 <b>${who}</b> on ${what}`,
  meToo: "🙋 Me too",
  interestedList: "Interested:",
  band: "👥 <b>The gang</b>",
  interested: (names: string) => `⭐ Interested: ${names}`,
  avg: (s: string, avg: string, n: number) => `✅ Average rating: ${s} ${avg}/5 (${n} review${n > 1 ? "s" : ""})`,
  avgCompact: (s: string, n: number) => `✅ ${s} (${n} review${n > 1 ? "s" : ""})`,
  seenBy: (names: string) => `✅ seen by ${names}`,
  btnUnignore: "↩️ Actually, yes",
  btnNotSeen: "↩️ Not seen after all",
  btnInterested: "⭐ Interested",
  btnInterestedOn: "⭐ Interested ✓",
  btnSeen: () => "✅ Seen",
  btnIgnore: "🙅 Not for me",
  stIgnored: (_expo: boolean) => `\n🙅 <i>Not for me</i>`,
  stRated: (s: string, c: string) => `\n✅ <i>Seen · ${s}${c ? ` · “${c}”` : ""}</i>`,
  stSeen: () => `\n✅ <i>Seen</i>`,
  newDates: (d: string) => `🆕 <b>New dates</b>: ${d}`,
  newSessions: (d: string) => `🆕 <b>New screenings</b>: ${d}`,
  lastWeeks: (d: string) => `⏳ <b>Last weeks!</b> Ends ${d} — you ⭐-ed it`,
  sundayDigest: "📅 <b>Sunday round-up</b>",
  digestEmpty: "Nothing new in the venues you follow (or it's all seen / ignored). /suivre to add some.",
  plays: (n: number) => `${n} play${n > 1 ? "s" : ""}`,
  expos: (n: number) => `${n} exhibition${n > 1 ? "s" : ""}`,
  theatreSection: "\n🎭 <b>THEATRE</b>",
  expoSection: "\n🖼 <b>EXHIBITIONS</b>",
  filmSection: "\n🎬 <b>FILMS</b>",
  films: (n: number) => `${n} film${n > 1 ? "s" : ""}`,
  legend: "<i>⭐ = your keywords · 👥 = the gang</i>",
  langPrompt: "🌍 Langue des messages · Message language :",
  langSet: "🇬🇧 Done: I'll talk to you in English.",
  groupHelp: `🎭 <b>The gang's bot, in the group</b>
/interets — what the gang wants to see (who, which dates, where to book)
/programme — what's on in our venues, with ⭐ “I'm interested” buttons
/aide — this help

Here, ⭐ “Me too” under an announcement = you're in. Personal alerts, “seen” and ratings are handled privately with the bot.`,
  groupInterestsTitle: "⭐ <b>What the gang wants to see</b>",
  groupNoInterests: "Nobody has ⭐-ed a current play or exhibition yet. /programme to pick one!",
  groupProgrammeTitle: "📅 <b>On now in our venues</b>",
  groupProgrammeHint: "<i>Tap ⭐ if you're interested — the gang will see it.</i>",
  groupNothingOn: "Nothing on right now in the venues we follow.",
  weeklyGroupTitle: "📅 <b>This week's gang plan</b>",
  pickButton: (title: string) => `⭐ ${title}`,
  plan: (names: string, what: string) => `🎟 <b>Plan!</b> ${names} both want to see ${what}`,
  nextDates: (d: string) => `Next dates: ${d}`,
  until: (d: string) => `until ${d}`,
  closingSoon: "closing soon",
  and: "&",
  joinHint: "Join the bot privately first: it opens, tap Start 🙂",
  days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  btnBook: "🎟 Booked!",
  btnBookChange: "🎟 Cancel / change date",
  btnAlreadySeen: "✅ Already seen", btnRemove: "✖ Remove", btnBack: "↩︎ Back",
  btnReserve: "🎟 Book", btnChangeDate: "📅 Change date", btnRate: "★ Rate", btnCritique: "✍️ Review",
  batchNew: (n: number) => `🆕 <b>New at your venues</b> (${n})`,
  batchNewDates: (n: number) => `🗓 <b>New dates</b> (${n})`,
  batchLastWeeks: (n: number) => `⏳ <b>Last weeks</b> (${n})`,
  batchMore: (n: number) => `+${n} more: /programme`,
  urgentStars: "🎟 <b>New dates for your ⭐</b>",
  sunBooked: "🎟 <b>Your 🎟 this week</b>",
  btnList: "↩︎ List", filterAll: "All", listEmpty: "Nothing here yet.",
  progHead: (n: number) => `📅 <b>What's on</b> (${n})`,
  noFollowedAny: "📅 Nothing on at your venues right now. /reglages → 📍 Venues to follow more.",
  sunExpos: "🖼 <b>Exhibitions opening this week</b>",
  urgentSale: "🗓 <b>Also new dates</b> (sales open)",
  btnUnstar: "↩︎ undo ⭐", btnUndo: "↩︎ Undo", btnEdit: "✏️ Edit", btnRewrite: "✍️ Rewrite review",
  bookWhich: "Which date?",
  toastBooked: (when: string) => `🎟 Booked · ${when}`,
  outingsTitle: "🗂 <b>My outings</b>",
  settingsTitle: "⚙️ <b>Settings</b>",
  monthsFull: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  saleHour: (hm: string) => hm,
  saleSomeTime: "(time not announced)",
  saleTomorrow: (when: string, venue: string, month: string) => `🎟 Tomorrow ${when}: ${venue} opens sales for ${month}.`,
  saleYourStars: "Your ⭐ there:",
  saleOpen: (venue: string, month: string) => `🎟 It's open: ${venue} sales for ${month}.`,
  saleToday: (venue: string, month: string) => `🎟 ${venue} sales for ${month}: opening today (time not published)`,
  toastNotForMe: "🙅 Removed from your outings",
  setVenues: "📍 Venues", setLang: "🌐 Language", setIgnored: "🙅 Not for me", setGroup: "👥 Group",
  groupInfo: (on: boolean) => on ? "👥 The gang's group is linked: ⭐, 🎟 and reviews are announced there."
    : "👥 No group linked yet.",
  outBooked: "🎟 <b>Booked</b>",
  outInterested: "⭐ <b>Interested</b>",
  outSeen: "✅ <b>Seen</b>",
  outEmpty: "🗂 <b>My outings</b>\n\nNothing yet: tap ⭐ on a card from /programme.",
  bookPick: (title: string) => `🎟 <b>${title}</b>: which date?`,
  bookOther: "📅 Other date",
  bookCancel: "❌ Cancel booking",
  bookToday: "Today", bookTomorrow: "Tomorrow", bookWeekend: "This weekend",
  bookAskDate: (title: string) => `📅 <b>${title}</b>: which date? Reply to this message, e.g. <code>14/12 20:00</code>.`,
  bookDatePlaceholder: "e.g. 14/12 20:00",
  bookBadDate: "🤔 I didn't get the date. Example: 14/12 20:00 (or 14/12).",
  booked: (title: string, when: string) => `🎟 <b>${title}</b>: booked for ${when}. Enjoy!`,
  bookCancelled: "Booking cancelled.",
  stBooked: (when: string) => `\n🎟 <i>Booked · ${when}</i>`,
  groupBooked: (who: string, title: string, when: string, venue: string) =>
    `🎟 <b>${who}</b> has booked <b>${title}</b> — ${when}${venue ? ` · ${venue}` : ""}`,
  imIn: "🙋 I'm in too",
  openApp: "📖 Open in Berlin Encore!",
  imInLink: "🔗 Book",
  joinDm: (title: string, when: string, url: string) =>
    `🎟 To join the gang at <b>${title}</b> on ${when}${url ? `: <a href="${url}">book here</a>` : ""}.`,
  toastJoin: "🙋 Noted! I'm sending you the link privately.",
  bookingsHead: "🎟 <b>Bookings</b>",
  howWasIt: (title: string) => `🎭 So, how was <b>${title}</b>? A rating for the gang:`,
  book: "book",
  annSaw: (who: string) => `✅ <b>${who}</b> saw`,
  starHead: (who: string) => `⭐ <b>${who}</b> is interested`,
  planHead: (names: string) => `🎟 <b>Plan!</b> ${names} both want to go`,
  sawToo: "✅ I saw it too",
  checkPrivate: "Check your private chat with the bot ✉️",
  rateIt: (what: string) => `✅ ${what}\n\nHow would you rate it for the gang?`,
  browsePrompt: "📅 <b>What's on</b> — pick a category or a venue:",
  catTheatre: "🎭 Theatre",
  catExpo: "🖼 Exhibitions",
  catFilm: "🎬 Films this week",
  catStar: "⭐ Our picks",
  more: "There's more:",
  moreButton: "More ▸",
  browseEmpty: "Nothing on at this venue right now.",
  noFollowed: "You don't follow any venue of this kind. /suivre to add some.",
};

const DICT: Record<Lang, typeof fr> = { fr, en };

export function tr(lang: unknown): typeof fr {
  return DICT[asLang(lang)];
}

export const langKeyboard = (onboarding = false) => ({
  inline_keyboard: [[
    { text: "🇫🇷 Français", callback_data: `l:fr${onboarding ? ":1" : ""}` },
    { text: "🇬🇧 English", callback_data: `l:en${onboarding ? ":1" : ""}` },
  ]],
});

// ---------------------------------------------------------------------------
// Menus de commandes (« / »). Telegram choisit selon la langue de l'APPLI ; on
// pose en plus un menu PAR CHAT dans la langue choisie (setChatMenu).
// ---------------------------------------------------------------------------
export const COMMANDS = [
  { command: "programme", description: "À l'affiche" },
  { command: "sorties", description: "Mes sorties" },
  { command: "reglages", description: "Réglages" },
];
export const COMMANDS_EN = [
  { command: "programme", description: "What's on" },
  { command: "sorties", description: "My outings" },
  { command: "reglages", description: "Settings" },
];

/** Version du menu : à chaque changement de COMMANDS, on l'incrémente et le menu
 *  de chaque personne est reposé à sa prochaine interaction (bot.ts). */
export const MENU_VERSION = "3cmd-short";

/** Menus par défaut (privé fr / en) et du groupe — posés par /api/setup, et
 *  automatiquement au 1er update après un changement de MENU_VERSION. */
export async function setGlobalMenus(env: { BOT_TOKEN: string; TG_API?: string }): Promise<unknown> {
  const base = env.TG_API || "https://api.telegram.org";
  const call = (body: unknown) => fetch(`${base}/bot${env.BOT_TOKEN}/setMyCommands`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => undefined);
  const priv = { type: "all_private_chats" };
  const res = await call({ commands: COMMANDS });
  await call({ commands: COMMANDS, scope: priv });
  await call({ commands: COMMANDS_EN, scope: priv, language_code: "en" });
  await call({ commands: COMMANDS_EN, language_code: "en" });
  await call({
    commands: [
      { command: "interets", description: "Envies de la bande ⭐" },
      { command: "programme", description: "À l'affiche" },
    ],
    scope: { type: "all_group_chats" },
  });
  return res;
}

/** Menu « / » de CE chat dans la langue choisie (inscription, /langue, /api/setup). */
export async function setChatMenu(env: { BOT_TOKEN: string; TG_API?: string }, chat: number, lang: string | null | undefined) {
  const base = env.TG_API || "https://api.telegram.org";
  await fetch(`${base}/bot${env.BOT_TOKEN}/setMyCommands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: asLang(lang) === "en" ? COMMANDS_EN : COMMANDS, scope: { type: "chat", chat_id: chat } }),
  }).catch(() => undefined);
}
