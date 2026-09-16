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

export const DEFAULT_PEOPLE = [
  { name: 'You', phone: '', color: C.oxblood, is_self: true },
  { name: 'Mum', phone: '', color: C.sage },
  { name: 'Dad', phone: '', color: C.gold },
  { name: 'Derek', phone: '', color: C.brass },
  { name: 'Alice', phone: '', color: C.walnutSoft },
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

export const ENERGY = [
  { id: 'low', label: 'Low', icon: BatteryLow, note: 'Repairs, restock shelves, easy wins only.' },
  { id: 'med', label: 'Medium', icon: BatteryMedium, note: 'Consignment intake, listings, calls.' },
  { id: 'high', label: 'High', icon: BatteryFull, note: 'Systems, planning, the stuff you avoid.' },
];

export const DEFAULT_MURBAH = [
  { title: 'Front room → commercial lease', note: 'Passive once tenanted. Fastest to set up.', stage: 'idea' },
  { title: 'Rehearsal room → band bookings', note: 'A couple a month, on your terms.', stage: 'idea' },
  { title: 'Band residency', note: 'Rehearsal + stay, bundled — higher $, low frequency.', stage: 'idea' },
];
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
// Tiered consignment commission: 30% on the whole price up to $2000, 20% above.
export function commissionFor(price) {
  const p = Number(price) || 0;
  return p <= 2000 ? p * 0.3 : p * 0.2;
}
export function money(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return '$0';
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
