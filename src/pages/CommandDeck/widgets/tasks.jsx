import { useState } from 'react';
import { Plus, ChevronDown, ChevronRight, Check, X, MessageSquare, Mail } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, ENERGY, isYou, smsHref, emailHref } from '../deckConstants';
import { Card, MicField, inputStyle, miniInput, ghostBtn, pillBtn, checkBtn } from '../DeckUI';

export default function TasksWidget() {
  const {
    tasks, taskInput, setTaskInput, taskOwner, setTaskOwner, taskEnergy, setTaskEnergy, openOwner, setOpenOwner,
    addTask, toggleTask, removeTask,
    people, personForm, setPersonForm, managePeople, setManagePeople, addPerson, updatePersonPhone, updatePersonEmail, updatePersonName, removePerson,
    askToDelete,
  } = useCommandDeck();
  const [taskSearch, setTaskSearch] = useState('');
  const matches = (text, term) => !term.trim() || (text || '').toLowerCase().includes(term.trim().toLowerCase());

  return (
    <Card
      title="Task board"
      sub="Sorted by who owns it — not just you."
      search={tasks.length > 0 ? { value: taskSearch, onChange: setTaskSearch, placeholder: 'Search tasks…' } : undefined}
    >
      <div style={{ marginBottom: '0.75rem' }}>
        <MicField
          value={taskInput}
          onChange={setTaskInput}
          onSubmit={addTask}
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
            <input placeholder="New person's name" value={personForm.name} onChange={(e) => setPersonForm({ ...personForm, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addPerson()} style={{ ...miniInput, flex: '1 1 100px' }} />
            <input placeholder="Phone" value={personForm.phone} onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addPerson()} style={{ ...miniInput, flex: '1 1 100px' }} />
            <input placeholder="Email" value={personForm.email} onChange={(e) => setPersonForm({ ...personForm, email: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addPerson()} style={{ ...miniInput, flex: '1 1 100px' }} />
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
  );
}
