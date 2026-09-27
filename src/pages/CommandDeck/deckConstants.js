import {
  Guitar, Disc3, Wrench, Home, Heart, Wallet, Users, Sprout,
  BatteryLow, BatteryMedium, BatteryFull,
} from 'lucide-react';

// Command Deck — Valiant Music's daily-use board (internal codename "Deck",
// see server/prisma/schema.prisma's comment above the Deck* models).
// "Tweed & Walnut" design tokens — a deliberate departure from Morpheus's
// own Matrix look.
export const C = {
  tweed: '#E7DBBF',
  tweedDark: '#D3C296',
  paper: '#FBF6E9',
  ink: '#1C130B',
  walnut: '#241A12',
  walnutSoft: '#4A3A2C',
  brass: '#B0793C',
  brassLight: '#E3B15C',
  oxblood: '#6B2A2A',
  sage: '#4C6B44',
  line: 'rgba(28,19,11,0.24)',
  alert: '#E4402A',
  gold: '#F0A400',
};

// 2026-09-17: used to seed Rob's actual family/employee names (Mum, Dad,
// Derek, Alice) into every brand-new account — harmless while only Rob's
// own account could ever reach /deck, but Command Deck is now open to
// every signed-in user. Every new account starts with just themselves;
// they add whoever else actually matters to their own life from here.
export const DEFAULT_PEOPLE = [
  { name: 'You', phone: '', color: C.oxblood, is_self: true },
];
export const OWNER_COLOR_CYCLE = [C.oxblood, C.sage, C.gold, C.brass, C.walnutSoft, C.alert];

export const STREAM_META = {
  retail: { label: 'Retail', icon: Guitar, desc: 'Vintage guitars & gear. Listings live on the website — manage them there.', status: 'steady' },
  consignment: { label: 'Consignment', icon: Disc3, desc: '20–30% fee, no capital risk. Log items so nothing goes stale.', status: 'needs-work' },
  repairs: { label: 'Repairs', icon: Wrench, desc: 'Pure labour for cash. Fills gaps between customers.', status: 'steady' },
  murbah: { label: 'Murbah space', icon: Home, desc: 'Front room lease + rehearsal bookings. Untapped.', status: 'new' },
};
export const STREAM_ORDER = ['retail', 'consignment', 'repairs', 'murbah'];
export const STATUS_STYLE = {
  steady: { label: 'ON', color: C.sage },
  'needs-work': { label: 'NEEDS WORK', color: C.alert },
  new: { label: 'UNTAPPED', color: C.gold },
};

export const LIFE_STREAMS_META = [
  { id: 'health', label: 'Health & body', icon: Heart },
  { id: 'money', label: 'Money', icon: Wallet },
  { id: 'home', label: 'Home & place', icon: Home },
  { id: 'people', label: 'People & relationships', icon: Users },
  { id: 'growth', label: 'Growth & creative', icon: Sprout },
];

// 2026-09-17: the notes here used to be Rob's own guitar-shop-specific
// examples ("Repairs, restock shelves"/"Consignment intake, listings,
// calls.") — shown to every user regardless of what they actually do,
// since this is a shared UI constant, not per-user data. Kept generic.
export const ENERGY = [
  { id: 'low', label: 'Low', icon: BatteryLow, note: 'Easy wins only — nothing that needs real focus.' },
  { id: 'med', label: 'Medium', icon: BatteryMedium, note: 'Routine work — the steady, doable stuff.' },
  { id: 'high', label: 'High', icon: BatteryFull, note: 'Systems, planning, the stuff you keep avoiding.' },
];

// 2026-09-17: DEFAULT_MURBAH (Rob's own real Murwillumbah property plan)
// removed — it used to unconditionally seed those rows into every new
// account's DeckMurbahOpportunity list regardless of whether signal_chain
// (the widget that would ever display them) was even enabled — real data
// pollution, not just hidden-until-opted-in content. DeckMurbahOpportunity
// now starts empty for every new account, like every other Deck list.
export const MURBAH_STAGES = [
  { key: 'idea', label: 'Idea' },
  { key: 'enquired', label: 'Enquired' },
  { key: 'booked', label: 'Booked' },
  { key: 'active', label: 'Active' },
];
export const REPAIR_STAGES = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];
export const INBOX_STAGES = [
  { key: 'new', label: 'New' },
  { key: 'replied', label: 'Replied' },
  { key: 'done', label: 'Done' },
];
// Manual comms log only — no social media integration is planned (see the
// Command Deck build plan's own "explicitly out" note), so the channel list
// stays to what's actually reachable: email, the website, or "other".
export const CHANNELS = [
  { id: 'gmail', label: 'Email' },
  { id: 'website', label: 'Website' },
  { id: 'other', label: 'Other' },
];

export const WP_ADMIN_URL = 'https://valiantmusic.com.au/wp-admin/';

// One randomly-picked line shown before any real delete goes through —
// deliberately not the same dry "Are you sure?" every time. Generic enough
// to fit deleting a task, a note, a person, a file, whatever.
export const DELETE_CONFIRM_PHRASES = [
  "Gone forever, no backsies — still keen?",
  "This one's not coming back. Sure?",
  "Last chance to change your mind.",
  "Delete it? Really-really?",
  "You sure? Once it's gone, it's gone.",
  "No undo button here. Proceed?",
  "This is permanent. You good with that?",
  "Final answer?",
  "Are we doing this or are we doing this?",
  "One more click and it's history.",
  "Just checking — you meant to hit delete?",
  "Committing this one to the void. Yes?",
  "That's a one-way trip. Still going?",
  "No take-backsies. Confirm?",
  "Deleted things don't come back from a nap.",
  "Sure you don't want to just... not?",
  "This isn't a drill. Delete?",
  "You've got one job here: confirm or don't.",
  "Ready to make this disappear?",
  "Consider this your last warning.",
  "Poof — gone. That the plan?",
  "Say the word and it's toast.",
  "Sending this to the great unknown. OK?",
  "This isn't the trash can, it's the incinerator.",
  "You click, it's gone. Deal?",
  "Double-checking, because I care.",
  "Sure about this one, chief?",
  "This decision is final and slightly dramatic. Continue?",
  "About to make this vanish. Cool?",
  "You only get one shot at undoing this — and it's not this one.",
  "Confirm and it ceases to exist.",
  "Are you REALLY sure, or just clicking things?",
  "This one's staying gone. You in?",
  "Yes deletes it. No saves it. Pick wisely.",
  "One click from oblivion. Proceed?",
  "This is your villain-origin-story click. Continue?",
  "Deleting. Permanently. Just so we're clear.",
  "You've been warned. Once. That's it.",
  "Sure? Not just fat-fingered it?",
  "It's your call — but it's a big one.",
  "This ends here. Confirm?",
  "No refunds on deleted things.",
  "Going once, going twice — confirm?",
  "Say goodbye. Was it a good one?",
  "This one's not filed away, it's filed OUT.",
  "You're the boss. Still deleting?",
  "Sure? I won't judge either way.",
  "Deleted means deleted. Onward?",
  "This click has consequences. Continue?",
  "Yep, still gone after this. Confirm?",
];
export function randomDeleteConfirmPhrase() {
  return DELETE_CONFIRM_PHRASES[Math.floor(Math.random() * DELETE_CONFIRM_PHRASES.length)];
}

function stageLabelFrom(list) {
  return (key) => (list.find((s) => s.key === key) || {}).label || key;
}
function nextStageFrom(list) {
  return (key) => {
    const idx = list.findIndex((s) => s.key === key);
    return list[(idx + 1) % list.length].key;
  };
}
export const murbahStageLabel = stageLabelFrom(MURBAH_STAGES);
export const nextMurbahStage = nextStageFrom(MURBAH_STAGES);
export const repairStageLabel = stageLabelFrom(REPAIR_STAGES);
export const nextRepairStage = nextStageFrom(REPAIR_STAGES);
export const inboxStageLabel = stageLabelFrom(INBOX_STAGES);
export const nextInboxStage = nextStageFrom(INBOX_STAGES);

// is_self is the real identity marker (so the person can be renamed freely
// to a real name); the literal-"You" name check is a fallback only for
// rows created before the is_self migration ran.
export function isYou(person) {
  if (person?.is_self === true) return true;
  return (person?.name || '').trim().toLowerCase() === 'you';
}
export function smsHref(phone, text) {
  const clean = (phone || '').replace(/[^\d+]/g, '');
  if (!clean) return '#';
  return `sms:${clean}?&body=${encodeURIComponent(text)}`;
}
export function emailHref(email, subject, body) {
  if (!email) return '#';
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
export function todayISO() {
  return new Date(`${todayKey()}T00:00:00.000Z`).toISOString();
}
// 2026-09-28: the consignment fee is no longer a constant in this file. Rob: "Consignment is a
// set fee structure but i can change it in settings." It is now per-account settings
// (DeckBusinessProfile.fee_*), so the derivation moved to ./feeTiers — a pure module with no
// imports, which lets scripts/verify-deck-fee-tiers.mjs exercise the REAL derivation in CI's
// no-install guards job (importing this file would drag in lucide-react). Re-exported rather
// than aliased so every existing `commissionFor` importer from here keeps working.
export {
  DEFAULT_FEE_TIERS, normalizeFeeTiers, feeTiersFromProfile, commissionFor,
  consignorProceeds, formatFeeRate, feeRateLabel, parseFeeTierInput,
} from './feeTiers';
export function money(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return '$0';
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
