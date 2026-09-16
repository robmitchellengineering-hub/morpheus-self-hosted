import { useState } from 'react';
import { Mic, Plus, X } from 'lucide-react';
import { C } from './deckConstants';
import { Card, inputStyle, miniInput, rowBox, ghostBtn, pillBtn } from './DeckUI';
import { useTuner } from './tools/useTuner';
import { LENGTH_UNITS, WEIGHT_UNITS, convert } from './tools/units';

const TOOLS = [
  { id: 'tuner', label: 'Tuner' },
  { id: 'length', label: 'Length' },
  { id: 'weight', label: 'Weight' },
  { id: 'ohms', label: "Ohm's law" },
  { id: 'resistance', label: 'Resistance' },
  { id: 'divider', label: 'Voltage divider' },
  { id: 'crossover', label: 'Crossover' },
];

// Workshop tools — fully client-side, no backend: a guitar tuner (real
// mic-based pitch detection, see tools/useTuner.js) plus unit converters
// and electronics calculators any repair/workshop day needs.
export default function DeckTools() {
  const [tool, setTool] = useState('tuner');

  return (
    <Card title="Workshop tools" sub="Tuner, unit converters, and electronics calculators.">
      <div style={{ display: 'flex', gap: '0.4rem', overflowX: 'auto', paddingBottom: '0.5rem', marginBottom: '0.7rem' }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            style={{
              flexShrink: 0,
              padding: '0.4rem 0.8rem', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
              border: `1.5px solid ${tool === t.id ? C.brass : C.line}`,
              background: tool === t.id ? C.brass : 'transparent',
              color: tool === t.id ? C.paper : C.walnutSoft,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tool === 'tuner' && <TunerTool />}
      {tool === 'length' && <ConverterTool title="Length" units={LENGTH_UNITS} defaultFrom="cm" defaultTo="in" />}
      {tool === 'weight' && <ConverterTool title="Weight" units={WEIGHT_UNITS} defaultFrom="g" defaultTo="oz" />}
      {tool === 'ohms' && <OhmsLawTool />}
      {tool === 'resistance' && <ResistanceTool />}
      {tool === 'divider' && <VoltageDividerTool />}
      {tool === 'crossover' && <CrossoverTool />}
    </Card>
  );
}

// ---- guitar tuner --------------------------------------------------------
function TunerTool() {
  const [a4, setA4] = useState(440);
  const { listening, error, reading, start, stop } = useTuner(a4);

  const cents = reading?.cents ?? 0;
  const clampedCents = Math.max(-50, Math.min(50, cents));
  const needlePct = 50 + clampedCents; // 0..100 across the -50..+50 scale
  const inTune = reading && Math.abs(cents) <= 5;

  return (
    <div>
      <p style={{ margin: '0 0 0.7rem', fontSize: '0.8rem', color: C.walnutSoft }}>Play a string — shows the note, frequency, and how far off it is.</p>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button onClick={() => setA4(440)} style={{ ...pillBtn(a4 === 440 ? C.brass : C.walnutSoft), flex: 1, padding: '0.5rem' }}>A4 = 440 Hz</button>
        <button onClick={() => setA4(432)} style={{ ...pillBtn(a4 === 432 ? C.brass : C.walnutSoft), flex: 1, padding: '0.5rem' }}>A4 = 432 Hz</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
        <button
          onClick={() => (listening ? stop() : start())}
          style={{
            width: 72, height: 72, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: listening ? C.alert : C.gold, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Mic size={28} color={C.walnut} />
        </button>
        <p style={{ margin: 0, fontSize: '0.78rem', color: C.walnutSoft }}>{listening ? (reading ? 'Listening…' : 'Play a note…') : 'Tap the mic to start tuning.'}</p>
        {error && <p style={{ margin: 0, fontSize: '0.78rem', color: C.alert }}>{error}</p>}

        <div style={{ fontSize: '2.4rem', fontWeight: 700, color: inTune ? C.sage : C.walnut, minHeight: '3rem' }}>
          {reading?.note || '—'}
        </div>
        <div style={{ fontSize: '0.82rem', color: C.walnutSoft }}>
          {reading ? `${reading.frequency.toFixed(1)} Hz` : '—'}
        </div>

        <div style={{ width: '100%', marginTop: '0.4rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: C.walnutSoft, marginBottom: '0.25rem' }}>
            <span>♭ -50</span>
            <span>0</span>
            <span>+50 ♯</span>
          </div>
          <div style={{ position: 'relative', height: 8, borderRadius: 4, background: C.tweedDark }}>
            <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 2, background: C.line }} />
            {reading && (
              <div style={{ position: 'absolute', left: `${needlePct}%`, top: -4, bottom: -4, width: 4, borderRadius: 2, background: inTune ? C.sage : C.alert, transform: 'translateX(-50%)' }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- unit converter -------------------------------------------------------
function ConverterTool({ title, units, defaultFrom, defaultTo }) {
  const [fromUnit, setFromUnit] = useState(defaultFrom);
  const [toUnit, setToUnit] = useState(defaultTo);
  const [fromValue, setFromValue] = useState('1');

  const result = convert(fromValue, fromUnit, toUnit, units);

  const swap = () => {
    setFromUnit(toUnit);
    setToUnit(fromUnit);
  };

  return (
    <div>
      <p style={{ margin: '0 0 0.7rem', fontSize: '0.8rem', color: C.walnutSoft }}>{title} — real-world units, converted both ways.</p>
      <label style={{ fontSize: '0.68rem', fontWeight: 600, color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>From</label>
      <div style={{ display: 'flex', gap: '0.4rem', margin: '0.3rem 0 0.8rem' }}>
        <input value={fromValue} onChange={(e) => setFromValue(e.target.value)} inputMode="decimal" style={{ ...inputStyle, flex: 1 }} />
        <select value={fromUnit} onChange={(e) => setFromUnit(e.target.value)} style={{ ...miniInput, flex: '0 0 150px' }}>
          {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.8rem' }}>
        <button onClick={swap} style={{ ...ghostBtn, background: C.tweedDark, borderRadius: 8, padding: '0.4rem 0.7rem', fontSize: '0.75rem', color: C.walnutSoft }}>⇄ Swap</button>
      </div>

      <label style={{ fontSize: '0.68rem', fontWeight: 600, color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>To</label>
      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
        <input readOnly value={result == null ? '' : Number(result.toFixed(6))} style={{ ...inputStyle, flex: 1, background: C.tweedDark }} />
        <select value={toUnit} onChange={(e) => setToUnit(e.target.value)} style={{ ...miniInput, flex: '0 0 150px' }}>
          {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
      </div>
    </div>
  );
}

// ---- Ohm's law --------------------------------------------------------
function OhmsLawTool() {
  const [v, setV] = useState('');
  const [i, setI] = useState('');
  const [r, setR] = useState('');

  const num = (s) => (s.trim() === '' ? null : Number(s));

  const onChangeV = (val) => {
    setV(val);
    const nv = num(val), ni = num(i), nr = num(r);
    if (nv != null && ni != null && nr == null) setR(String(nv / ni));
    else if (nv != null && nr != null && ni == null) setI(String(nv / nr));
  };
  const onChangeI = (val) => {
    setI(val);
    const nv = num(v), ni = num(val), nr = num(r);
    if (nv != null && nr == null && ni != null) setR(String(nv / ni));
    else if (nr != null && nv == null && ni != null) setV(String(nr * ni));
  };
  const onChangeR = (val) => {
    setR(val);
    const nv = num(v), ni = num(i), nr = num(val);
    if (nv != null && ni == null && nr != null) setI(String(nv / nr));
    else if (ni != null && nv == null && nr != null) setV(String(ni * nr));
  };

  const power = num(v) != null && num(i) != null ? num(v) * num(i) : null;

  return (
    <div>
      <p style={{ margin: '0 0 0.7rem', fontSize: '0.8rem', color: C.walnutSoft }}>Fill in any two — the third fills itself in.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <Field label="Voltage (V)" value={v} onChange={onChangeV} />
        <Field label="Current (A)" value={i} onChange={onChangeI} />
        <Field label="Resistance (Ω)" value={r} onChange={onChangeR} />
      </div>
      <p style={{ margin: '0.8rem 0 0', fontSize: '0.82rem', color: C.walnutSoft }}>
        Power: <strong style={{ color: C.walnut }}>{power != null ? `${power.toFixed(3)} W` : '—'}</strong>
      </p>
      <button onClick={() => { setV(''); setI(''); setR(''); }} style={{ ...pillBtn(C.walnutSoft), marginTop: '0.6rem' }}>Clear</button>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <div>
      <label style={{ fontSize: '0.68rem', fontWeight: 600, color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" style={{ ...inputStyle, width: '100%', marginTop: '0.25rem', boxSizing: 'border-box' }} />
    </div>
  );
}

// ---- resistance (series / parallel) -----------------------------------
function ResistanceTool() {
  const [values, setValues] = useState(['', '']);

  const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  const series = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
  const parallel = nums.length ? 1 / nums.reduce((a, b) => a + 1 / b, 0) : null;

  const update = (idx, val) => setValues((prev) => prev.map((v, i) => (i === idx ? val : v)));
  const addRow = () => setValues((prev) => [...prev, '']);
  const removeRow = (idx) => setValues((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div>
      <p style={{ margin: '0 0 0.7rem', fontSize: '0.8rem', color: C.walnutSoft }}>Resistor values (Ω) — series and parallel totals, live.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.6rem' }}>
        {values.map((v, idx) => (
          <div key={idx} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input value={v} onChange={(e) => update(idx, e.target.value)} placeholder={`R${idx + 1}`} inputMode="decimal" style={{ ...miniInput, flex: 1 }} />
            {values.length > 2 && <button onClick={() => removeRow(idx)} style={ghostBtn}><X size={13} color={C.walnutSoft} /></button>}
          </div>
        ))}
      </div>
      <button onClick={addRow} style={{ ...pillBtn(C.walnutSoft), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Plus size={12} /> Add resistor</button>

      <div style={{ marginTop: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div style={rowBox}>
          <span style={{ flex: 1, fontSize: '0.82rem' }}>Series total</span>
          <strong>{series != null ? `${series.toFixed(2)} Ω` : '—'}</strong>
        </div>
        <div style={rowBox}>
          <span style={{ flex: 1, fontSize: '0.82rem' }}>Parallel total</span>
          <strong>{parallel != null ? `${parallel.toFixed(2)} Ω` : '—'}</strong>
        </div>
      </div>
    </div>
  );
}

// ---- voltage divider ----------------------------------------------------
function VoltageDividerTool() {
  const [vin, setVin] = useState('9');
  const [r1, setR1] = useState('1000');
  const [r2, setR2] = useState('1000');

  const nVin = Number(vin), nR1 = Number(r1), nR2 = Number(r2);
  const vout = Number.isFinite(nVin) && Number.isFinite(nR1) && Number.isFinite(nR2) && (nR1 + nR2) > 0
    ? nVin * (nR2 / (nR1 + nR2))
    : null;

  return (
    <div>
      <p style={{ margin: '0 0 0.7rem', fontSize: '0.8rem', color: C.walnutSoft }}>Vin through R1 then R2 to ground — Vout is measured across R2.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <Field label="Vin (V)" value={vin} onChange={setVin} />
        <Field label="R1 (Ω)" value={r1} onChange={setR1} />
        <Field label="R2 (Ω)" value={r2} onChange={setR2} />
      </div>
      <p style={{ margin: '0.8rem 0 0', fontSize: '0.82rem', color: C.walnutSoft }}>
        Vout: <strong style={{ color: C.walnut }}>{vout != null ? `${vout.toFixed(3)} V` : '—'}</strong>
      </p>
    </div>
  );
}

// ---- passive crossover ---------------------------------------------------
function CrossoverTool() {
  const [freq, setFreq] = useState('2000');
  const [impedance, setImpedance] = useState('8');

  const fc = Number(freq), r = Number(impedance);
  const valid = Number.isFinite(fc) && fc > 0 && Number.isFinite(r) && r > 0;
  const capacitorUf = valid ? (1 / (2 * Math.PI * r * fc)) * 1e6 : null;
  const inductorMh = valid ? (r / (2 * Math.PI * fc)) * 1e3 : null;

  return (
    <div>
      <p style={{ margin: '0 0 0.7rem', fontSize: '0.8rem', color: C.walnutSoft }}>First-order (6 dB/octave) passive crossover — the simplest real one.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <Field label="Crossover frequency (Hz)" value={freq} onChange={setFreq} />
        <Field label="Driver impedance (Ω)" value={impedance} onChange={setImpedance} />
      </div>
      <div style={{ marginTop: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div style={rowBox}>
          <span style={{ flex: 1, fontSize: '0.82rem' }}>Tweeter capacitor (high-pass, series)</span>
          <strong>{capacitorUf != null ? `${capacitorUf.toFixed(2)} µF` : '—'}</strong>
        </div>
        <div style={rowBox}>
          <span style={{ flex: 1, fontSize: '0.82rem' }}>Woofer inductor (low-pass, series)</span>
          <strong>{inductorMh != null ? `${inductorMh.toFixed(2)} mH` : '—'}</strong>
        </div>
      </div>
    </div>
  );
}
