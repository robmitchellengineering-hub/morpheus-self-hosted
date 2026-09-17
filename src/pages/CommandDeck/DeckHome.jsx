import { useState } from 'react';
import {
  Plus, X, Check, ChevronDown, ChevronRight, ListChecks, Compass, Lightbulb,
  MessageSquare, Paperclip, FileText, ExternalLink, RefreshCw, Reply, Send, Loader2, Mic, Mail, Calendar, Sparkles,
} from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import {
  C, ENERGY, STREAM_META, STREAM_ORDER, STATUS_STYLE, LIFE_STREAMS_META, CHANNELS,
  WP_ADMIN_URL, murbahStageLabel, repairStageLabel, inboxStageLabel,
  isYou, smsHref, emailHref, commissionFor, money,
} from './deckConstants';
import {
  Card, RhythmRow, IconButton, EmptyNote, inputStyle, miniInput, rowBox, ghostBtn,
  pillBtn, checkBtn, chipBtn,
} from './DeckUI';

// The "Deck" home tab — everything from the original single-file
// CommandDeck.jsx except the Jarvis card, which is now its own tab
// (DeckJarvis.jsx).
export default function DeckHome() {
  const {
    dump, dumpInput, setDumpInput, quickFileMsg, detectOwner, addDump, removeDump, promoteDump,
    tasks, taskInput, setTaskInput, taskOwner, setTaskOwner, taskEnergy, setTaskEnergy, openOwner, setOpenOwner,
    addTask, toggleTask, removeTask,
    people, personForm, setPersonForm, managePeople, setManagePeople, addPerson, updatePersonPhone, updatePersonEmail, updatePersonName, removePerson,
    energy, energyHistory, focusTask, setEnergyLevel, saveFocus,
    openStream, setOpenStream, consignment, repairs, murbahOpps,
    cForm, setCForm, addConsignment, toggleSold, removeConsignment,
    rForm, setRForm, addRepair, cycleRepairStage, removeRepair, addFilesToJob, removeFileFromJob,
    cycleMurbahStage, updateMurbahNote, updateMurbahDate, syncMurbahCalendar, murbahSyncBusy, murbahSyncMsg,
    murbahCalendarEvents, murbahEventsLoading, loadMurbahCalendarEvents,
    strategy, knowledge, addStrategy, removeStrategy, addKnowledge, removeKnowledge,
    inbox, iForm, setIForm, addInbox, cycleInboxStage, removeInbox,
    gmailSyncing, gmailSyncMsg, syncGmailInbox,
    replyDraftFor, replyDraftText, setReplyDraftText, replyBusy, startReplyDraft, cancelReplyDraft, sendReplyDraft,
    lifeStreams, toggleLifeStatus, addLifeNote, removeLifeNote,
    setLightboxImg, askToDelete,
    backupText, backupBusy, backupMsg, runExport, copyBackup, downloadBackup,
    uploadFile,
    widgetInstances,
    calendarEvents, calendarLoading, calendarForm, setCalendarForm, calendarBusy, loadCalendarEvents, addCalendarEvent,
    synthesisBusy, synthesisErr, runJarvisSynthesis, lastSynthesis,
  } = useCommandDeck();

  const energyInfo = ENERGY.find((e) => e.id === energy);

  const { listening: dumpListening, start: startDumpMic, stop: stopDumpMic, supported: dumpMicSupported } = useSpeechRecognition({
    onResult: (transcript) => setDumpInput((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript)),
  });

  // 2026-09-17 (Rob: "I need all of those fields that the deck creates
  // collapsible and searchable") — one search term per searchable section,
  // filtering each section's own list before it renders. Plain
  // case-insensitive substring match on whatever text field that list uses.
  const [dumpSearch, setDumpSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [strategySearch, setStrategySearch] = useState('');
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [inboxSearch, setInboxSearch] = useState('');
  const matches = (text, term) => !term.trim() || (text || '').toLowerCase().includes(term.trim().toLowerCase());

  const visibleDump = dump.filter((d) => matches(d.text, dumpSearch));
  const visibleStrategy = strategy.filter((s) => matches(s.text, strategySearch));
  const visibleKnowledge = knowledge.filter((k) => matches(k.text, knowledgeSearch));
  const visibleInbox = inbox.filter((i) => matches(`${i.from_name} ${i.message}`, inboxSearch));

  // 2026-09-17 (Rob: "I should be able to add custom widgets there too, I
  // just don't want to lose the tools I already have") — each top-level
  // <Card> below registers its own JSX under its widget key instead of
  // rendering directly in place, so this page can show/hide/reorder
  // sections per the account's own DeckWidgetInstance rows (widgetInstances,
  // from context) without moving any of the section JSX itself. See
  // deckWidgets.js for the registry of valid keys.
  const widgetNodes = {};
  const registerWidget = (key, node) => { widgetNodes[key] = node; return null; };
  const orderedWidgets = [...widgetInstances]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((w) => w.enabled);

  return (
    <>
      {registerWidget('jarvis_suggestions', (
      <Card title="Jarvis's suggestions" sub="Everything you've got, brought together — press for what you're missing.">
        <button
          onClick={runJarvisSynthesis}
          disabled={synthesisBusy}
          style={{ ...pillBtn(C.walnut), width: '100%', padding: '0.65rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', opacity: synthesisBusy ? 0.7 : 1 }}
        >
          {synthesisBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {synthesisBusy ? 'Connecting the dots…' : lastSynthesis ? 'Get new suggestions' : 'Get suggestions'}
        </button>
        {synthesisErr && <p style={{ margin: '0.6rem 0 0', fontSize: '0.78rem', color: C.alert }}>Couldn't reach Jarvis that time — give it another go.</p>}
        {lastSynthesis ? (
          <div style={{ marginTop: '0.75rem' }}>
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.68rem', color: C.walnutSoft, letterSpacing: '0.04em' }}>
              {lastSynthesis.created_date ? new Date(lastSynthesis.created_date).toLocaleString() : 'just now'}
            </p>
            <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.6, color: C.ink, whiteSpace: 'pre-wrap' }}>{lastSynthesis.content}</p>
          </div>
        ) : !synthesisBusy && (
          <EmptyNote>He'll pull together everything on your Deck — tasks, notes, the energy log, the lot — and tell you what's worth acting on.</EmptyNote>
        )}
      </Card>
      ))}

      {registerWidget('brain_dump', (
      <Card
        title="Brain dump"
        sub="Whatever's rattling around — get it out. Mention a name and it's filed straight to them; otherwise Jarvis files it where it belongs."
        search={dump.length > 0 ? { value: dumpSearch, onChange: setDumpSearch, placeholder: 'Search unsorted dump…' } : undefined}
      >
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={dumpInput}
            onChange={(e) => setDumpInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addDump()}
            placeholder="Type it. Don't think."
            style={inputStyle}
          />
          {dumpMicSupported && (
            <IconButton
              onClick={() => (dumpListening ? stopDumpMic() : startDumpMic())}
              color={dumpListening ? C.alert : C.walnutSoft}
            >
              <Mic size={18} color={C.paper} />
            </IconButton>
          )}
          <IconButton onClick={addDump} color={C.oxblood}><Plus size={18} color={C.paper} /></IconButton>
        </div>
        {dumpInput.trim() && detectOwner(dumpInput) && (
          <p style={{ fontSize: '0.7rem', fontWeight: 600, color: detectOwner(dumpInput)?.color, marginTop: '0.4rem', marginBottom: 0 }}>
            → will file straight to {detectOwner(dumpInput)?.name}'s tasks
          </p>
        )}
        {quickFileMsg && (
          <p style={{ fontSize: '0.75rem', fontWeight: 600, color: C.sage, marginTop: '0.5rem', marginBottom: 0 }}>✓ {quickFileMsg}</p>
        )}
        {dump.length > 0 && (
          <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {visibleDump.length === 0 && <EmptyNote text="No matches." />}
            {visibleDump.map((item) => (
              <div key={item.id} style={{ ...rowBox, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ flex: '1 1 100%', fontSize: '0.88rem', marginBottom: '0.3rem' }}>{item.text}</span>
                <button onClick={() => promoteDump(item, 'task')} style={{ ...pillBtn(C.sage), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <ListChecks size={12} /> Task
                </button>
                <button onClick={() => promoteDump(item, 'strategy')} style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <Compass size={12} /> Strategy
                </button>
                <button onClick={() => promoteDump(item, 'knowledge')} style={{ ...pillBtn(C.walnutSoft), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <Lightbulb size={12} /> Idea
                </button>
                <button onClick={() => askToDelete(() => removeDump(item.id))} style={ghostBtn}><X size={14} color={C.walnutSoft} /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
      ))}

      {registerWidget('today_charge', (
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
      ))}

      {registerWidget('today_one_thing', (
      <Card title="Today's one thing" sub="Not the list. Just this." style={{ background: C.walnut, color: C.paper, border: `1.5px solid ${C.gold}` }} titleColor={C.brassLight} subColor="rgba(246,240,223,0.65)">
        <input
          value={focusTask}
          onChange={(e) => saveFocus(e.target.value)}
          placeholder="What's the single most important thing?"
          style={{ ...inputStyle, background: 'rgba(246,240,223,0.08)', border: '1px solid rgba(246,240,223,0.25)', color: C.paper }}
        />
      </Card>
      ))}

      {registerWidget('inbox', (
      <Card
        title="Inbox"
        sub="Every inquiry, one place — email, the website, whatever comes in. Log it as it comes."
        search={inbox.length > 0 ? { value: inboxSearch, onChange: setInboxSearch, placeholder: 'Search inbox…' } : undefined}
      >
        <InboxPanel
          items={visibleInbox} form={iForm} setForm={setIForm} onAdd={addInbox} onCycle={cycleInboxStage} onRemove={(id) => askToDelete(() => removeInbox(id))}
          gmailSyncing={gmailSyncing} gmailSyncMsg={gmailSyncMsg} onSyncGmail={syncGmailInbox}
          replyDraftFor={replyDraftFor} replyDraftText={replyDraftText} setReplyDraftText={setReplyDraftText}
          replyBusy={replyBusy} onStartReply={startReplyDraft} onCancelReply={cancelReplyDraft} onSendReply={sendReplyDraft}
        />
      </Card>
      ))}

      {registerWidget('calendar', (
      <Card title="Calendar" sub="Your real Google Calendar, right here.">
        <CalendarWidget
          events={calendarEvents} loading={calendarLoading} form={calendarForm} setForm={setCalendarForm}
          busy={calendarBusy} onRefresh={loadCalendarEvents} onAdd={addCalendarEvent}
        />
      </Card>
      ))}

      {registerWidget('signal_chain', (
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
                      <ConsignmentPanel items={consignment} form={cForm} setForm={setCForm} onAdd={addConsignment} onToggle={toggleSold} onRemove={(id) => askToDelete(() => removeConsignment(id))} uploadFile={uploadFile} />
                    )}
                    {id === 'repairs' && (
                      <RepairsPanel
                        items={repairs} form={rForm} setForm={setRForm} onAdd={addRepair} onCycle={cycleRepairStage}
                        onRemove={(id) => askToDelete(() => removeRepair(id))} onAddFilesToJob={addFilesToJob}
                        onRemoveFileFromJob={(jobId, fileId) => askToDelete(() => removeFileFromJob(jobId, fileId))}
                        onOpenImage={setLightboxImg} uploadFile={uploadFile}
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
                        onDate={updateMurbahDate} onSync={syncMurbahCalendar} syncBusy={murbahSyncBusy} syncMsg={murbahSyncMsg}
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
      ))}

      {registerWidget('life_streams', (
      <Card title="Life streams" sub="The rest of your life, tracked alongside the shop. Tap a status to flag it.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {LIFE_STREAMS_META.map((s) => (
            <LifeStreamRow
              key={s.id}
              meta={s}
              data={lifeStreams[s.id] || { status: 'on', notes: [] }}
              onToggleStatus={() => toggleLifeStatus(s.id)}
              onAddNote={(text) => addLifeNote(s.id, text)}
              onRemoveNote={(noteId) => askToDelete(() => removeLifeNote(s.id, noteId))}
            />
          ))}
        </div>
      </Card>
      ))}

      {registerWidget('strategy', (
      <Card
        title="Strategy"
        sub="The long game — where you're steering this, not just running it."
        search={strategy.length > 0 ? { value: strategySearch, onChange: setStrategySearch, placeholder: 'Search strategy notes…' } : undefined}
      >
        <StreamList items={visibleStrategy} onAdd={addStrategy} onRemove={(id) => askToDelete(() => removeStrategy(id))} placeholder="Add a strategic idea…" accent={C.brass} icon={Compass} empty={strategySearch ? 'No matches.' : 'Nothing filed yet — send items here from the brain dump.'} />
      </Card>
      ))}

      {registerWidget('knowledge', (
      <Card
        title="Knowledge & ideas"
        sub="Research, recipes, rabbit holes — whatever might be useful one day."
        search={knowledge.length > 0 ? { value: knowledgeSearch, onChange: setKnowledgeSearch, placeholder: 'Search knowledge & ideas…' } : undefined}
      >
        <StreamList items={visibleKnowledge} onAdd={addKnowledge} onRemove={(id) => askToDelete(() => removeKnowledge(id))} placeholder="Add an idea, link, or thought…" accent={C.walnutSoft} icon={Lightbulb} empty={knowledgeSearch ? 'No matches.' : 'Nothing filed yet — send items here from the brain dump.'} />
      </Card>
      ))}

      {registerWidget('tasks', (
      <Card
        title="Task board"
        sub="Sorted by who owns it — not just you."
        search={tasks.length > 0 ? { value: taskSearch, onChange: setTaskSearch, placeholder: 'Search tasks…' } : undefined}
      >
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTask()}
            placeholder="Add a task…"
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => setTaskOwner(p.id)}
              style={{
                padding: '0.35rem 0.7rem', borderRadius: 999, fontSize: '0.75rem', fontWeight: 600,
                border: `1.5px solid ${taskOwner === p.id ? p.color : C.line}`,
                background: taskOwner === p.id ? p.color : 'transparent',
                color: taskOwner === p.id ? C.paper : C.walnutSoft, cursor: 'pointer',
              }}
            >
              {p.name}
            </button>
          ))}
          <button
            onClick={() => setManagePeople(true)}
            style={{
              width: 30, height: 30, borderRadius: 999, border: `1.5px dashed ${C.brass}`, background: 'transparent',
              color: C.brass, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
            title="Add a person"
          >
            <Plus size={15} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '0.68rem', color: C.walnutSoft, opacity: 0.75 }}>Fits:</span>
          {ENERGY.map((e) => (
            <button
              key={e.id}
              onClick={() => setTaskEnergy(taskEnergy === e.id ? 'any' : e.id)}
              style={{
                padding: '0.3rem 0.6rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 600,
                border: `1.5px solid ${taskEnergy === e.id ? C.gold : C.line}`,
                background: taskEnergy === e.id ? C.gold : 'transparent',
                color: taskEnergy === e.id ? C.walnut : C.walnutSoft, cursor: 'pointer',
              }}
            >
              {e.label}
            </button>
          ))}
          <button onClick={addTask} style={{ ...pillBtn(C.brass), marginLeft: 'auto' }}>Add</button>
        </div>

        <button
          onClick={() => setManagePeople((v) => !v)}
          style={{ background: 'transparent', border: 'none', padding: '0.2rem 0', marginBottom: '0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', fontWeight: 600, color: C.walnutSoft }}
        >
          {managePeople ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Manage people
        </button>

        {managePeople && (
          <div style={{ background: C.tweedDark, borderRadius: 10, padding: '0.65rem 0.7rem', marginBottom: '0.8rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.6rem' }}>
              {people.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <input
                    value={p.name}
                    onChange={(e) => updatePersonName(p.id, e.target.value)}
                    placeholder={isYou(p) ? 'Your name' : 'Name'}
                    style={{ ...miniInput, flex: '0 1 90px', fontWeight: 600, color: p.color }}
                  />
                  {isYou(p) && <span style={{ fontSize: '0.62rem', color: C.walnutSoft, flexShrink: 0 }}>(me)</span>}
                  <input placeholder="Phone number" value={p.phone || ''} onChange={(e) => updatePersonPhone(p.id, e.target.value)} style={{ ...miniInput, flex: '1 1 120px' }} />
                  <input placeholder="Email" value={p.email || ''} onChange={(e) => updatePersonEmail(p.id, e.target.value)} style={{ ...miniInput, flex: '1 1 120px' }} />
                  {!isYou(p) && <button onClick={() => askToDelete(() => removePerson(p.id))} style={ghostBtn}><X size={13} color={C.walnutSoft} /></button>}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <input placeholder="New person's name" value={personForm.name} onChange={(e) => setPersonForm({ ...personForm, name: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
              <input placeholder="Phone" value={personForm.phone} onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
              <input placeholder="Email" value={personForm.email} onChange={(e) => setPersonForm({ ...personForm, email: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
              <button onClick={addPerson} style={pillBtn(C.brass)}>Add</button>
            </div>
          </div>
        )}

        {people.map((p) => {
          const ownerTasks = tasks.filter((t) => t.owner_person_id === p.id && matches(t.text, taskSearch));
          // While actively searching, force every owner with a match open so
          // results don't hide behind a collapsed section the search can't see into.
          const open = taskSearch.trim() ? ownerTasks.length > 0 : openOwner === p.id;
          return (
            <div key={p.id} style={{ marginBottom: '0.5rem' }}>
              <button
                onClick={() => setOpenOwner(openOwner === p.id ? null : p.id)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', border: 'none', padding: '0.4rem 0.1rem', cursor: 'pointer' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, fontSize: '0.85rem', color: p.color }}>
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  {p.name}
                  <span style={{ fontSize: '0.7rem', color: C.walnutSoft, fontWeight: 400 }}>({ownerTasks.filter((t) => !t.done).length} open)</span>
                </span>
              </button>
              {open && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', paddingLeft: '1.4rem' }}>
                  {ownerTasks.length === 0 && <span style={{ fontSize: '0.8rem', color: C.walnutSoft, opacity: 0.6 }}>{taskSearch.trim() ? 'No matches.' : 'Nothing here yet.'}</span>}
                  {ownerTasks.map((t) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: '0.45rem 0.6rem', opacity: t.done ? 0.5 : 1 }}>
                      <button onClick={() => toggleTask(t.id)} style={checkBtn(t.done, p.color)}>{t.done && <Check size={12} color={C.paper} />}</button>
                      <span style={{ flex: 1, fontSize: '0.85rem', textDecoration: t.done ? 'line-through' : 'none' }}>{t.text}</span>
                      {t.energy && t.energy !== 'any' && (
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: { low: C.alert, med: C.gold, high: C.sage }[t.energy], flexShrink: 0 }} title={`Fits ${t.energy} energy`} />
                      )}
                      {p.phone && (
                        <a
                          href={smsHref(p.phone, t.text)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: C.sage, color: C.paper, borderRadius: 999, padding: '0.3rem 0.55rem', fontSize: '0.68rem', fontWeight: 600, textDecoration: 'none', flexShrink: 0 }}
                          title={`Send this as a text to ${p.name}`}
                        >
                          <MessageSquare size={12} color={C.paper} /> Text
                        </a>
                      )}
                      {p.email && (
                        <a
                          href={emailHref(p.email, `Task: ${t.text.slice(0, 60)}`, t.text)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: C.brass, color: C.paper, borderRadius: 999, padding: '0.3rem 0.55rem', fontSize: '0.68rem', fontWeight: 600, textDecoration: 'none', flexShrink: 0 }}
                          title={`Email this task to ${p.name}`}
                        >
                          <Mail size={12} color={C.paper} /> Email
                        </a>
                      )}
                      <button onClick={() => askToDelete(() => removeTask(t.id))} style={ghostBtn}><X size={13} color={C.walnutSoft} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Card>
      ))}

      {registerWidget('week_rhythm', (
      <Card title="Week rhythm" sub="30 hrs, shaped around your energy — not against it.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <RhythmRow day="Tue – Sat, 10–4" what="Shop floor: sales, demos, repairs between customers" tone={C.sage} />
          <RhythmRow day="One weekday" what="Derek covers the shop — you get a clear block" tone={C.brass} />
          <RhythmRow day="Evening block" what="Consignment system + listings (low-energy, doable tired)" tone={C.oxblood} />
          <RhythmRow day="When sharp" what="The stuff you're avoiding — bureaucracy, planning, calls" tone={C.walnutSoft} />
        </div>
      </Card>
      ))}

      {registerWidget('backup', (
      <Card title="Backup & export" sub="A real copy of everything on this deck, whenever you want one.">
        <button onClick={runExport} disabled={backupBusy} style={{ ...pillBtn(C.walnutSoft), width: '100%', padding: '0.55rem', fontSize: '0.8rem', opacity: backupBusy ? 0.6 : 1 }}>
          {backupBusy ? 'Working…' : 'Export everything'}
        </button>
        {backupText && (
          <div style={{ marginTop: '0.6rem' }}>
            <textarea readOnly value={backupText} rows={4} style={{ ...miniInput, width: '100%', resize: 'vertical', boxSizing: 'border-box', fontSize: '0.7rem' }} />
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
              <button onClick={copyBackup} style={{ ...pillBtn(C.sage), flex: 1, padding: '0.5rem' }}>Copy</button>
              <button onClick={downloadBackup} style={{ ...pillBtn(C.brass), flex: 1, padding: '0.5rem' }}>Download</button>
            </div>
          </div>
        )}
        {backupMsg && <p style={{ fontSize: '0.75rem', color: C.walnutSoft, marginTop: '0.6rem', marginBottom: 0 }}>{backupMsg}</p>}
      </Card>
      ))}

      {orderedWidgets.map((w) => (
        <div key={w.widget_key}>{widgetNodes[w.widget_key]}</div>
      ))}
    </>
  );
}

// The generic Calendar widget (Rob, 2026-09-17: alongside Inbox, the two
// widgets every account should get by default). Deliberately simple: a
// refresh-on-demand upcoming-events list (same pattern MurbahPanel's own
// "Upcoming bookings" section already uses) plus a quick-add form. Separate
// from Signal Chain's own Murbah↔Calendar sync.
function CalendarWidget({ events, loading, form, setForm, busy, onRefresh, onAdd }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.7rem' }}>
        <input placeholder="Event title…" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} style={{ ...inputStyle, flex: 1 }} />
        <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} style={{ ...miniInput, flex: '0 1 150px' }} />
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
  );
}

// ---- pedal mini-systems -------------------------------------------------
function ConsignmentPanel({ items, form, setForm, onAdd, onToggle, onRemove, uploadFile }) {
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
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

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <input placeholder="Item" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
        <input placeholder="Consignor" value={form.consignor} onChange={(e) => setForm({ ...form, consignor: e.target.value })} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Price $" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} style={{ ...miniInput, flex: '0 1 70px' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
        <label style={{ ...pillBtn(C.walnutSoft), cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
          {form.photo_url ? 'Retake photo' : 'Add photo'}
          <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: 'none' }} />
        </label>
        {busy && <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>uploading…</span>}
        {form.photo_url && !busy && <img src={form.photo_url} alt="preview" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover', border: `1px solid ${C.line}` }} />}
        <button onClick={onAdd} style={{ ...pillBtn(C.oxblood), marginLeft: 'auto' }}>Add</button>
      </div>
      {form.price && (
        <p style={{ fontSize: '0.72rem', color: C.walnutSoft, margin: '0 0 0.5rem' }}>
          At {money(form.price)}: {Number(form.price) > 2000 ? '20%' : '30%'} rate → your cut {money(commissionFor(form.price))}
        </p>
      )}
      {items.length > 0 && (
        <>
          <p style={{ fontSize: '0.75rem', color: C.walnutSoft, margin: '0 0 0.5rem' }}>{unsold.length} unsold · {money(totalValue)} on the floor</p>
          <input placeholder="Search item, consignor, or phone…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...miniInput, width: '100%', marginBottom: '0.5rem' }} />
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
                {i.consignor}{i.phone ? ` · ${i.phone}` : ''} · {money(i.price)} · you get {money(commissionFor(i.price))}
              </div>
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

function RepairsPanel({ items, form, setForm, onAdd, onCycle, onRemove, onAddFilesToJob, onRemoveFileFromJob, onOpenImage, uploadFile }) {
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [busyJobId, setBusyJobId] = useState(null);
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
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <input placeholder="Customer" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={{ ...miniInput, flex: '1 1 90px' }} />
        <input placeholder="Item / job" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <label style={{ ...pillBtn(C.walnutSoft), cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          <Paperclip size={12} /> Add photo
          <input type="file" accept="image/*" capture="environment" multiple onChange={handleFiles} style={{ display: 'none' }} disabled={busy} />
        </label>
        {busy && <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>uploading…</span>}
        <button onClick={onAdd} style={{ ...pillBtn(C.oxblood), marginLeft: 'auto' }}>Add</button>
      </div>

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
        <input placeholder="Search customer, item, or notes…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...miniInput, width: '100%', marginBottom: '0.5rem' }} />
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
  onDate, onSync, syncBusy, syncMsg,
  calendarEvents, eventsLoading, onRefreshEvents,
}) {
  const stageColor = { idea: C.walnutSoft, enquired: C.gold, booked: C.sage, active: C.alert };
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const visible = q ? items.filter((m) => m.title.toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q)) : items;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {items.length > 0 && (
        <input placeholder="Search opportunity or notes…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...miniInput, width: '100%' }} />
      )}
      {visible.map((m) => {
        const dateValue = (m.booking_date || '').slice(0, 10);
        return (
          <div key={m.id} style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0.6rem 0.7rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{m.title}</span>
              <button onClick={() => onCycle(m.id)} style={{ ...pillBtn(stageColor[m.stage]), fontSize: '0.66rem', flexShrink: 0 }}>{stageLabel(m.stage)}</button>
            </div>
            <textarea
              value={m.note || ''}
              onChange={(e) => onNote(m.id, e.target.value)}
              placeholder="Notes…"
              rows={2}
              style={{ ...miniInput, width: '100%', marginTop: '0.4rem', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.4rem', flexWrap: 'wrap' }}>
              <input
                type="date"
                value={dateValue}
                onChange={(e) => onDate(m.id, e.target.value)}
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

function InboxPanel({
  items, form, setForm, onAdd, onCycle, onRemove,
  gmailSyncing, gmailSyncMsg, onSyncGmail,
  replyDraftFor, replyDraftText, setReplyDraftText, replyBusy, onStartReply, onCancelReply, onSendReply,
}) {
  const [filter, setFilter] = useState('all');
  const stageColor = { new: C.alert, replied: C.gold, done: C.sage };
  const channelLabel = (id) => (CHANNELS.find((c) => c.id === id) || {}).label || id;
  const visible = filter === 'all' ? items : items.filter((i) => i.channel === filter);
  const openCount = items.filter((i) => i.stage !== 'done').length;

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} style={{ ...miniInput, flex: '0 1 110px' }}>
          {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input placeholder="From (name)" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.7rem' }}>
        <input
          placeholder="What did they ask / say?"
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          style={{ ...inputStyle, flex: 1 }}
        />
        <IconButton onClick={onAdd} color={C.alert}><Plus size={18} color={C.paper} /></IconButton>
      </div>

      {onSyncGmail && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
          <button
            onClick={onSyncGmail}
            disabled={gmailSyncing}
            style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.35rem', opacity: gmailSyncing ? 0.7 : 1 }}
          >
            {gmailSyncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {gmailSyncing ? 'Syncing…' : 'Sync Gmail'}
          </button>
          {gmailSyncMsg && <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>{gmailSyncMsg}</span>}
        </div>
      )}

      {items.length > 0 && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.65rem' }}>
          <button onClick={() => setFilter('all')} style={chipBtn(filter === 'all', C.walnutSoft)}>All ({openCount} open)</button>
          {CHANNELS.filter((c) => items.some((i) => i.channel === c.id)).map((c) => (
            <button key={c.id} onClick={() => setFilter(c.id)} style={chipBtn(filter === c.id, C.walnutSoft)}>{c.label}</button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {visible.map((i) => {
          const canReply = i.channel === 'gmail' && !!i.from_email && !!onStartReply;
          const drafting = replyDraftFor === i.id;
          return (
            <div key={i.id} style={{ ...rowBox, flexDirection: 'column', alignItems: 'stretch', gap: '0.4rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap' }}>
                {/* minWidth: 0 overrides the flex item's default min-width:auto —
                    without it, a long unbroken line (a URL, a long word) refuses to
                    shrink and forces the row wider than the screen, pushing the
                    stage pill and delete (X) button off-screen on a phone. */}
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.04em', color: C.brass, textTransform: 'uppercase' }}>{channelLabel(i.channel)}</span>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{i.from_name}</span>
                  </div>
                  <div style={{ fontSize: '0.83rem', marginTop: '0.15rem', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{i.message}</div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexShrink: 0, marginLeft: 'auto' }}>
                  <button onClick={() => onCycle(i.id)} style={{ ...pillBtn(stageColor[i.stage]), flexShrink: 0 }}>{inboxStageLabel(i.stage)}</button>
                  <button onClick={() => onRemove(i.id)} style={{ ...ghostBtn, flexShrink: 0 }}><X size={13} color={C.walnutSoft} /></button>
                </div>
              </div>

              {canReply && !drafting && (
                <button
                  onClick={() => onStartReply(i.id)}
                  style={{ ...ghostBtn, alignSelf: 'flex-start', fontSize: '0.72rem', color: C.brass, display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                >
                  <Reply size={12} /> Jarvis, suggest a reply
                </button>
              )}

              {drafting && (
                <div style={{ background: C.tweed, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0.5rem' }}>
                  {replyBusy && !replyDraftText ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: C.walnutSoft, padding: '0.3rem 0' }}>
                      <Loader2 size={13} className="animate-spin" /> Drafting a reply…
                    </div>
                  ) : (
                    <textarea
                      value={replyDraftText}
                      onChange={(e) => setReplyDraftText(e.target.value)}
                      rows={4}
                      style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                    />
                  )}
                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                    <button
                      onClick={onSendReply}
                      disabled={replyBusy || !replyDraftText.trim()}
                      style={{ ...pillBtn(C.sage), display: 'inline-flex', alignItems: 'center', gap: '0.3rem', opacity: replyBusy || !replyDraftText.trim() ? 0.6 : 1 }}
                    >
                      <Send size={12} /> Send
                    </button>
                    <button onClick={onCancelReply} disabled={replyBusy} style={{ ...pillBtn(C.walnutSoft) }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && <EmptyNote text="Nothing logged yet — add an inquiry as it comes in." />}
        {items.length > 0 && visible.length === 0 && <EmptyNote text="Nothing in this channel." />}
      </div>
    </div>
  );
}

function LifeStreamRow({ meta, data, onToggleStatus, onAddNote, onRemoveNote }) {
  const [val, setVal] = useState('');
  const Icon = meta.icon;
  const isOn = data.status === 'on';
  const statusColor = isOn ? C.sage : C.alert;

  const submit = () => {
    if (!val.trim()) return;
    onAddNote(val);
    setVal('');
  };

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderLeft: `4px solid ${statusColor}`, borderRadius: 10, padding: '0.65rem 0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 600, fontSize: '0.87rem' }}>
          <Icon size={15} color={C.brass} /> {meta.label}
        </span>
        <button
          onClick={onToggleStatus}
          style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.04em', padding: '0.25rem 0.55rem', borderRadius: 999, border: 'none', background: statusColor, color: C.paper, cursor: 'pointer', flexShrink: 0 }}
        >
          {isOn ? 'ON' : 'NEEDS WORK'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: data.notes.length > 0 ? '0.5rem' : 0 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Log a note…" style={{ ...miniInput, flex: 1 }} />
        <button onClick={submit} style={{ ...ghostBtn, background: C.tweedDark, borderRadius: 8, padding: '0.4rem' }}><Plus size={14} color={C.walnutSoft} /></button>
      </div>

      {data.notes.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {data.notes.map((n) => (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem' }}>
              <span style={{ flex: 1, color: C.walnutSoft }}>{n.text}</span>
              <button onClick={() => onRemoveNote(n.id)} style={ghostBtn}><X size={12} color={C.walnutSoft} /></button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyNote text="Nothing logged yet." />
      )}
    </div>
  );
}

function StreamList({ items, onAdd, onRemove, placeholder, accent, icon: Icon, empty }) {
  const [val, setVal] = useState('');
  const submit = () => {
    if (!val.trim()) return;
    onAdd(val);
    setVal('');
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.7rem' }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={placeholder} style={{ ...inputStyle, flex: 1 }} />
        <IconButton onClick={submit} color={accent}><Plus size={18} color={C.paper} /></IconButton>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {items.map((i) => (
          <div key={i.id} style={{ ...rowBox, borderLeft: `3px solid ${accent}` }}>
            <Icon size={14} color={accent} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '0.85rem' }}>{i.text}</span>
            <button onClick={() => onRemove(i.id)} style={ghostBtn}><X size={13} color={C.walnutSoft} /></button>
          </div>
        ))}
        {items.length === 0 && <EmptyNote text={empty} />}
      </div>
    </div>
  );
}
