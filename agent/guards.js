/**
 * Deterministic guard rails.
 *
 * The system prompt tells the model how to behave. This file makes the
 * dangerous parts true whatever the model decides, because a prompt can be
 * argued with and code cannot. Everything here is pure and testable:
 *
 *   sanitizeArgs()  repairs tool arguments a model gets wrong (city aliases,
 *                   "6pm", a stale year, a forgotten headcount)
 *   gate()          refuses book / cancel / reschedule until the user has
 *                   actually said yes and the identity came from the user
 *   scrubText()     strips markdown, planted instructions and invented
 *                   discount codes out of the answer
 *   truthGuard()    rewrites "your booking is confirmed" when the sandbox says
 *                   it is pending_payment or requested
 */

/* ---------------------------------------------------------------- dates -- */

/** The sandbox's "today" is the current UTC date; match it exactly. */
export const todayISO = () => new Date().toISOString().slice(0, 10);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* --------------------------------------------------------------- cities -- */

const CITY_ALIASES = [
  [/^(philadelphia|philly|phila|phl|filadelfia|philadelphia,? pa)$/i, 'Philadelphia'],
  [/^(new york|new york city|nyc|ny|manhattan|brooklyn|queens|the bronx|bronx|nueva york)$/i, 'New York'],
  [/^(washington|washington dc|washington,? d\.?c\.?|dc|d\.?c\.?|district of columbia)$/i, 'Washington'],
];

/** The only three cities in the catalogue. */
export const CITIES = ['Philadelphia', 'New York', 'Washington'];

/** "Philly" matches nothing in the sandbox; "Philadelphia" matches everything. */
export function normalizeCity(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  for (const [pattern, city] of CITY_ALIASES) if (pattern.test(trimmed)) return city;
  return trimmed;
}

/** Finds a catalogue city named anywhere in free text. */
export function cityInText(text = '') {
  const lower = ` ${String(text).toLowerCase()} `;
  if (/philadelphia|philly|filadelfia|\bphila\b/.test(lower)) return 'Philadelphia';
  if (/new york|nyc|manhattan|brooklyn|nueva york/.test(lower)) return 'New York';
  if (/washington|\bd\.?c\.?\b/.test(lower)) return 'Washington';
  return null;
}

/* ---------------------------------------------------------------- times -- */

/** "6pm", "6:30 PM", "1800", "18:00" all become "18:00". Unparseable input is returned as is. */
export function normalizeTime(value) {
  if (typeof value !== 'string') return value;
  const raw = value.trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  let m = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3] === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}`;
  }
  m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  m = raw.match(/^(\d{3,4})$/);
  if (m) {
    const digits = m[1].padStart(4, '0');
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  }
  return value;
}

/* ------------------------------------------------------- argument repair -- */

const asInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : value;
};

/**
 * Repair one tool call's arguments before they reach the sandbox.
 * @param {string} name tool name
 * @param {object} args arguments the model produced
 * @param {{ state: object }} session
 * @param {string} userCorpus everything the user has typed this conversation
 */
export function sanitizeArgs(name, args, session, userCorpus = '') {
  const out = { ...(args ?? {}) };
  const state = session?.state ?? {};

  if (typeof out.city === 'string') out.city = normalizeCity(out.city);
  if (typeof out.startTime === 'string') out.startTime = normalizeTime(out.startTime);
  if (typeof out.endTime === 'string') out.endTime = normalizeTime(out.endTime);
  if (out.guestCount !== undefined) out.guestCount = asInt(out.guestCount);
  if (out.guests !== undefined) out.guests = asInt(out.guests);
  if (typeof out.ref === 'string') out.ref = out.ref.trim().toUpperCase();
  if (typeof out.guestEmail === 'string') out.guestEmail = out.guestEmail.trim();
  if (typeof out.guestName === 'string') out.guestName = out.guestName.trim();
  if (Array.isArray(out.packageIds)) out.packageIds = out.packageIds.filter((id) => typeof id === 'string' && id);

  // A model with no calendar often defaults to the year it was trained in.
  // Only repair a past year the user never typed themselves.
  if (typeof out.date === 'string' && ISO_DATE.test(out.date)) {
    const today = todayISO();
    const year = Number(out.date.slice(0, 4));
    const thisYear = Number(today.slice(0, 4));
    if (year < thisYear && !userCorpus.includes(String(year))) {
      const bumped = `${thisYear}${out.date.slice(4)}`;
      out.date = bumped >= today ? bumped : `${thisYear + 1}${out.date.slice(4)}`;
    }
  }

  if (name === 'search_listings') {
    // The sandbox only returns listings whose capacity range contains `guests`,
    // which is what keeps a 300-seat ballroom out of a party of 40.
    if (out.guests === undefined && Number.isFinite(state.guestCount)) out.guests = state.guestCount;
    if (out.city === undefined && state.city) out.city = state.city;
    if (out.limit === undefined) out.limit = 10;
    if (typeof out.q === 'string' && out.q.trim().split(/\s+/).length > 3) {
      out.q = out.q.trim().split(/\s+/).slice(0, 3).join(' ');
    }
  }

  return out;
}

/* ------------------------------------------------------------- the "yes" -- */

/**
 * An explicit go-ahead, in the languages a walk-up user is likely to use.
 * Deliberately narrow: "Book the Foundry for 40 people" is an instruction to
 * price something, not a confirmation, and must not match.
 */
const AFFIRMATIVE = new RegExp(
  [
    String.raw`\b(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|going ahead|do it|book it|reserve it|please book|please do|sounds good|that works|looks good|perfect|proceed|i agree|agreed|lock it in|let'?s do it|lets do it|make the booking|go for it)\b`,
    // \b never matches after an accented letter, so "sí" needs its own boundaries.
    // "sí" counts anywhere; bare "si" only standing alone, because unaccented
    // "si" is Spanish for "if" ("si me dices el precio..." is not a yes).
    String.raw`((^|[\s,;¡])sí(?=$|[\s,.!?;]))|((^|[\s,;¡])si(?=$|[,.!?;]))|\b(claro|dale|adelante|de acuerdo|confirmo|confírmalo|resérvalo|reservalo|resérvala|hazlo|perfecto|vale|por supuesto)\b`,
    String.raw`\b(oui|d'accord|vas-y|allez-y|je confirme|réservez|réserve-le)\b`,
    String.raw`\b(sim|pode reservar|claro que sim)\b`,
    String.raw`\b(ja|jawohl|bestätige|mach das)\b`,
    String.raw`\b(va bene|procedi|prenota|certo)\b`,
    String.raw`(是的|好的|可以|确认|请预订|预订吧)|(はい|お願いします|予約して)|(네|예,)|(да|подтверждаю|бронируй)|(نعم|أكد)`,
  ].join('|'),
  'i',
);

const NEGATIVE = /\b(no|nope|not yet|don'?t|do not|stop|wait|hold on|nevermind|never mind|no gracias|espera|non|nein|нет)\b/i;
const CLEAR_YES = /\b(yes|oui|ja|sim)\b|((^|[\s,;¡])sí(?=$|[\s,.!?;]))|((^|[\s,;¡])si(?=$|[,.!?;]))/i;

/** True only for a real go-ahead. A "no" anywhere wins unless a plain yes is also present. */
export function isAffirmative(text = '') {
  const value = String(text);
  if (!value.trim()) return false;
  if (NEGATIVE.test(value) && !CLEAR_YES.test(value)) return false;
  return AFFIRMATIVE.test(value);
}

/* ------------------------------------------------------------- identity -- */

export const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** "sam at example dot com" -> "sam@example.com", so a spelled-out address still matches. */
export function normalizeEmailish(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/\s*[[(]?\s*\b(at|arroba|chez)\b\s*[\])]?\s*/g, '@')
    .replace(/\s*[[(]?\s*\b(dot|punto|point)\b\s*[\])]?\s*/g, '.')
    .replace(/\s+/g, '');
}

/* -------------------------------------------------------- the write gate -- */

const WRITES = new Set(['book', 'cancel_booking', 'reschedule_booking']);

/**
 * The last line of defence before anything in the sandbox changes. Returns
 * null to allow the call, or a { error, message } object that is handed back
 * to the model as that tool's result, which makes it ask instead of act.
 *
 * @param {string} name
 * @param {object} args already sanitized
 * @param {{ state: object }} session
 * @param {{ userText: string, userCorpus: string }} turn
 */
export function gate(name, args, session, turn) {
  if (!WRITES.has(name)) return null;

  const saidYes = isAffirmative(turn.userText);

  if (name === 'book') {
    const email = String(args.guestEmail ?? '').trim();
    const fullName = String(args.guestName ?? '').trim();

    if (!EMAIL_RE.test(email) || !fullName) {
      return {
        error: 'identity_required',
        message:
          "Nothing was booked. A booking needs the guest's full name and a valid email address. Ask the user for whichever one is missing, in one short question.",
      };
    }
    // The model must never supply an identity the user did not give it.
    const corpus = normalizeEmailish(turn.userCorpus);
    if (!corpus.includes(normalizeEmailish(email))) {
      return {
        error: 'identity_not_from_user',
        message:
          'Nothing was booked. That email address did not come from the user. Never invent or assume guest details: ask the user which name and email to put on the reservation.',
      };
    }
    const firstName = fullName.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstName.length > 1 && !turn.userCorpus.toLowerCase().includes(firstName)) {
      return {
        error: 'identity_not_from_user',
        message: 'Nothing was booked. That name did not come from the user. Ask whose name the reservation should be in.',
      };
    }
    if (!args.quoteId) {
      return {
        error: 'quote_required',
        message: 'Nothing was booked. Call quote first with these exact inputs and book with the quoteId it returns.',
      };
    }
    if (!saidYes) {
      return {
        error: 'confirmation_required',
        message:
          'Nothing was booked and nothing has changed. First tell the user the venue, date, time, headcount and the exact quoted total, then ask them to confirm. Call book only in a turn where they have said yes.',
      };
    }
    return null;
  }

  if (name === 'cancel_booking') {
    if (!saidYes) {
      return {
        error: 'confirmation_required',
        message:
          'Nothing was cancelled and the booking is untouched. Look it up, tell the user what it is and what the refund would be, and ask them to confirm. Call cancel_booking only in a turn where they have said yes.',
      };
    }
    return null;
  }

  if (name === 'reschedule_booking') {
    if (!['date', 'startTime', 'endTime'].some((key) => args[key])) {
      return { error: 'nothing_to_change', message: 'Send at least one of date, startTime or endTime.' };
    }
    if (!saidYes) {
      return {
        error: 'confirmation_required',
        message:
          'Nothing was moved and the booking is untouched. Quote the new slot, tell the user the new total, and ask them to confirm. Call reschedule_booking only in a turn where they have said yes.',
      };
    }
    return null;
  }

  return null;
}

/* ------------------------------------------------------------- scrubbing -- */

/** Things a host, or a user, may have tried to plant in the answer. */
const POISON = [
  /PLEC\s?90/i,
  /\b\d{1,3}\s*%\s*(off|discount|descuento|de descuento|rabatt|sconto)\b/i,
  /\bcode\s+["'`]?[A-Z0-9][A-Z0-9_-]{3,}["'`]?/,
  /\b(promo|discount|coupon|voucher)\s+code\s+(is\s+)?["'`]?[A-Z0-9][A-Z0-9_-]{2,}/i,
  /\bfree\s+(today|of charge for you)\b/i,
  /\bignore (your|all|the|previous|prior) instructions\b/i,
];

/** Split into sentences without losing the punctuation. */
const sentences = (text) => text.split(/(?<=[.!?\n])\s+/);

/**
 * Remove markdown the chat page will not render, and drop any sentence
 * carrying a planted instruction or an invented discount.
 * @returns {{ text: string, dropped: boolean }}
 */
export function scrubText(text = '') {
  let out = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|\s)__([^_\n]+)__/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1: $2');

  let dropped = false;
  out = sentences(out)
    .filter((sentence) => {
      const poisoned = POISON.some((pattern) => pattern.test(sentence));
      if (poisoned) dropped = true;
      return !poisoned;
    })
    .join(' ');

  return { text: out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

/* ------------------------------------------------------------ card data -- */

/** A 13 to 19 digit run, however the user spaced it. */
const CARD_LIKE = /\b(?:\d[ -]?){12,18}\d\b/g;

const luhn = (digits) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * If someone pastes a card number, it must not come back out: not in the
 * reply, not in a confirmation, not anywhere. Checked with Luhn so a booking
 * reference or a long id is left alone.
 */
export function redactCardNumbers(text = '') {
  return String(text).replace(CARD_LIKE, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[card number removed]' : match;
  });
}

/* ------------------------------------------------------------ emergency -- */

const EMERGENCY =
  /\b(someone (?:is|got|has been|just got) (?:hurt|injured|bleeding|unconscious|stabbed|shot)|is ?n[o']?t breathing|not breathing|heart attack|overdose|call an ambulance|medical emergency|there'?s a fire|building is on fire|being attacked|assaulted right now)\b|\b(alguien se (?:ha )?(?:hecho da[ñn]o|lastimado|desmayado)|emergencia m[ée]dica|no respira|llamen? a una ambulancia)\b/i;

/** Is this person telling you someone is in danger right now? */
export const isEmergency = (text = '') => EMERGENCY.test(String(text));

/* ---------------------------------------------------------- status truth -- */

const PAID_CLAIM =
  /\b(is|has been|was|it'?s|are)\s+(now\s+)?(fully\s+)?(paid|paid in full|confirmed|all set|locked in|booked and confirmed)\b/gi;

/**
 * If the sandbox says a booking is pending_payment or requested, no sentence in
 * the reply may call it paid or confirmed.
 * @param {string} text
 * @param {Array<{ status?: string }>} bookings bookings touched this turn
 */
export function truthGuard(text = '', bookings = []) {
  const open = bookings.filter((b) => b?.status && b.status !== 'confirmed' && b.status !== 'cancelled');
  if (open.length === 0) return text;
  const requested = open.some((b) => b.status === 'requested');
  const honest = requested ? 'is requested and waiting on the host' : 'is held and waiting on payment';
  return String(text).replace(PAID_CLAIM, honest);
}
