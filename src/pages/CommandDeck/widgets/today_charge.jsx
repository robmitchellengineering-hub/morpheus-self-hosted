import { Check } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, ENERGY } from '../deckConstants';
import { Card, EmptyNote, rowBox, checkBtn } from '../DeckUI';

export default function TodayChargeWidget() {
  const { energy, energyHistory, tasks, setEnergyLevel, toggleTask } = useCommandDeck();
  const energyInfo = ENERGY.find((e) => e.id === energy);

  return (
    <Card title="Today's charge" sub="Tap what's honest, not what's ideal.">
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {ENERGY.map((e) => {
          const Icon = e.icon;
          const active = energy === e.id;
          return (
            <button
              key={e.id}
              onClick={() => setEnergyLevel(e.id)}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem',
                padding: '0.7rem 0.4rem', borderRadius: 12, border: `1.5px solid ${active ? C.gold : C.line}`,
                background: active ? C.gold : C.paper, cursor: 'pointer',
              }}
            >
              <Icon size={20} color={active ? C.walnut : C.walnutSoft} />
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: active ? C.walnut : C.walnutSoft }}>{e.label}</span>
            </button>
          );
        })}
      </div>
      {energyInfo && <p style={{ fontSize: '0.82rem', color: C.walnutSoft, marginTop: '0.65rem', marginBottom: 0 }}>{energyInfo.note}</p>}

      {energyHistory.length > 0 && (
        <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.8rem' }}>
          {[...Array(7)].map((_, i) => {
            const d = new Date();
            d.setDate(d.getDate() - (6 - i));
            const key = d.toISOString().slice(0, 10);
            const entry = energyHistory.find((h) => (h.date || '').slice(0, 10) === key);
            const dotColor = entry ? { low: C.alert, med: C.gold, high: C.sage }[entry.level] : C.line;
            return (
              <div key={key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }}>
                <div style={{ width: '100%', height: 8, borderRadius: 4, background: dotColor }} />
                <span style={{ fontSize: '0.58rem', color: C.walnutSoft, opacity: 0.7 }}>{d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
              </div>
            );
          })}
        </div>
      )}

      {energy && (
        <div style={{ marginTop: '0.8rem' }}>
          <p style={{ fontSize: '0.68rem', fontWeight: 600, color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem' }}>
            Fits right now
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {tasks.filter((t) => !t.done && (t.energy === energy || !t.energy || t.energy === 'any')).slice(0, 5).map((t) => (
              <div key={t.id} style={rowBox}>
                <button onClick={() => toggleTask(t.id)} style={checkBtn(t.done, C.sage)}>{t.done && <Check size={12} color={C.paper} />}</button>
                <span style={{ flex: 1, fontSize: '0.83rem' }}>{t.text}</span>
              </div>
            ))}
            {tasks.filter((t) => !t.done && (t.energy === energy || !t.energy || t.energy === 'any')).length === 0 && (
              <EmptyNote text="No tasks tagged for this yet — add one below and tag it." />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
