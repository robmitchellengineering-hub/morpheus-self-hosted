import { C } from '../deckConstants';
import { Card, RhythmRow } from '../DeckUI';

export default function WeekRhythmWidget() {
  return (
    <Card title="Week rhythm" sub="30 hrs, shaped around your energy — not against it.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <RhythmRow day="Tue – Sat, 10–4" what="Shop floor: sales, demos, repairs between customers" tone={C.sage} />
        <RhythmRow day="One weekday" what="Derek covers the shop — you get a clear block" tone={C.brass} />
        <RhythmRow day="Evening block" what="Consignment system + listings (low-energy, doable tired)" tone={C.oxblood} />
        <RhythmRow day="When sharp" what="The stuff you're avoiding — bureaucracy, planning, calls" tone={C.walnutSoft} />
      </div>
    </Card>
  );
}
