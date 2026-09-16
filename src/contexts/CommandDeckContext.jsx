import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DEFAULT_PEOPLE, OWNER_COLOR_CYCLE, LIFE_STREAMS_META, DEFAULT_MURBAH,
  nextMurbahStage, nextRepairStage, nextInboxStage,
  isYou, todayKey, todayISO,
} from '@/pages/CommandDeck/deckConstants';

// All of Command Deck's shared state, data loading, and CRUD handlers —
// lifted out of the old single-file CommandDeck.jsx unchanged, so every tab
// page (DeckHome, DeckJarvis, DeckTools, DeckSettings) can read/mutate the
// same data without each tab reloading it independently.

const CommandDeckContext = createContext(null);

export function useCommandDeck() {
  const ctx = useContext(CommandDeckContext);
  if (!ctx) throw new Error('useCommandDeck must be used within CommandDeckProvider');
  return ctx;
}

export function CommandDeckProvider({ children }) {
  const [loaded, setLoaded] = useState(false);
  const [saveErr, setSaveErr] = useState(false);
  const flagSaveErr = () => {
    setSaveErr(true);
    window.setTimeout(() => setSaveErr(false), 4000);
  };

  const [dump, setDump] = useState([]);
  const [dumpInput, setDumpInput] = useState('');
  const [quickFileMsg, setQuickFileMsg] = useState(null);
  const quickFileTimeout = useRef(null);

  const [tasks, setTasks] = useState([]);
  const [taskInput, setTaskInput] = useState('');
  const [taskOwner, setTaskOwner] = useState('');
  const [taskEnergy, setTaskEnergy] = useState('any');
  const [openOwner, setOpenOwner] = useState(null);

  const [people, setPeople] = useState([]);
  const [personForm, setPersonForm] = useState({ name: '', phone: '' });
  const [managePeople, setManagePeople] = useState(false);

  const [energy, setEnergy] = useState(null);
  const [energyHistory, setEnergyHistory] = useState([]);
  const [focusTask, setFocusTask] = useState('');
  const [focusEntryId, setFocusEntryId] = useState(null);

  const [openStream, setOpenStream] = useState(null);
  const [consignment, setConsignment] = useState([]);
  const [repairs, setRepairs] = useState([]);
  const [murbahOpps, setMurbahOpps] = useState([]);

  const [strategy, setStrategy] = useState([]);
  const [knowledge, setKnowledge] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [iForm, setIForm] = useState({ channel: 'gmail', from: '', message: '' });
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailSyncMsg, setGmailSyncMsg] = useState(null);
  const [replyDraftFor, setReplyDraftFor] = useState(null);
  const [replyDraftText, setReplyDraftText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);

  const [lifeStreams, setLifeStreams] = useState({});
  const [lightboxImg, setLightboxImg] = useState(null);

  const [jarvisMessages, setJarvisMessages] = useState([]);
  const [jarvisInput, setJarvisInput] = useState('');
  const [jarvisSending, setJarvisSending] = useState(false);
  const [jarvisErr, setJarvisErr] = useState(false);

  const [backupText, setBackupText] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState(null);

  const [cForm, setCForm] = useState({ item: '', consignor: '', phone: '', price: '', photo_url: null });
  const [rForm, setRForm] = useState({ customer: '', phone: '', item: '', notes: '', pendingFiles: [] });

  // Debounced saves for fields that fire on every keystroke (phone numbers,
  // today's focus, a Murbah note) so typing doesn't hammer the API.
  const debounceTimers = useRef({});
  const debouncedSave = useCallback((key, fn, delay = 600) => {
    window.clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = window.setTimeout(fn, delay);
  }, []);

  const uploadFile = async (file) => {
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    return file_url;
  };

  // ---- load ------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [
          dumpRows, peopleRows, taskRows, consignRows, repairRows, repairFileRows,
          murbahRows, inboxRows, strategyRows, knowledgeRows, lifeStreamRows,
          lifeStreamNoteRows, energyRows, focusRows, jarvisRows,
        ] = await Promise.all([
          base44.entities.DeckDumpItem.list(),
          base44.entities.DeckPerson.list('created_date'),
          base44.entities.DeckTask.list(),
          base44.entities.DeckConsignmentItem.list(),
          base44.entities.DeckRepairJob.list(),
          base44.entities.DeckRepairFile.list(),
          base44.entities.DeckMurbahOpportunity.list(),
          base44.entities.DeckInboxItem.list(),
          base44.entities.DeckStrategyNote.list(),
          base44.entities.DeckKnowledgeNote.list(),
          base44.entities.DeckLifeStream.list(),
          base44.entities.DeckLifeStreamNote.list(),
          base44.entities.DeckEnergyLogEntry.list('-date', 30),
          base44.entities.DeckFocusEntry.list('-date', 10),
          base44.entities.DeckJarvisMessage.list('created_date', 50),
        ]);

        let peopleList = peopleRows;
        if (peopleList.length === 0) {
          peopleList = [];
          for (const def of DEFAULT_PEOPLE) {
            peopleList.push(await base44.entities.DeckPerson.create(def));
          }
        }

        let lifeStreamRowsFinal = lifeStreamRows;
        if (lifeStreamRowsFinal.length === 0) {
          lifeStreamRowsFinal = [];
          for (const s of LIFE_STREAMS_META) {
            lifeStreamRowsFinal.push(await base44.entities.DeckLifeStream.create({ stream_key: s.id, status: 'on' }));
          }
        }

        let murbahList = murbahRows;
        if (murbahList.length === 0) {
          murbahList = [];
          for (const def of DEFAULT_MURBAH) {
            murbahList.push(await base44.entities.DeckMurbahOpportunity.create(def));
          }
        }

        setDump(dumpRows);
        setPeople(peopleList);
        setTasks(taskRows);
        setConsignment(consignRows);
        setRepairs(repairRows.map((r) => ({ ...r, files: repairFileRows.filter((f) => f.repair_job_id === r.id) })));
        setMurbahOpps(murbahList);
        setInbox(inboxRows);
        setStrategy(strategyRows);
        setKnowledge(knowledgeRows);
        setLifeStreams(Object.fromEntries(lifeStreamRowsFinal.map((ls) => [
          ls.stream_key,
          { ...ls, notes: lifeStreamNoteRows.filter((n) => n.life_stream_id === ls.id) },
        ])));
        setEnergyHistory(energyRows);
        setJarvisMessages(jarvisRows);

        const today = todayKey();
        const todayEnergy = energyRows.find((e) => (e.date || '').slice(0, 10) === today);
        if (todayEnergy) setEnergy(todayEnergy.level);
        const todayFocus = focusRows.find((f) => (f.date || '').slice(0, 10) === today);
        if (todayFocus) {
          setFocusTask(todayFocus.text);
          setFocusEntryId(todayFocus.id);
        }

        const you = peopleList.find(isYou) || peopleList[0];
        setTaskOwner(you?.id || '');
        setOpenOwner(you?.id || null);
      } catch (e) {
        console.error('Failed to load Command Deck data', e);
        flagSaveErr();
      }
      setLoaded(true);
    })();
  }, []);

  // ---- brain dump --------------------------------------------------------
  const detectOwner = (text) => {
    const lower = text.toLowerCase();
    for (const p of people) {
      if (isYou(p)) continue;
      const nameLower = p.name.toLowerCase();
      const re = new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(lower)) return p;
    }
    return null;
  };

  const addDump = async () => {
    if (!dumpInput.trim()) return;
    const text = dumpInput.trim();
    const owner = detectOwner(text);
    try {
      if (owner) {
        const created = await base44.entities.DeckTask.create({ text, owner_person_id: owner.id, energy: 'any', done: false });
        setTasks((prev) => [created, ...prev]);
        setQuickFileMsg(`Filed straight to ${owner.name}'s tasks`);
        window.clearTimeout(quickFileTimeout.current);
        quickFileTimeout.current = window.setTimeout(() => setQuickFileMsg(null), 2600);
      } else {
        const created = await base44.entities.DeckDumpItem.create({ text });
        setDump((prev) => [created, ...prev]);
      }
      setDumpInput('');
    } catch { flagSaveErr(); }
  };
  const removeDump = async (id) => {
    setDump((prev) => prev.filter((d) => d.id !== id));
    try { await base44.entities.DeckDumpItem.delete(id); } catch { flagSaveErr(); }
  };
  const promoteDump = async (item, dest) => {
    try {
      if (dest === 'task') {
        const owner = detectOwner(item.text) || people.find(isYou);
        const created = await base44.entities.DeckTask.create({ text: item.text, owner_person_id: owner?.id, energy: 'any', done: false });
        setTasks((prev) => [created, ...prev]);
      } else if (dest === 'strategy') {
        const created = await base44.entities.DeckStrategyNote.create({ text: item.text });
        setStrategy((prev) => [created, ...prev]);
      } else if (dest === 'knowledge') {
        const created = await base44.entities.DeckKnowledgeNote.create({ text: item.text });
        setKnowledge((prev) => [created, ...prev]);
      }
      await base44.entities.DeckDumpItem.delete(item.id);
      setDump((prev) => prev.filter((d) => d.id !== item.id));
    } catch { flagSaveErr(); }
  };

  // ---- tasks ---------------------------------------------------------
  const addTask = async () => {
    if (!taskInput.trim()) return;
    try {
      const created = await base44.entities.DeckTask.create({ text: taskInput.trim(), owner_person_id: taskOwner, energy: taskEnergy, done: false });
      setTasks((prev) => [created, ...prev]);
      setTaskInput('');
    } catch { flagSaveErr(); }
  };
  const toggleTask = async (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
    try { await base44.entities.DeckTask.update(id, { done: !t.done }); } catch { flagSaveErr(); }
  };
  const removeTask = async (id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try { await base44.entities.DeckTask.delete(id); } catch { flagSaveErr(); }
  };

  // ---- people ----------------------------------------------------------
  const addPerson = async () => {
    if (!personForm.name.trim()) return;
    try {
      const color = OWNER_COLOR_CYCLE[people.length % OWNER_COLOR_CYCLE.length];
      const created = await base44.entities.DeckPerson.create({ name: personForm.name.trim(), phone: personForm.phone.trim(), color });
      setPeople((prev) => [...prev, created]);
      setPersonForm({ name: '', phone: '' });
    } catch { flagSaveErr(); }
  };
  const updatePersonPhone = (id, phone) => {
    setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, phone } : p)));
    debouncedSave(`person-${id}`, async () => {
      try { await base44.entities.DeckPerson.update(id, { phone }); } catch { flagSaveErr(); }
    });
  };
  const removePerson = async (id) => {
    setPeople((prev) => prev.filter((p) => p.id !== id));
    if (taskOwner === id) setTaskOwner(people.find(isYou)?.id || '');
    try { await base44.entities.DeckPerson.delete(id); } catch { flagSaveErr(); }
  };

  // ---- energy / focus ----------------------------------------------------
  const setEnergyLevel = async (id) => {
    setEnergy(id);
    const today = todayKey();
    const existing = energyHistory.find((h) => (h.date || '').slice(0, 10) === today);
    try {
      if (existing) {
        const saved = await base44.entities.DeckEnergyLogEntry.update(existing.id, { level: id });
        setEnergyHistory((prev) => prev.map((h) => (h.id === existing.id ? saved : h)));
      } else {
        const saved = await base44.entities.DeckEnergyLogEntry.create({ date: todayISO(), level: id });
        setEnergyHistory((prev) => [saved, ...prev].slice(0, 30));
      }
    } catch { flagSaveErr(); }
  };
  const saveFocus = (val) => {
    setFocusTask(val);
    debouncedSave('focus', async () => {
      try {
        if (focusEntryId) {
          await base44.entities.DeckFocusEntry.update(focusEntryId, { text: val });
        } else {
          const created = await base44.entities.DeckFocusEntry.create({ date: todayISO(), text: val });
          setFocusEntryId(created.id);
        }
      } catch { flagSaveErr(); }
    });
  };

  // ---- consignment -------------------------------------------------------
  const addConsignment = async () => {
    if (!cForm.item.trim()) return;
    try {
      const created = await base44.entities.DeckConsignmentItem.create({
        item: cForm.item.trim(),
        consignor: cForm.consignor.trim() || '—',
        phone: cForm.phone.trim(),
        price: Number(cForm.price) || 0,
        date_in: new Date().toISOString(),
        sold: false,
        photo_url: cForm.photo_url || null,
      });
      setConsignment((prev) => [created, ...prev]);
      setCForm({ item: '', consignor: '', phone: '', price: '', photo_url: null });
    } catch { flagSaveErr(); }
  };
  const toggleSold = async (id) => {
    const c = consignment.find((x) => x.id === id);
    if (!c) return;
    setConsignment((prev) => prev.map((x) => (x.id === id ? { ...x, sold: !x.sold } : x)));
    try { await base44.entities.DeckConsignmentItem.update(id, { sold: !c.sold }); } catch { flagSaveErr(); }
  };
  const removeConsignment = async (id) => {
    setConsignment((prev) => prev.filter((c) => c.id !== id));
    try { await base44.entities.DeckConsignmentItem.delete(id); } catch { flagSaveErr(); }
  };

  // ---- repairs -------------------------------------------------------
  const addRepair = async () => {
    if (!rForm.item.trim()) return;
    try {
      const created = await base44.entities.DeckRepairJob.create({
        customer: rForm.customer.trim() || '—',
        phone: rForm.phone.trim(),
        item: rForm.item.trim(),
        notes: rForm.notes.trim(),
        stage: 'waiting',
      });
      let files = [];
      if (rForm.pendingFiles?.length) {
        files = await Promise.all(rForm.pendingFiles.map((pf) => base44.entities.DeckRepairFile.create({
          repair_job_id: created.id, name: pf.name, file_url: pf.file_url, is_image: pf.is_image,
        })));
      }
      setRepairs((prev) => [{ ...created, files }, ...prev]);
      setRForm({ customer: '', phone: '', item: '', notes: '', pendingFiles: [] });
    } catch { flagSaveErr(); }
  };
  const cycleRepairStage = async (id) => {
    const r = repairs.find((x) => x.id === id);
    if (!r) return;
    const next = nextRepairStage(r.stage);
    setRepairs((prev) => prev.map((x) => (x.id === id ? { ...x, stage: next } : x)));
    try { await base44.entities.DeckRepairJob.update(id, { stage: next }); } catch { flagSaveErr(); }
  };
  const removeRepair = async (id) => {
    setRepairs((prev) => prev.filter((r) => r.id !== id));
    try { await base44.entities.DeckRepairJob.delete(id); } catch { flagSaveErr(); }
  };
  const addFilesToJob = async (jobId, uploadedFiles) => {
    try {
      const created = await Promise.all(uploadedFiles.map((f) => base44.entities.DeckRepairFile.create({
        repair_job_id: jobId, name: f.name, file_url: f.file_url, is_image: f.is_image,
      })));
      setRepairs((prev) => prev.map((r) => (r.id === jobId ? { ...r, files: [...(r.files || []), ...created] } : r)));
    } catch { flagSaveErr(); }
  };
  const removeFileFromJob = async (jobId, fileId) => {
    setRepairs((prev) => prev.map((r) => (r.id === jobId ? { ...r, files: (r.files || []).filter((f) => f.id !== fileId) } : r)));
    try { await base44.entities.DeckRepairFile.delete(fileId); } catch { flagSaveErr(); }
  };

  // ---- murbah ----------------------------------------------------------
  const cycleMurbahStage = async (id) => {
    const m = murbahOpps.find((x) => x.id === id);
    if (!m) return;
    const next = nextMurbahStage(m.stage);
    setMurbahOpps((prev) => prev.map((x) => (x.id === id ? { ...x, stage: next } : x)));
    try { await base44.entities.DeckMurbahOpportunity.update(id, { stage: next }); } catch { flagSaveErr(); }
  };
  const updateMurbahNote = (id, note) => {
    setMurbahOpps((prev) => prev.map((m) => (m.id === id ? { ...m, note } : m)));
    debouncedSave(`murbah-${id}`, async () => {
      try { await base44.entities.DeckMurbahOpportunity.update(id, { note }); } catch { flagSaveErr(); }
    });
  };

  // ---- strategy / knowledge --------------------------------------------
  const addStrategy = async (text) => {
    if (!text.trim()) return;
    try {
      const created = await base44.entities.DeckStrategyNote.create({ text: text.trim() });
      setStrategy((prev) => [created, ...prev]);
    } catch { flagSaveErr(); }
  };
  const removeStrategy = async (id) => {
    setStrategy((prev) => prev.filter((s) => s.id !== id));
    try { await base44.entities.DeckStrategyNote.delete(id); } catch { flagSaveErr(); }
  };
  const addKnowledge = async (text) => {
    if (!text.trim()) return;
    try {
      const created = await base44.entities.DeckKnowledgeNote.create({ text: text.trim() });
      setKnowledge((prev) => [created, ...prev]);
    } catch { flagSaveErr(); }
  };
  const removeKnowledge = async (id) => {
    setKnowledge((prev) => prev.filter((k) => k.id !== id));
    try { await base44.entities.DeckKnowledgeNote.delete(id); } catch { flagSaveErr(); }
  };

  // ---- life streams -----------------------------------------------------
  const toggleLifeStatus = async (streamKey) => {
    const stream = lifeStreams[streamKey];
    if (!stream) return;
    const next = stream.status === 'on' ? 'needs_work' : 'on';
    setLifeStreams((prev) => ({ ...prev, [streamKey]: { ...stream, status: next } }));
    try { await base44.entities.DeckLifeStream.update(stream.id, { status: next }); } catch { flagSaveErr(); }
  };
  const addLifeNote = async (streamKey, text) => {
    if (!text.trim()) return;
    const stream = lifeStreams[streamKey];
    if (!stream) return;
    try {
      const created = await base44.entities.DeckLifeStreamNote.create({ life_stream_id: stream.id, text: text.trim() });
      setLifeStreams((prev) => ({ ...prev, [streamKey]: { ...stream, notes: [created, ...stream.notes] } }));
    } catch { flagSaveErr(); }
  };
  const removeLifeNote = async (streamKey, noteId) => {
    const stream = lifeStreams[streamKey];
    if (!stream) return;
    setLifeStreams((prev) => ({ ...prev, [streamKey]: { ...stream, notes: stream.notes.filter((n) => n.id !== noteId) } }));
    try { await base44.entities.DeckLifeStreamNote.delete(noteId); } catch { flagSaveErr(); }
  };

  // ---- inbox -------------------------------------------------------------
  const addInbox = async () => {
    if (!iForm.message.trim()) return;
    try {
      const created = await base44.entities.DeckInboxItem.create({
        channel: iForm.channel, from_name: iForm.from.trim() || '—', message: iForm.message.trim(), stage: 'new',
      });
      setInbox((prev) => [created, ...prev]);
      setIForm({ channel: iForm.channel, from: '', message: '' });
    } catch { flagSaveErr(); }
  };
  const cycleInboxStage = async (id) => {
    const i = inbox.find((x) => x.id === id);
    if (!i) return;
    const next = nextInboxStage(i.stage);
    setInbox((prev) => prev.map((x) => (x.id === id ? { ...x, stage: next } : x)));
    try { await base44.entities.DeckInboxItem.update(id, { stage: next }); } catch { flagSaveErr(); }
  };
  const removeInbox = async (id) => {
    setInbox((prev) => prev.filter((i) => i.id !== id));
    try { await base44.entities.DeckInboxItem.delete(id); } catch { flagSaveErr(); }
  };

  const syncGmailInbox = async () => {
    setGmailSyncing(true);
    setGmailSyncMsg(null);
    try {
      const { data } = await base44.functions.invoke('syncDeckGmailInbox', {});
      const rows = await base44.entities.DeckInboxItem.list();
      setInbox(rows);
      const base = data?.created ? `${data.created} new message${data.created === 1 ? '' : 's'}.` : 'Up to date.';
      setGmailSyncMsg(data?.failed ? `${base} ${data.failed} couldn't be checked — will retry next sync.` : base);
    } catch (err) {
      setGmailSyncMsg(err.message || "Couldn't sync Gmail.");
    } finally {
      setGmailSyncing(false);
    }
  };

  const startReplyDraft = async (inboxItemId) => {
    setReplyDraftFor(inboxItemId);
    setReplyDraftText('');
    setReplyBusy(true);
    try {
      const { data } = await base44.functions.invoke('suggestDeckReply', { inboxItemId });
      setReplyDraftText(data?.reply || '');
    } catch (err) {
      setReplyDraftText('');
      flagSaveErr();
      console.error(err);
    } finally {
      setReplyBusy(false);
    }
  };
  const cancelReplyDraft = () => {
    setReplyDraftFor(null);
    setReplyDraftText('');
  };
  const sendReplyDraft = async () => {
    if (!replyDraftFor || !replyDraftText.trim()) return;
    setReplyBusy(true);
    try {
      const { data } = await base44.functions.invoke('sendDeckEmailReply', { inboxItemId: replyDraftFor, reply: replyDraftText.trim() });
      if (data?.item) setInbox((prev) => prev.map((i) => (i.id === data.item.id ? data.item : i)));
      setReplyDraftFor(null);
      setReplyDraftText('');
    } catch (err) {
      flagSaveErr();
      console.error(err);
    } finally {
      setReplyBusy(false);
    }
  };

  // ---- backup / export ---------------------------------------------------
  const runExport = async () => {
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const [
        dumpRows, peopleRows, taskRows, consignRows, repairRows, repairFileRows,
        murbahRows, inboxRows, strategyRows, knowledgeRows, lifeStreamRows,
        lifeStreamNoteRows, energyRows, focusRows,
      ] = await Promise.all([
        base44.entities.DeckDumpItem.list(),
        base44.entities.DeckPerson.list(),
        base44.entities.DeckTask.list(),
        base44.entities.DeckConsignmentItem.list(),
        base44.entities.DeckRepairJob.list(),
        base44.entities.DeckRepairFile.list(),
        base44.entities.DeckMurbahOpportunity.list(),
        base44.entities.DeckInboxItem.list(),
        base44.entities.DeckStrategyNote.list(),
        base44.entities.DeckKnowledgeNote.list(),
        base44.entities.DeckLifeStream.list(),
        base44.entities.DeckLifeStreamNote.list(),
        base44.entities.DeckEnergyLogEntry.list(),
        base44.entities.DeckFocusEntry.list(),
      ]);
      const data = {
        dump: dumpRows, people: peopleRows, tasks: taskRows, consignment: consignRows,
        repairs: repairRows, repair_files: repairFileRows, murbah: murbahRows, inbox: inboxRows,
        strategy: strategyRows, knowledge: knowledgeRows, life_streams: lifeStreamRows,
        life_stream_notes: lifeStreamNoteRows, energy_log: energyRows, focus_log: focusRows,
      };
      setBackupText(JSON.stringify(data, null, 2));
      const total = Object.values(data).reduce((n, arr) => n + arr.length, 0);
      setBackupMsg(`Exported ${total} rows.`);
    } catch {
      setBackupMsg("Couldn't export — try again.");
    }
    setBackupBusy(false);
  };
  const copyBackup = () => {
    if (!backupText) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(backupText).then(() => setBackupMsg('Copied to clipboard.'));
    }
  };
  const downloadBackup = () => {
    if (!backupText) return;
    const blob = new Blob([backupText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `command-deck-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- jarvis ------------------------------------------------------------
  const sendJarvisMessage = async () => {
    const text = jarvisInput.trim();
    if (!text || jarvisSending) return;
    const optimisticUser = { id: `local-${Date.now()}`, role: 'user', content: text };
    setJarvisMessages((prev) => [...prev, optimisticUser]);
    setJarvisInput('');
    setJarvisSending(true);
    setJarvisErr(false);
    try {
      const { data } = await base44.functions.invoke('chatWithJarvis', { message: text });
      setJarvisMessages((prev) => [...prev, { id: `local-${Date.now()}-r`, role: 'jarvis', content: data.reply }]);
    } catch {
      setJarvisErr(true);
    }
    setJarvisSending(false);
  };

  const value = {
    loaded, saveErr,
    dump, dumpInput, setDumpInput, quickFileMsg, detectOwner, addDump, removeDump, promoteDump,
    tasks, taskInput, setTaskInput, taskOwner, setTaskOwner, taskEnergy, setTaskEnergy, openOwner, setOpenOwner,
    addTask, toggleTask, removeTask,
    people, personForm, setPersonForm, managePeople, setManagePeople, addPerson, updatePersonPhone, removePerson,
    energy, energyHistory, focusTask, setEnergyLevel, saveFocus,
    openStream, setOpenStream, consignment, repairs, murbahOpps,
    cForm, setCForm, addConsignment, toggleSold, removeConsignment,
    rForm, setRForm, addRepair, cycleRepairStage, removeRepair, addFilesToJob, removeFileFromJob,
    cycleMurbahStage, updateMurbahNote,
    strategy, knowledge, addStrategy, removeStrategy, addKnowledge, removeKnowledge,
    inbox, iForm, setIForm, addInbox, cycleInboxStage, removeInbox,
    gmailSyncing, gmailSyncMsg, syncGmailInbox,
    replyDraftFor, replyDraftText, setReplyDraftText, replyBusy, startReplyDraft, cancelReplyDraft, sendReplyDraft,
    lifeStreams, toggleLifeStatus, addLifeNote, removeLifeNote,
    lightboxImg, setLightboxImg,
    backupText, backupBusy, backupMsg, runExport, copyBackup, downloadBackup,
    jarvisMessages, jarvisInput, setJarvisInput, jarvisSending, jarvisErr, sendJarvisMessage,
    uploadFile,
  };

  return <CommandDeckContext.Provider value={value}>{children}</CommandDeckContext.Provider>;
}
