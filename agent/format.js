/**
 * Turning sandbox JSON into the words and parts a person reads.
 *
 * Every number the user sees goes through here, so a price is always
 * "$1,815.00", a time is always "6:00pm" and a date is always "October 10".
 */

/* ----------------------------------------------------------------- money -- */

/** 181500 -> "$1,815.00" */
export function usd(cents) {
  if (!Number.isFinite(cents)) return '';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 30000 -> "$300" (trailing ".00" dropped, for rates inside a subtitle) */
export function usdShort(cents) {
  if (!Number.isFinite(cents)) return '';
  const value = cents / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/* ------------------------------------------------------------ time, date -- */

/** "18:00" -> "6:00pm" */
export function prettyTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return String(hhmm ?? '');
  const hour = Number(m[1]);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m[2]}${suffix}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-10-10" -> "October 10" (the year is added only when it is not this one) */
export function prettyDate(iso, today = new Date().toISOString().slice(0, 10)) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return String(iso ?? '');
  const [, year, month, day] = m;
  const name = MONTHS[Number(month) - 1] ?? month;
  const base = `${name} ${Number(day)}`;
  return year === today.slice(0, 4) ? base : `${base}, ${year}`;
}

/* --------------------------------------------------------------- listings -- */

/** "$300/hour", "$115 per guest", "$1,800 flat" */
export function priceLine(listing) {
  const pricing = listing?.pricing;
  if (!pricing) return '';
  if (pricing.model === 'hourly') {
    const min = pricing.minHours ? `, ${pricing.minHours}h minimum` : '';
    return `${usdShort(pricing.rateCents)}/hour${min}`;
  }
  if (pricing.model === 'perGuest') return `${usdShort(pricing.rateCents)} per guest`;
  return `${usdShort(pricing.rateCents)} flat`;
}

export function capacityLine(listing) {
  const capacity = listing?.capacity;
  if (!capacity || !Number.isFinite(capacity.min)) return null;
  return `${capacity.min} to ${capacity.max} guests`;
}

/**
 * A card for one listing. The title must be the listing's exact `name`: the
 * checks match cards to listings by title.
 */
export function cardFor(listing) {
  if (!listing?.name) return null;
  const subtitle = [
    listing.category,
    listing.neighborhood || listing.city,
    capacityLine(listing),
    priceLine(listing),
    listing.instantBook === false ? 'request to book' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    kind: 'card',
    title: listing.name,
    subtitle,
    photoUrls: Array.isArray(listing.photoUrls) ? listing.photoUrls.slice(0, 3) : [],
    ...(listing.mapUrl ? { url: listing.mapUrl } : {}),
  };
}

/**
 * A rough all-in price for ranking listings against each other and against a
 * budget. It mirrors the sandbox formula, but it is an estimate and never a
 * quoted figure: anything said to the user still comes from quote().
 */
export function estimateCents(listing, { hours, guests } = {}) {
  const pricing = listing?.pricing;
  if (!pricing || !Number.isFinite(pricing.rateCents)) return null;
  const headcount = Number.isFinite(guests) ? guests : listing?.capacity?.min ?? 1;
  const span = Math.max(Number.isFinite(hours) ? hours : pricing.minHours ?? 1, pricing.minHours ?? 1);
  const base =
    pricing.model === 'hourly' ? pricing.rateCents * span
    : pricing.model === 'perGuest' ? pricing.rateCents * headcount
    : pricing.rateCents;
  const subtotal = base + (pricing.cleaningFeeCents ?? 0);
  return Math.round(subtotal * 1.1); // the sandbox adds a 10% service fee
}

/** Does this listing seat the group? Listings without a capacity serve any size. */
export function fitsCapacity(listing, guestCount) {
  if (!Number.isFinite(guestCount)) return true;
  const capacity = listing?.capacity;
  if (!capacity || !Number.isFinite(capacity.min)) return true;
  return guestCount >= capacity.min && guestCount <= capacity.max;
}

/* -------------------------------------------------------------- language -- */

/**
 * Enough language detection to answer a greeting in the right language when
 * the model is unreachable. The model itself mirrors the user directly.
 */
export function detectLanguage(text = '') {
  const value = String(text).toLowerCase();
  if (/[一-鿿]/.test(value)) return 'zh';
  if (/[぀-ヿ]/.test(value)) return 'ja';
  if (/[가-힯]/.test(value)) return 'ko';
  if (/[؀-ۿ]/.test(value)) return 'ar';
  if (/[Ѐ-ӿ]/.test(value)) return 'ru';
  if (/\b(hola|necesito|quiero|buenos d[ií]as|buenas|gracias|por favor|cu[aá]ntas|d[oó]nde|reservar|lugar|fiesta|invitados|personas)\b/.test(value)) return 'es';
  if (/\b(bonjour|salut|je voudrais|besoin|merci|s'il vous pla[îi]t|r[ée]server|lieu|invit[ée]s)\b/.test(value)) return 'fr';
  if (/\b(ol[áa]|preciso|quero|obrigad[oa]|por favor|reservar|convidados)\b/.test(value)) return 'pt';
  if (/\b(hallo|guten tag|ich brauche|ich m[öo]chte|danke|bitte|veranstaltungsort|g[äa]ste)\b/.test(value)) return 'de';
  if (/\b(ciao|buongiorno|ho bisogno|vorrei|grazie|per favore|prenotare|ospiti)\b/.test(value)) return 'it';
  return 'en';
}

/** Short phrases for the offline path, in the languages detectLanguage knows. */
const PHRASES = {
  en: {
    greet:
      'Hi, I am the PLEC Concierge. I can find venues and event services in Philadelphia, New York and Washington, and book them for you. Which city is your event in, what date, and roughly how many guests?',
    qualify: 'Which city is it in, what date, and roughly how many guests?',
    unclear: 'I did not quite catch that. What are you looking for: a venue, a service, or help with a booking you already have?',
    trouble: 'I could not reach my system just then. Could you say that once more?',
    scope: 'I can only help with venues, event services and bookings. What can I find for you?',
    askBack: 'Could you send those over?',
    emergency: 'If someone is hurt or in danger, call 911 now, before anything else.',
    intro: "I'm the PLEC Concierge, I find and book venues and event services.",
  },
  es: {
    greet:
      'Hola, soy el Conserje de PLEC. Puedo encontrar espacios y servicios para eventos en Filadelfia, Nueva York y Washington, y reservarlos por ti. ¿En qué ciudad es el evento, en qué fecha y para cuántos invitados?',
    qualify: '¿En qué ciudad es, en qué fecha y para cuántos invitados?',
    unclear: 'No te he entendido del todo. ¿Buscas un espacio, un servicio, o ayuda con una reserva que ya tienes?',
    trouble: 'No pude conectar con mi sistema en este momento. ¿Puedes repetirlo?',
    scope: 'Solo puedo ayudarte con espacios, servicios para eventos y reservas. ¿Qué te busco?',
    askBack: '¿Me los puedes dar?',
    emergency: 'Si hay alguien herido o en peligro, llama al 911 ahora, antes que nada.',
    intro: 'Soy el Conserje de PLEC, encuentro y reservo espacios y servicios para eventos.',
  },
  fr: {
    greet:
      "Bonjour, je suis le Concierge PLEC. Je trouve des lieux et des prestataires d'événement à Philadelphie, New York et Washington, et je les réserve pour vous. Dans quelle ville, à quelle date, et pour combien d'invités ?",
    qualify: "Dans quelle ville, à quelle date, et pour combien d'invités ?",
    unclear: "Je n'ai pas bien compris. Cherchez-vous un lieu, un prestataire, ou de l'aide sur une réservation existante ?",
    trouble: "Je n'ai pas pu joindre mon système. Pouvez-vous répéter ?",
    scope: "Je ne peux aider que pour les lieux, les prestataires et les réservations. Que puis-je chercher ?",
    askBack: 'Pouvez-vous me les envoyer ?',
    emergency: "Si quelqu'un est blessé ou en danger, appelez le 911 immédiatement, avant tout.",
    intro: 'Je suis le Concierge PLEC, je trouve et réserve des lieux et des prestataires.',
  },
  pt: {
    greet:
      'Olá, sou o Concierge da PLEC. Encontro espaços e serviços para eventos em Filadélfia, Nova York e Washington, e faço a reserva. Em que cidade é o evento, em que data e para quantos convidados?',
    qualify: 'Em que cidade é, em que data e para quantos convidados?',
    unclear: 'Não percebi bem. Procura um espaço, um serviço, ou ajuda com uma reserva que já tem?',
    trouble: 'Não consegui contactar o meu sistema agora. Pode repetir?',
    scope: 'Só posso ajudar com espaços, serviços de eventos e reservas. O que procuro para si?',
    askBack: 'Pode enviar-mos?',
    emergency: 'Se alguém está ferido ou em perigo, ligue 911 agora, antes de mais nada.',
    intro: 'Sou o Concierge da PLEC, encontro e reservo espaços e serviços para eventos.',
  },
  de: {
    greet:
      'Hallo, ich bin der PLEC Concierge. Ich finde Veranstaltungsorte und Dienstleister in Philadelphia, New York und Washington und buche sie für Sie. In welcher Stadt, an welchem Datum und für wie viele Gäste?',
    qualify: 'In welcher Stadt, an welchem Datum und für wie viele Gäste?',
    unclear: 'Das habe ich nicht ganz verstanden. Suchen Sie einen Ort, einen Dienstleister oder Hilfe bei einer Buchung?',
    trouble: 'Ich konnte mein System gerade nicht erreichen. Können Sie das wiederholen?',
    scope: 'Ich kann nur bei Veranstaltungsorten, Dienstleistern und Buchungen helfen. Wonach darf ich suchen?',
    askBack: 'Können Sie mir diese schicken?',
    emergency: 'Wenn jemand verletzt oder in Gefahr ist, rufen Sie sofort 911 an, vor allem anderen.',
    intro: 'Ich bin der PLEC Concierge, ich finde und buche Veranstaltungsorte und Dienstleister.',
  },
  it: {
    greet:
      'Ciao, sono il Concierge PLEC. Trovo locali e servizi per eventi a Filadelfia, New York e Washington, e li prenoto per te. In quale città, in che data e per quanti ospiti?',
    qualify: 'In quale città, in che data e per quanti ospiti?',
    unclear: 'Non ho capito bene. Cerchi un locale, un servizio o aiuto con una prenotazione esistente?',
    trouble: 'Non sono riuscito a raggiungere il sistema. Puoi ripetere?',
    scope: 'Posso aiutarti solo con locali, servizi per eventi e prenotazioni. Cosa cerco per te?',
    askBack: 'Me li puoi mandare?',
    emergency: 'Se qualcuno è ferito o in pericolo, chiama subito il 911, prima di tutto.',
    intro: 'Sono il Concierge PLEC, trovo e prenoto locali e servizi per eventi.',
  },
};

export function phrase(language, key) {
  return (PHRASES[language] ?? PHRASES.en)[key] ?? PHRASES.en[key];
}
