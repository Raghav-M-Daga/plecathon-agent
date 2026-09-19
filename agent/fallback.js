/**
 * The agent without a model.
 *
 * The model proxy is shared, capped per five-minute window, and dies when the
 * event ends; providers also just stall sometimes. A turn that throws is a
 * turn with no reply, and every check on it fails. So when the model cannot be
 * reached, this answers from the sandbox alone: it qualifies a vague opener,
 * searches when it has a city, reads a fact off a listing, and refuses to
 * book, cancel or move anything without a person in the loop.
 *
 * It is deliberately narrow. It never writes to the sandbox.
 */

import { plec } from './plec.js';
import { cityInText, todayISO } from './guards.js';
import { capacityLine, detectLanguage, phrase, priceLine, usdShort } from './format.js';

const SERVICE_WORDS = [
  ['dj', /\bdjs?\b|disc jockey|pinchadisc/i],
  ['photographer', /\bphotograph|fot[óo]graf/i],
  ['caterer', /\bcater|comida|banquete|buffet/i],
  ['bartender', /\bbartender|barman|camarer/i],
  ['florist', /\bflor(ist|al|es)|flowers/i],
  ['av', /\bav\b|lighting|sound system|iluminaci/i],
  ['photo booth', /photo ?booth|fotomat/i],
  ['band', /\bband\b|live music|banda|m[úu]sica en vivo/i],
  ['planner', /\bplanner|wedding planner|organizador/i],
  ['videographer', /\bvideograph|v[íi]deo/i],
  ['security', /\bsecurity|seguridad/i],
  ['transportation', /\bshuttle|transport|bus\b/i],
  ['bakery', /\bcake|bakery|pastel|tarta/i],
  ['rentals', /\brentals?|chairs|tables|alquiler/i],
  ['decor', /\bdecor|decoraci/i],
];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const STOPWORDS = new Set([
  'how', 'many', 'people', 'can', 'the', 'and', 'for', 'what', 'does', 'hold', 'have', 'with', 'from',
  'about', 'tell', 'more', 'show', 'give', 'need', 'want', 'like', 'this', 'that', 'there', 'book',
  'venue', 'venues', 'space', 'spaces', 'place', 'places', 'event', 'events', 'party', 'guests', 'guest',
  'please', 'would', 'could', 'much', 'cost', 'price', 'available', 'october', 'november', 'december',
]);

const BOOKING_INTENT = /\b(book|reserve|reservar|r[ée]server|prenotare|buchen|lock (?:it|in)|confirm)\b/i;
const CHANGE_INTENT = /\b(cancel|cancelar|annuler|reschedule|move|change the date|posponer|cambiar)\b/i;
const FACT_INTENT = /\b(hold|holds|capacity|fit|fits|how many|cu[áa]nt|how much|price|cost|open|hours|address|where|amenit|parking)\b/i;

/**
 * @param {{ text: string, session: object, turn: object }} input
 * @returns {Promise<{ text: string, listings?: object[] } | null>}
 */
export async function offlineReply({ text, session, turn }) {
  const state = session.state ?? {};
  const language = turn?.language ?? detectLanguage(text);
  const value = String(text ?? '').trim();

  // Never act on a write intent without a person: ask for what is missing.
  if (CHANGE_INTENT.test(value)) {
    return {
      text:
        language === 'es'
          ? 'Antes de cambiar o cancelar una reserva necesito confirmarlo contigo. ¿Me das la referencia (BK-...) y confirmas que quieres seguir adelante?'
          : 'Before I change or cancel a booking I need you to confirm it. Which reference is it (BK-...), and do you want me to go ahead?',
    };
  }

  const listing = await resolveListing(value, state);

  if (BOOKING_INTENT.test(value)) {
    const where = listing?.name ? ` at ${listing.name}` : '';
    return {
      text:
        language === 'es'
          ? `Puedo prepararlo${listing?.name ? ` en ${listing.name}` : ''}. Para reservar necesito el nombre y el correo de la reserva, y tu confirmación. ¿A qué nombre y correo la pongo?`
          : `I can set that up${where}. To make the booking I need the name and email for the reservation, and your go-ahead. What name and email should I use?`,
      listings: listing ? [listing] : [],
    };
  }

  if (listing && (FACT_INTENT.test(value) || !cityInText(value))) {
    return { text: listingFacts(listing, language), listings: [listing] };
  }

  const city = cityInText(value) || state.city;
  const guests = guestsIn(value) ?? state.guestCount;
  if (city) {
    const service = SERVICE_WORDS.find(([, pattern]) => pattern.test(value));
    const filters = {
      city,
      kind: service ? 'service' : 'venue',
      ...(service ? { category: service[0] } : {}),
      ...(Number.isFinite(guests) ? { guests } : {}),
      limit: 6,
    };
    const date = dateIn(value) ?? state.date;
    if (date) filters.date = date;

    const found = await plec.searchListings(filters).catch(() => null);
    const results = found?.results ?? [];
    if (results.length) {
      const what = service ? service[0] : 'venue';
      const line =
        language === 'es'
          ? `Estas ${results.length} opciones en ${city}${Number.isFinite(guests) ? ` para ${guests} invitados` : ''} encajan. ¿Quieres precio de alguna? Dime la hora de inicio y de fin.`
          : `Here ${results.length === 1 ? 'is one' : `are ${results.length}`} ${what} option${results.length === 1 ? '' : 's'} in ${city}${Number.isFinite(guests) ? ` that fit ${guests} guests` : ''}. Want an exact price for one? Tell me the start and end time.`;
      return { text: line, listings: results };
    }
    return {
      text:
        language === 'es'
          ? `No encontré nada que encaje en ${city}. ¿Probamos otra fecha o un grupo distinto?`
          : `I could not find anything matching in ${city}. Shall I try another date, or a different size of space?`,
    };
  }

  const isGreeting = (session.messages ?? []).filter((m) => m.role === 'user').length <= 1;
  return { text: phrase(language, isGreeting ? 'greet' : 'qualify') };
}

/** One sentence of true facts about a listing, straight off the catalogue. */
function listingFacts(listing, language) {
  const capacity = capacityLine(listing);
  const hours = listing.openHours ? `${listing.openHours.start} to ${listing.openHours.end}` : null;
  if (language === 'es') {
    return [
      `${listing.name} es un espacio de tipo ${listing.category} en ${listing.neighborhood ?? listing.city}`,
      capacity ? ` para ${capacity.replace(' to ', ' a ').replace(' guests', ' invitados')}` : '',
      `. Precio: ${priceLine(listing)}${listing.pricing?.cleaningFeeCents ? ` más ${usdShort(listing.pricing.cleaningFeeCents)} de limpieza` : ''}.`,
      hours ? ` Abre de ${hours}.` : '',
      ' ¿Quieres un precio exacto para una fecha y un horario?',
    ].join('');
  }
  return [
    `${listing.name} is a ${listing.category} in ${listing.neighborhood ?? listing.city}`,
    capacity ? `, and it holds ${capacity}` : '',
    `. It is ${priceLine(listing)}${listing.pricing?.cleaningFeeCents ? ` plus a ${usdShort(listing.pricing.cleaningFeeCents)} cleaning fee` : ''}.`,
    hours ? ` Open ${hours}.` : '',
    ' Want an exact price for a date and time?',
  ].join('');
}

/** Find the listing the user is talking about, by name, without a model. */
async function resolveListing(text, state) {
  const lower = text.toLowerCase();

  for (const listing of Object.values(state.seen ?? {})) {
    if (listing?.name && lower.includes(listing.name.toLowerCase())) return listing;
  }

  const tokens = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word.toLowerCase()))
    .slice(0, 3);
  if (tokens.length === 0) return null;

  const found = await plec.searchListings({ q: tokens.join(' '), limit: 5 }).catch(() => null);
  const results = found?.results ?? [];
  const named = results.find((listing) => {
    const significant = listing.name.toLowerCase().split(/\s+/).filter((word) => word.length > 3 && !STOPWORDS.has(word));
    return significant.length > 0 && significant.every((word) => lower.includes(word));
  });
  if (!named) return null;
  return await plec.getListing(named.id).catch(() => named);
}

function guestsIn(text) {
  const match = String(text).match(/(\d{1,4})\s*(?:\+\s*)?(?:people|guests?|pax|persons?|personas|invitados|personnes)/i);
  return match ? Number(match[1]) : null;
}

/** "October 10", "10 October", "2026-10-10" -> ISO, assuming the next time it comes round. */
function dateIn(text) {
  const value = String(text);
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];

  const names = Object.keys(MONTHS).join('|');
  const match =
    value.match(new RegExp(String.raw`\b(${names})\s+(\d{1,2})\b`, 'i')) ??
    value.match(new RegExp(String.raw`\b(\d{1,2})\s+(?:de\s+)?(${names})\b`, 'i'));
  if (!match) return null;

  const monthName = (MONTHS[match[1].toLowerCase()] ? match[1] : match[2]).toLowerCase();
  const day = Number(MONTHS[match[1].toLowerCase()] ? match[2] : match[1]);
  const month = MONTHS[monthName];
  if (!month || !day || day > 31) return null;

  const today = todayISO();
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return candidate >= today ? candidate : `${year + 1}${candidate.slice(4)}`;
}
