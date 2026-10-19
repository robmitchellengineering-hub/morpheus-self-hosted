import { Plus, Loader2, RefreshCw, Calendar } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card, MicField, IconButton, EmptyNote, miniInput, rowBox, ghostBtn } from '../DeckUI';

// The generic Calendar widget (Rob, 2026-09-17: alongside Inbox, the two
// widgets every account should get by default). Deliberately simple: a
// refresh-on-demand upcoming-events list (same pattern MurbahPanel's own
// "Upcoming bookings" section already uses) plus a quick-add form. Separate
// from Signal Chain's own Murbah↔Calendar sync.
export default function CalendarWidget() {
  const { calendarEvents, calendarLoading, calendarForm, setCalendarForm, calendarBusy, loadCalendarEvents, addCalendarEvent } = useCommandDeck();
  const form = calendarForm;
  const setForm = setCalendarForm;
  const events = calendarEvents;
  const loading = calendarLoading;
  const busy = calendarBusy;
  const onRefresh = loadCalendarEvents;
  const onAdd = addCalendarEvent;

  return (
    <Card title="Calendar" sub="Your real Google Calendar, right here.">
      <div>
        {/* Rob, 2026-09-28: "The calender buttons are haning off the tile on mobile." The row could
            not wrap and a date input has a large intrinsic width, so MicField + date + button
            overflowed the card. Now the row wraps and every part of it may shrink (minWidth: 0 —
            a flex item will not shrink below its content's minimum without it). */}
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
          <MicField
            placeholder="Event title…"
            value={form.summary}
            onChange={(summary) => setForm({ ...form, summary })}
            onSubmit={() => form.summary.trim() && form.date && onAdd()}
            wrapperStyle={{ minWidth: 0, flex: '1 1 160px' }}
          />
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} style={{ ...miniInput, flex: '1 1 130px', minWidth: 0 }} />
          <IconButton onClick={onAdd} color={C.brass} disabled={busy || !form.summary.trim() || !form.date}>
            {busy ? <Loader2 size={16} className="animate-spin" color={C.paper} /> : <Plus size={18} color={C.paper} />}
          </IconButton>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Upcoming</span>
          <button onClick={onRefresh} disabled={loading} style={{ ...ghostBtn, fontSize: '0.7rem', color: C.brass, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        </div>
        {events.length === 0 ? (
          <EmptyNote text="Nothing loaded yet — hit Refresh (needs Google connected in Settings)." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {events.map((e) => (
              <div key={e.id} style={rowBox}>
                <Calendar size={13} color={C.brass} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: '0.78rem' }}>{e.summary}</span>
                <span style={{ fontSize: '0.68rem', color: C.walnutSoft, flexShrink: 0 }}>{e.start}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
