import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Check, X, Paperclip, FileText, Loader2, RefreshCw, Calendar, Pencil } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, STREAM_META, STREAM_ORDER, STATUS_STYLE, WP_ADMIN_URL, murbahStageLabel, repairStageLabel, money, commissionFor, consignorProceeds, feeRateLabel } from '../deckConstants';
import { Card, EmptyNote, PendingNote, miniInput, rowBox, ghostBtn, pillBtn, checkBtn, MicField, MicTextarea } from '../DeckUI';

// What a sold item says about the money. The commission is the STORED fee (see the schema note),
// not a re-derivation of the tiered rule: the rule can change, what was agreed with the consignor
// cannot. A row with no price, or no fee, says so rather than showing a number we do not have —
// "not recorded" and "$0" are different answers, and this line is what Rob quotes back to someone.
function soldLabel(i) {
  const hasPrice = i.sold_price !== null && i.sold_price !== undefined;
  const hasFee = i.fee !== null && i.fee !== undefined;
  if (!hasPrice) return 'sold — no sale price recorded';
  if (!hasFee) return `sold ${money(i.sold_price)} — commission not recorded`;
  const toConsignor = i.sold_price - i.fee;
  return `sold ${money(i.sold_price)} · our cut ${money(i.fee)} · ${money(toConsignor)} to ${(i.consignor || 'the consignor').trim()}`;
}

function ConsignmentPanel({ items, form, setForm, onAdd, onToggle, onUpdate, onRemove, uploadFile, adding, feeTiers }) {
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  // The sale fields that change after intake: what it actually sold for, and whether the consignor
  // has been paid. Opened by the pencil on a sold row.
  const [editing, setEditing] = useState(null);
  const unsold = items.filter((i) => !i.sold);
  const totalValue = unsold.reduce((sum, i) => sum + i.price, 0);
  const q = search.trim().toLowerCase();
  const visible = q
    ? items.filter((i) => i.item.toLowerCase().includes(q) || (i.consignor || '').toLowerCase().includes(q) || (i.phone || '').toLowerCase().includes(q))
    : items;

  const handlePhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadFile(file);
      setForm((f) => ({ ...f, photo_url: url }));
    } catch { /* skip the photo rather than block the entry */ }
    setBusy(false);
  };

  const saveSold = async () => {
    if (!editing) return;
    const { id, sold_price, paid_out } = editing;
    setEditing(null);
    await onUpdate(id, { sold_price: sold_price === '' ? null : sold_price, paid_out });
  };
  const formSoldPrice = form.sold_price === '' ? null : Number(form.sold_price) || 0;

  return (
    <div>
      <div style={{ opacity: adding ? 0.6 : 1, pointerEvents: adding ? 'none' : 'auto' }}>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {/* A mic button per field would cram 4 already-tight cells; Enter-to-add
            on all of them (2026-09-17: "brain dump... needs to send" — same
            expectation applies to every add-row, not just brain dump) is the
            part that actually matters here. */}
        <input placeholder="Item" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '1 1 100px' }} />
        <input placeholder="Consignor" value={form.consignor} onChange={(e) => setForm({ ...form, consignor: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Price $" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '0 1 70px' }} />
      </div>
      {/* Items that sell the day they arrive are common enough that the sale belongs here too,
          rather than being added unsold and immediately toggled. Blank means "still on the floor". */}
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <input
          placeholder="Sold price $"
          inputMode="decimal"
          value={form.sold_price}
          onChange={(e) => setForm({ ...form, sold_price: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          style={{ ...miniInput, flex: '0 1 100px' }}
        />
        {formSoldPrice !== null && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: C.walnutSoft }}>
            <input type="checkbox" checked={!!form.paid_out} onChange={(e) => setForm({ ...form, paid_out: e.target.checked })} />
            Paid out
          </label>
        )}
        <span style={{ fontSize: '0.68rem', color: C.walnutSoft }}>
          {formSoldPrice === null
            ? 'leave blank if it is still on the floor'
            : `logs it as sold · our cut ${money(commissionFor(formSoldPrice, feeTiers))}, ${money(consignorProceeds(formSoldPrice, feeTiers))} to the consignor`}
        </span>
      </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
        <label style={{ ...pillBtn(C.walnutSoft), cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
          {form.photo_url ? 'Retake photo' : 'Add photo'}
          <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: 'none' }} />
        </label>
        {busy && <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>uploading…</span>}
        {form.photo_url && !busy && <img src={form.photo_url} alt="preview" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover', border: `1px solid ${C.line}` }} />}
        <button onClick={onAdd} disabled={adding} style={{ ...pillBtn(C.oxblood), marginLeft: 'auto', opacity: adding ? 0.7 : 1 }}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
      <PendingNote show={adding} text="Adding it — the shop list updates in a moment…" />
      {form.price && (
        <p style={{ fontSize: '0.72rem', color: C.walnutSoft, margin: '0 0 0.5rem' }}>
          At {money(form.price)}: {feeRateLabel(form.price, feeTiers)} rate → your cut {money(commissionFor(form.price, feeTiers))}
        </p>
      )}
      {items.length > 0 && (
        <>
          <p style={{ fontSize: '0.75rem', color: C.walnutSoft, margin: '0 0 0.5rem' }}>{unsold.length} unsold · {money(totalValue)} on the floor</p>
          <MicField placeholder="Search item, consignor, or phone…" value={search} onChange={setSearch} style={{ ...miniInput, width: '100%' }} wrapperStyle={{ marginBottom: '0.5rem' }} />
        </>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {visible.map((i) => (
          <div key={i.id} style={{ ...rowBox, opacity: i.sold ? 0.55 : 1, alignItems: 'center' }}>
            {i.photo_url ? (
              <img src={i.photo_url} alt={i.item} style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <div style={{ width: 38, height: 38, borderRadius: 8, background: C.tweedDark, flexShrink: 0 }} />
            )}
            <button onClick={() => onToggle(i.id)} style={checkBtn(i.sold, C.sage)}>{i.sold && <Check size={12} color={C.paper} />}</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, textDecoration: i.sold ? 'line-through' : 'none' }}>{i.item}</div>
              <div style={{ fontSize: '0.72rem', color: C.walnutSoft }}>
                {i.consignor}{i.phone ? ` · ${i.phone}` : ''} · {money(i.price)} · you get {money(commissionFor(i.price, feeTiers))}
              </div>
              {i.sold && (editing?.id === i.id ? (
                <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                  <input
                    placeholder="Sold for $"
                    inputMode="decimal"
                    value={editing.sold_price}
                    onChange={(e) => setEditing({ ...editing, sold_price: e.target.value })}
                    style={{ ...miniInput, flex: '0 1 90px' }}
                  />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: C.walnutSoft }}>
                    <input type="checkbox" checked={editing.paid_out} onChange={(e) => setEditing({ ...editing, paid_out: e.target.checked })} />
                    Paid out
                  </label>
                  <button onClick={saveSold} style={{ ...pillBtn(C.sage), fontSize: '0.68rem' }}>Save</button>
                  <button onClick={() => setEditing(null)} style={{ ...ghostBtn, fontSize: '0.68rem' }}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.15rem' }}>
                  <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>
                    {soldLabel(i)} · {i.paid_out ? 'paid out' : 'payout owed'}
                  </span>
                  <button
                    onClick={() => setEditing({ id: i.id, sold_price: i.sold_price ?? '', paid_out: !!i.paid_out })}
                    style={{ ...ghostBtn, padding: 0 }}
                    title="Edit the sale price and payout"
                  >
                    <Pencil size={11} color={C.brass} />
                  </button>
                </div>
              ))}
            </div>
            <button onClick={() => onRemove(i.id)} style={ghostBtn}><X size={13} color={C.walnutSoft} /></button>
          </div>
        ))}
        {items.length === 0 && <EmptyNote text="No consignment items logged yet." />}
        {items.length > 0 && visible.length === 0 && <EmptyNote text="No matches." />}
      </div>
    </div>
  );
}

function RepairsPanel({ items, form, setForm, onAdd, onUpdate, onCycle, onRemove, onAddFilesToJob, onRemoveFileFromJob, onOpenImage, uploadFile, adding }) {
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [busyJobId, setBusyJobId] = useState(null);
  // The quote and the promised date are agreed on the phone or at the counter, and both change
  // afterwards — this is the one place they are edited.
  const [editing, setEditing] = useState(null);
  const stageColor = { waiting: C.alert, in_progress: C.gold, done: C.sage };

  const q = search.trim().toLowerCase();
  const visible = q
    ? items.filter((r) => r.item.toLowerCase().includes(q) || (r.customer || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q) || (r.notes || '').toLowerCase().includes(q))
    : items;

  const processFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    const added = [];
    for (const file of files) {
      if (file.size > 8 * 1024 * 1024) continue; // keep uploads sane on mobile data
      try {
        const url = await uploadFile(file);
        added.push({ id: `${Date.now()}-${Math.random()}`, name: file.name, file_url: url, is_image: file.type.startsWith('image/') });
      } catch { /* skip files that fail to upload rather than block the entry */ }
    }
    return added;
  };

  const handleFiles = async (e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    const added = await processFiles(fileList);
    setForm((f) => ({ ...f, pendingFiles: [...(f.pendingFiles || []), ...added] }));
    setBusy(false);
    e.target.value = '';
  };
  const removeFormFile = (id) => setForm((f) => ({ ...f, pendingFiles: (f.pendingFiles || []).filter((x) => x.id !== id) }));

  const saveJobDates = async () => {
    if (!editing) return;
    const { id, quote, promised_date } = editing;
    setEditing(null);
    await onUpdate(id, { quote, promised_date });
  };

  const handleJobFiles = async (jobId, e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setBusyJobId(jobId);
    const added = await processFiles(fileList);
    if (added.length > 0) onAddFilesToJob(jobId, added);
    setBusyJobId(null);
    e.target.value = '';
  };

  return (
    <div>
      <div style={{ opacity: adding ? 0.6 : 1, pointerEvents: adding ? 'none' : 'auto' }}>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <input placeholder="Customer" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Item / job" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '1 1 100px' }} />
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <input placeholder="Quote $" inputMode="decimal" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} style={{ ...miniInput, flex: '0 1 90px' }} />
        <input type="date" value={form.promised_date} onChange={(e) => setForm({ ...form, promised_date: e.target.value })} style={{ ...miniInput, flex: '0 1 140px' }} title="Promised for" />
        <span style={{ fontSize: '0.68rem', color: C.walnutSoft }}>quote and promised date — both optional, both editable later</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <label style={{ ...pillBtn(C.walnutSoft), cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          <Paperclip size={12} /> Add photo
          <input type="file" accept="image/*" capture="environment" multiple onChange={handleFiles} style={{ display: 'none' }} disabled={busy} />
        </label>
        {busy && <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>uploading…</span>}
        <button onClick={onAdd} disabled={adding} style={{ ...pillBtn(C.oxblood), marginLeft: 'auto', opacity: adding ? 0.7 : 1 }}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
      </div>
      <PendingNote show={adding} text="Adding the job — it lands in the queue as Waiting…" />

      {form.pendingFiles?.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          {form.pendingFiles.map((f) => (
            <div key={f.id} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.3rem', background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: '0.3rem 0.5rem' }}>
              {f.is_image ? <img src={f.file_url} alt={f.name} style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> : <FileText size={16} color={C.walnutSoft} />}
              <span style={{ fontSize: '0.68rem', color: C.walnutSoft, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button onClick={() => removeFormFile(f.id)} style={{ ...ghostBtn, padding: 0 }}><X size={12} color={C.walnutSoft} /></button>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <MicField placeholder="Search customer, item, or notes…" value={search} onChange={setSearch} style={{ ...miniInput, width: '100%' }} wrapperStyle={{ marginBottom: '0.5rem' }} />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {visible.map((r) => {
          const primaryImage = (r.files || []).find((f) => f.is_image)?.file_url;
          return (
            <div key={r.id} style={{ ...rowBox, alignItems: 'flex-start' }}>
              {primaryImage ? (
                <button onClick={() => onOpenImage(primaryImage)} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }} title="Tap to view bigger">
                  <img src={primaryImage} alt={r.item} style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', border: `1.5px solid ${C.line}` }} />
                </button>
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: 8, background: C.tweedDark, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{r.item}</div>
                <div style={{ fontSize: '0.72rem', color: C.walnutSoft }}>{r.customer}{r.phone ? ` · ${r.phone}` : ''}</div>
                {editing?.id === r.id ? (
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                    <input
                      placeholder="Quote $"
                      inputMode="decimal"
                      value={editing.quote}
                      onChange={(e) => setEditing({ ...editing, quote: e.target.value })}
                      style={{ ...miniInput, flex: '0 1 90px' }}
                    />
                    <input
                      type="date"
                      value={editing.promised_date}
                      onChange={(e) => setEditing({ ...editing, promised_date: e.target.value })}
                      style={{ ...miniInput, flex: '0 1 140px' }}
                      title="Promised for"
                    />
                    <button onClick={saveJobDates} style={{ ...pillBtn(C.sage), fontSize: '0.68rem' }}>Save</button>
                    <button onClick={() => setEditing(null)} style={{ ...ghostBtn, fontSize: '0.68rem' }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.15rem' }}>
                    <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>
                      {r.quote === null || r.quote === undefined ? 'no quote' : `quote ${money(r.quote)}`}
                      {' · '}
                      {r.promised_date ? `promised ${(r.promised_date || '').slice(0, 10)}` : 'no promised date'}
                    </span>
                    <button
                      onClick={() => setEditing({
                        id: r.id,
                        quote: r.quote === null || r.quote === undefined ? '' : String(r.quote),
                        promised_date: (r.promised_date || '').slice(0, 10),
                      })}
                      style={{ ...ghostBtn, padding: 0 }}
                      title="Edit the quote and promised date"
                    >
                      <Pencil size={11} color={C.brass} />
                    </button>
                  </div>
                )}
                {r.files && r.files.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                    {r.files.map((f) => (
                      <div key={f.id} style={{ display: 'inline-flex', alignItems: 'center', background: C.tweedDark, borderRadius: 6, paddingRight: '0.2rem' }}>
                        {f.is_image ? (
                          <button
                            onClick={() => onOpenImage(f.file_url)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: 'none', borderRadius: 6, padding: '0.2rem 0.4rem', border: 'none', cursor: 'pointer' }}
                            title={`View ${f.name} bigger`}
                          >
                            <img src={f.file_url} alt={f.name} style={{ width: 16, height: 16, borderRadius: 3, objectFit: 'cover' }} />
                            <span style={{ fontSize: '0.64rem', color: C.walnutSoft, maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                          </button>
                        ) : (
                          <a
                            href={f.file_url}
                            download={f.name}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.2rem 0.4rem', textDecoration: 'none' }}
                            title={f.name}
                          >
                            <FileText size={12} color={C.walnutSoft} />
                            <span style={{ fontSize: '0.64rem', color: C.walnutSoft, maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                          </a>
                        )}
                        <button onClick={() => onRemoveFileFromJob(r.id, f.id)} style={{ ...ghostBtn, padding: 0 }} title="Remove file">
                          <X size={11} color={C.walnutSoft} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.4rem', fontSize: '0.66rem', fontWeight: 600, color: C.brass, cursor: 'pointer' }}>
                  <Paperclip size={11} />
                  {busyJobId === r.id ? 'adding…' : 'Add files'}
                  <input type="file" multiple onChange={(e) => handleJobFiles(r.id, e)} style={{ display: 'none' }} disabled={busyJobId === r.id} />
                </label>
              </div>
              <button onClick={() => onCycle(r.id)} style={{ ...pillBtn(stageColor[r.stage]), fontSize: '0.68rem', flexShrink: 0 }}>{repairStageLabel(r.stage)}</button>
              <button onClick={() => onRemove(r.id)} style={ghostBtn}><X size={13} color={C.walnutSoft} /></button>
            </div>
          );
        })}
        {items.length === 0 && <EmptyNote text="No repair jobs queued." />}
        {items.length > 0 && visible.length === 0 && <EmptyNote text="No matches." />}
      </div>
    </div>
  );
}

function MurbahPanel({
  items, onCycle, onNote, stageLabel,
  onDate, onMoney, onSync, syncBusy, syncMsg,
  calendarEvents, eventsLoading, onRefreshEvents,
}) {
  const stageColor = { idea: C.walnutSoft, enquired: C.gold, booked: C.sage, active: C.alert };
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const visible = q ? items.filter((m) => m.title.toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q)) : items;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {items.length > 0 && (
        <MicField placeholder="Search opportunity or notes…" value={search} onChange={setSearch} style={{ ...miniInput, width: '100%' }} />
      )}
      {visible.map((m) => {
        const dateValue = (m.booking_date || '').slice(0, 10);
        return (
          <div key={m.id} style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0.6rem 0.7rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{m.title}</span>
              <button onClick={() => onCycle(m.id)} style={{ ...pillBtn(stageColor[m.stage]), fontSize: '0.66rem', flexShrink: 0 }}>{stageLabel(m.stage)}</button>
            </div>
            <div style={{ marginTop: '0.4rem' }}>
              <MicTextarea
                value={m.note || ''}
                onChange={(note) => onNote(m.id, note)}
                placeholder="Notes…"
                rows={2}
                style={miniInput}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.4rem', flexWrap: 'wrap' }}>
              <input
                type="date"
                value={dateValue}
                onChange={(e) => onDate(m.id, e.target.value)}
                style={{ ...miniInput, flex: '1 1 140px' }}
              />
              {/* The other end of the range. The old deck's ledger tracked start AND end; only the
                  start reaches Calendar, which stays an all-day event on booking_date. */}
              <input
                type="date"
                value={(m.end_date || '').slice(0, 10)}
                onChange={(e) => onMoney(m.id, { end_date: e.target.value })}
                title="End date (optional)"
                style={{ ...miniInput, flex: '1 1 140px' }}
              />
              <button
                onClick={() => onSync(m.id)}
                disabled={!dateValue || syncBusy === m.id}
                style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.3rem', opacity: !dateValue ? 0.5 : syncBusy === m.id ? 0.7 : 1 }}
                title={dateValue ? 'Push this date to Google Calendar' : 'Set a date first'}
              >
                {syncBusy === m.id ? <Loader2 size={12} className="animate-spin" /> : <Calendar size={12} />}
                {m.calendar_event_id ? 'Re-sync' : 'Sync'}
              </button>
            </div>

            {/* The money half. In the old deck this re-pushed the whole booking — payment flags
                included — into the Calendar event on every edit; here the flags live with the
                booking and the Sync button above carries them across. */}
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.4rem', flexWrap: 'wrap' }}>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={m.price ?? ''}
                onChange={(e) => onMoney(m.id, { price: e.target.value })}
                placeholder="Price"
                style={{ ...miniInput, flex: '1 1 90px' }}
              />
              <button onClick={() => onMoney(m.id, { deposit_paid: !m.deposit_paid })} style={{ ...pillBtn(m.deposit_paid ? C.sage : C.walnutSoft), fontSize: '0.68rem', flexShrink: 0 }}>
                {m.deposit_paid ? 'Deposit paid' : 'No deposit'}
              </button>
              <button onClick={() => onMoney(m.id, { paid: !m.paid })} style={{ ...pillBtn(m.paid ? C.sage : C.oxblood), fontSize: '0.68rem', flexShrink: 0 }}>
                {m.paid ? 'Paid in full' : 'Unpaid'}
              </button>
            </div>
          </div>
        );
      })}
      {items.length === 0 && <EmptyNote text="No opportunities yet." />}

      {syncMsg && <p style={{ margin: '0.2rem 0 0', fontSize: '0.72rem', color: C.walnutSoft }}>{syncMsg}</p>}

      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: '0.3rem', paddingTop: '0.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Upcoming bookings</span>
          <button onClick={onRefreshEvents} disabled={eventsLoading} style={{ ...ghostBtn, fontSize: '0.7rem', color: C.brass, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            {eventsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        </div>
        {calendarEvents.length === 0 ? (
          <EmptyNote text="Nothing synced to Calendar yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {calendarEvents.map((e) => (
              <div key={e.id} style={{ ...rowBox }}>
                <Calendar size={13} color={C.brass} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: '0.78rem' }}>{e.summary}</span>
                <span style={{ fontSize: '0.68rem', color: C.walnutSoft, flexShrink: 0 }}>{e.start}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SignalChainWidget() {
  const {
    openStream, setOpenStream, consignment, repairs, murbahOpps,
    cForm, setCForm, addConsignment, toggleSold, updateConsignment, removeConsignment,
    rForm, setRForm, addRepair, updateRepair, cycleRepairStage, removeRepair, addFilesToJob, removeFileFromJob,
    cycleMurbahStage, updateMurbahNote, updateMurbahDate, updateMurbahMoney, syncMurbahCalendar, murbahSyncBusy, murbahSyncMsg,
    murbahCalendarEvents, murbahEventsLoading, loadMurbahCalendarEvents,
    setLightboxImg, askToDelete, uploadFile, addPending, feeTiers,
  } = useCommandDeck();

  return (
    <Card title="Signal chain" sub="Tap a pedal to open it up.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        {STREAM_ORDER.map((id) => {
          const s = STREAM_META[id];
          const Icon = s.icon;
          const st = STATUS_STYLE[s.status];
          const open = openStream === id;
          return (
            <div key={id}>
              <button
                onClick={() => setOpenStream(open ? null : id)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'flex-start', gap: '0.7rem', background: C.paper,
                  border: `1px solid ${C.line}`, borderLeft: `5px solid ${st.color}`, borderRadius: open ? '10px 10px 0 0' : 10,
                  padding: '0.65rem 0.75rem', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ width: 34, height: 34, borderRadius: 8, background: C.walnut, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon size={17} color={C.brassLight} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{s.label}</span>
                    <span style={{ fontSize: '0.62rem', letterSpacing: '0.06em', color: st.color, fontWeight: 600 }}>{st.label}</span>
                  </div>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: C.walnutSoft }}>{s.desc}</p>
                </div>
                {open ? <ChevronDown size={16} color={C.walnutSoft} /> : <ChevronRight size={16} color={C.walnutSoft} />}
              </button>

              {open && (
                <div style={{ border: `1px solid ${C.line}`, borderTop: 'none', borderRadius: '0 0 10px 10px', padding: '0.8rem 0.75rem', background: C.tweedDark }}>
                  {id === 'consignment' && (
                    <ConsignmentPanel items={consignment} form={cForm} setForm={setCForm} onAdd={addConsignment} onToggle={toggleSold} onUpdate={updateConsignment} onRemove={(id) => askToDelete(() => removeConsignment(id))} uploadFile={uploadFile} adding={!!addPending.consignment} feeTiers={feeTiers} />
                  )}
                  {id === 'repairs' && (
                    <RepairsPanel
                      items={repairs} form={rForm} setForm={setRForm} onAdd={addRepair} onUpdate={updateRepair} onCycle={cycleRepairStage}
                      onRemove={(id) => askToDelete(() => removeRepair(id))} onAddFilesToJob={addFilesToJob}
                      onRemoveFileFromJob={(jobId, fileId) => askToDelete(() => removeFileFromJob(jobId, fileId))}
                      onOpenImage={setLightboxImg} uploadFile={uploadFile} adding={!!addPending.repair}
                    />
                  )}
                  {id === 'retail' && (
                    <div>
                      <p style={{ fontSize: '0.8rem', color: C.walnutSoft, margin: '0 0 0.7rem', lineHeight: 1.5 }}>
                        Listings themselves are managed on the website — the shop's plugin has its own widget for that, reached through wp-admin.
                      </p>
                      <a
                        href={WP_ADMIN_URL}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.65rem',
                          borderRadius: 10, background: C.gold, color: C.walnut, fontWeight: 600, fontSize: '0.84rem', textDecoration: 'none',
                        }}
                      >
                        <ExternalLink size={16} /> Open wp-admin
                      </a>
                    </div>
                  )}
                  {id === 'murbah' && (
                    <MurbahPanel
                      items={murbahOpps} onCycle={cycleMurbahStage} onNote={updateMurbahNote} stageLabel={murbahStageLabel}
                      onDate={updateMurbahDate} onMoney={updateMurbahMoney} onSync={syncMurbahCalendar} syncBusy={murbahSyncBusy} syncMsg={murbahSyncMsg}
                      calendarEvents={murbahCalendarEvents} eventsLoading={murbahEventsLoading} onRefreshEvents={loadMurbahCalendarEvents}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
