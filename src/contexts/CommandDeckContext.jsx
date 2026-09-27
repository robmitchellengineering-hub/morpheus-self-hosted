import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DEFAULT_PEOPLE, OWNER_COLOR_CYCLE, LIFE_STREAMS_META,
  nextMurbahStage, nextRepairStage, nextInboxStage,
  isYou, todayKey, todayISO, randomDeleteConfirmPhrase,
} from '@/pages/CommandDeck/deckConstants';
import { DECK_WIDGETS } from '@/pages/CommandDeck/deckWidgets';
import { summarizeFiling } from '@/pages/CommandDeck/dumpFiling';

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
  // Filing a dump is a classifier round trip, so there is a real window where a second
  // press lands. `dumpPending` drives the disabled button; `dumpInFlight` is the guard that
  // actually stops it, because state is not visible to a second press in the same tick.
  const [dumpPending, setDumpPending] = useState(false);
  const dumpInFlight = useRef(false);
  const [quickFileMsg, setQuickFileMsg] = useState(null);
  const quickFileTimeout = useRef(null);

  const [tasks, setTasks] = useState([]);
  const [taskInput, setTaskInput] = useState('');
  const [taskOwner, setTaskOwner] = useState('');
  const [taskEnergy, setTaskEnergy] = useState('any');
  const [openOwner, setOpenOwner] = useState(null);

  const [people, setPeople] = useState([]);
  const [personForm, setPersonForm] = useState({ name: '', phone: '', email: '' });
  const [managePeople, setManagePeople] = useState(false);

  const [energy, setEnergy] = useState(null);
  const [energyHistory, setEnergyHistory] = useState([]);
  const [focusTask, setFocusTask] = useState('');
  const [focusEntryId, setFocusEntryId] = useState(null);

  const [openStream, setOpenStream] = useState(null);
  const [consignment, setConsignment] = useState([]);
  const [repairs, setRepairs] = useState([]);
  const [murbahOpps, setMurbahOpps] = useState([]);
  const [murbahSyncBusy, setMurbahSyncBusy] = useState(null); // opportunity id currently syncing, or null
  const [murbahSyncMsg, setMurbahSyncMsg] = useState(null);
  const [murbahCalendarEvents, setMurbahCalendarEvents] = useState([]);
  const [murbahEventsLoading, setMurbahEventsLoading] = useState(false);

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

  // A random, not-always-the-same confirm step in front of every real
  // delete across the Deck — see DELETE_CONFIRM_PHRASES.
  const [confirmDeleteState, setConfirmDeleteState] = useState(null); // { message, onConfirm } | null
  const askToDelete = (onConfirm) => setConfirmDeleteState({ message: randomDeleteConfirmPhrase(), onConfirm });
  const resolveConfirmDelete = (confirmed) => {
    if (confirmed) confirmDeleteState?.onConfirm?.();
    setConfirmDeleteState(null);
  };

  const [jarvisMessages, setJarvisMessages] = useState([]);
  const [jarvisInput, setJarvisInput] = useState('');
  const [jarvisSending, setJarvisSending] = useState(false);
  const [jarvisErr, setJarvisErr] = useState(false);
  const [synthesisBusy, setSynthesisBusy] = useState(false);
  const [synthesisErr, setSynthesisErr] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const [docErr, setDocErr] = useState(null);
  const [docResult, setDocResult] = useState(null); // { url, title } | null

  const [backupText, setBackupText] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState(null);

  const [driveBackupBusy, setDriveBackupBusy] = useState(false);
  const [driveBackupMsg, setDriveBackupMsg] = useState(null);
  const [driveRestoreBusy, setDriveRestoreBusy] = useState(false);
  const [driveRestoreMsg, setDriveRestoreMsg] = useState(null);
  const [lastBackupAt, setLastBackupAt] = useState(null);
  // Data-vault reachability. Deliberately separate from lastBackupAt: a
  // timestamp only proves a backup once SUCCEEDED, not that the vault is still
  // there. See server/src/functions/checkDeckVault.js.
  const [vaultStatus, setVaultStatus] = useState(null);
  const [vaultBusy, setVaultBusy] = useState(false);

  const [cForm, setCForm] = useState({ item: '', consignor: '', phone: '', price: '', photo_url: null });
  const [rForm, setRForm] = useState({ customer: '', phone: '', item: '', notes: '', pendingFiles: [] });

  // ---- widgets & business profile ----------------------------------------
  // Rob, 2026-09-17: "I should be able to add custom widgets there too, I
  // just don't want to lose the tools I already have." widgetInstances
  // drives which DECK_WIDGETS entries actually render on this account's
  // Deck, and in what order — see deckWidgets.js for the registry itself.
  const [widgetInstances, setWidgetInstances] = useState([]); // [{id, widget_key, enabled, sort_order}]
  const [businessProfile, setBusinessProfile] = useState(null); // {id, shop_name, tagline, contact_email, business_context} | null
  const [businessProfileBusy, setBusinessProfileBusy] = useState(false);

  // Jarvis-triggered widget build in progress (server/src/functions/
  // buildDeckWidget.js) — Rob, 2026-09-17: "it should be a progress bar
  // with details running in the widgets card." Polled (not part of the
  // main load effect below) only while a build is running — see the effect
  // further down. null once dismissed or when there's nothing to show.
  const [widgetBuild, setWidgetBuild] = useState(null);

  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarForm, setCalendarForm] = useState({ summary: '', date: '' });
  const [calendarBusy, setCalendarBusy] = useState(false);

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
          widgetRows, businessProfileRows,
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
          base44.entities.DeckWidgetInstance.list(),
          base44.entities.DeckBusinessProfile.list(),
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

        // Lazy-seed one DeckWidgetInstance row per DECK_WIDGETS entry, same
        // pattern as DeckPerson/DeckLifeStream above. A genuinely new
        // account gets each widget's own defaultEnabled; Rob's own account
        // was explicitly backfilled with real rows by this feature's own
        // migration before this code ever shipped, so this branch never
        // fires for him — his Deck stays exactly as it was.
        let widgetList = widgetRows;
        if (widgetList.length === 0) {
          widgetList = [];
          for (let i = 0; i < DECK_WIDGETS.length; i++) {
            const w = DECK_WIDGETS[i];
            widgetList.push(await base44.entities.DeckWidgetInstance.create({ widget_key: w.key, enabled: w.defaultEnabled, sort_order: i }));
          }
        }

        setDump(dumpRows);
        setPeople(peopleList);
        setTasks(taskRows);
        setConsignment(consignRows);
        setRepairs(repairRows.map((r) => ({ ...r, files: repairFileRows.filter((f) => f.repair_job_id === r.id) })));
        setMurbahOpps(murbahRows);
        setInbox(inboxRows);
        setStrategy(strategyRows);
        setKnowledge(knowledgeRows);
        setLifeStreams(Object.fromEntries(lifeStreamRowsFinal.map((ls) => [
          ls.stream_key,
          { ...ls, notes: lifeStreamNoteRows.filter((n) => n.life_stream_id === ls.id) },
        ])));
        setEnergyHistory(energyRows);
        setJarvisMessages(jarvisRows);
        setWidgetInstances(widgetList);
        setBusinessProfile(businessProfileRows[0] || null);

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

  // ---- widget build progress ---------------------------------------------
  // Checks once for a widget build/delete job on load, then polls every 5s
  // only while one exists and isn't done/failed — same "poll while active,
  // stop once terminal" shape as SelfDev.jsx's own PR-merge watcher, just
  // much shorter-lived. A terminal row stays visible (with a dismiss
  // button in the widget manager) until the user clears it or starts
  // another job.
  //
  // Exposed as pollWidgetBuild (not just an effect-local closure) so a
  // frontend-triggered job — deleteWidget() below — can kick polling off
  // immediately instead of waiting for the next full page load: the
  // mount-time effect only decides on its own whether to KEEP polling
  // based on what it finds at mount, so a job started later in the same
  // session needs its own explicit kick to be picked up before that.
  const widgetBuildPollTimer = useRef(null);
  const pollWidgetBuild = useCallback(async () => {
    window.clearTimeout(widgetBuildPollTimer.current);
    try {
      const rows = await base44.entities.DeckWidgetBuild.list('-created_date', 1);
      const latest = rows[0] || null;
      setWidgetBuild(latest);
      if (latest && !['done', 'failed'].includes(latest.status)) {
        widgetBuildPollTimer.current = window.setTimeout(pollWidgetBuild, 5000);
      }
    } catch {
      // transient — the next mount/dismiss/trigger retries this
    }
  }, []);
  useEffect(() => {
    pollWidgetBuild();
    return () => window.clearTimeout(widgetBuildPollTimer.current);
  }, [pollWidgetBuild]);
  const dismissWidgetBuild = () => setWidgetBuild(null);

  // ---- brain dump --------------------------------------------------------
  // Deliberately name-only, not first-person — this drives the FAST,
  // unconditional "straight to a task" bypass, and almost every personal
  // note is phrased in first person ("I need to...", "my amp..."). Matching
  // "I" here would route nearly everything straight to a task and skip
  // classifyDeckDumpItem.js's actual strategy/knowledge/life-stream
  // classification for the common case. Task ownership already defaults to
  // the self person when the AI classifies something as a task (see
  // addDump below) — that's where first-person "I said" phrasing already
  // matters, without this fast path swallowing everything else.
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

  const flagQuickFile = (msg) => {
    setQuickFileMsg(msg);
    window.clearTimeout(quickFileTimeout.current);
    quickFileTimeout.current = window.setTimeout(() => setQuickFileMsg(null), 2600);
  };

  const addDump = async () => {
    // Re-entrancy guard. Before this, pressing + while the first press was still out filed
    // the SAME text again, once per press, because the input was only cleared after the
    // whole classify-and-file loop had finished — seconds, on a classifier call. The ref
    // (not the state) is what makes it airtight: a second press in the same tick still sees
    // `dumpPending === false`, but never sees a stale ref.
    if (dumpInFlight.current) return;
    const text = dumpInput.trim();
    if (!text) return;
    dumpInFlight.current = true;
    setDumpPending(true);
    // Clear immediately, so even a press that slips past the guard finds nothing to submit.
    // Restored in the catch below, so a capture is never lost to a failure.
    setDumpInput('');
    // Declared out here so the catch below can tell "nothing landed" from "some landed":
    // restoring the whole dump after a partial success would duplicate the items that
    // already filed. See ./dumpFiling.js.
    const labels = [];
    const failedTexts = [];
    try {
      // ONE classification call for the whole dump. This used to short-circuit
      // to a single owner as soon as any person's name appeared anywhere in the
      // text — which filed every thought in a multi-thought dump to that one
      // person ("get milk and ask Dave about the trailer" put the milk on
      // Dave's list). The classifier now assigns a destination and an owner per
      // item, so a dictated dump lands in several places instead of one.
      let items;
      try {
        const { data } = await base44.functions.invoke('classifyDeckDumpItem', { text });
        items = Array.isArray(data?.items) && data.items.length
          ? data.items
          // A backend still on the previous build (it deploys independently)
          // answers in the single-destination shape.
          : [{ text, destination: data?.destination, life_stream_key: data?.life_stream_key, owner_name: null }];
      } catch {
        // Classification unavailable — fall back to the name regex, or to the
        // unsorted pile so nothing is lost; the promote buttons cover it by hand.
        const owner = detectOwner(text);
        if (owner) {
          const created = await base44.entities.DeckTask.create({ text, owner_person_id: owner.id, energy: 'any', done: false });
          setTasks((prev) => [created, ...prev]);
          flagQuickFile(`Filed straight to ${owner.name}'s tasks`);
        } else {
          const created = await base44.entities.DeckDumpItem.create({ text });
          setDump((prev) => [created, ...prev]);
          flagQuickFile('Saved to the unsorted pile');
        }
        return;
      }

      const selfId = people.find(isYou)?.id;
      for (const item of items) {
        const itemText = String(item?.text || text).trim();
        if (!itemText) continue;
        const named = item?.owner_name
          ? people.find((p) => p.name.trim().toLowerCase() === String(item.owner_name).trim().toLowerCase())
          : null;

        // Each item is filed on its own. One create throwing used to abandon the rest
        // AND put the whole dump back with "try again" while the rows already written
        // stayed — so the retry filed every item that had succeeded a second time.
        try {
          if (item?.destination === 'task') {
            const created = await base44.entities.DeckTask.create({ text: itemText, owner_person_id: named?.id || selfId, energy: 'any', done: false });
            setTasks((prev) => [created, ...prev]);
            labels.push(named && !isYou(named) ? `${named.name}'s tasks` : 'your tasks');
          } else if (item?.destination === 'strategy') {
            const created = await base44.entities.DeckStrategyNote.create({ text: itemText });
            setStrategy((prev) => [created, ...prev]);
            labels.push('Strategy');
          } else if (item?.destination === 'life_stream' && lifeStreams[item.life_stream_key]) {
            if (!(await addLifeNote(item.life_stream_key, itemText))) {
              failedTexts.push(itemText);
              continue;
            }
            labels.push(LIFE_STREAMS_META.find((s) => s.id === item.life_stream_key)?.label || item.life_stream_key);
          } else {
            const created = await base44.entities.DeckKnowledgeNote.create({ text: itemText });
            setKnowledge((prev) => [created, ...prev]);
            labels.push('Knowledge');
          }
        } catch {
          failedTexts.push(itemText);
        }
      }

      // Say where things went — the whole point of auto-filing is that the capture stays
      // thoughtless, which only holds if it is visible. What it says is what LANDED, and
      // what did not goes back in the box so one press retries exactly that. Both halves
      // are decided in ./dumpFiling.js, where a guard can reach them.
      const outcome = summarizeFiling({ labels, failedTexts, originalText: text });
      if (failedTexts.length) {
        setDumpInput(outcome.restore);
        flagSaveErr();
      }
      if (outcome.message) flagQuickFile(outcome.message);
    } catch {
      flagSaveErr();
      // Put it back: the box was cleared optimistically on the way in, and losing what
      // someone just typed is worse than making them press again — but only when NOTHING
      // landed. Restoring the whole dump after some items filed would duplicate every one
      // of them on the retry, which is what this used to do.
      if (!labels.length) setDumpInput(text);
    } finally {
      dumpInFlight.current = false;
      setDumpPending(false);
    }
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
      const created = await base44.entities.DeckPerson.create({
        name: personForm.name.trim(), phone: personForm.phone.trim(), email: personForm.email.trim(), color,
      });
      setPeople((prev) => [...prev, created]);
      setPersonForm({ name: '', phone: '', email: '' });
    } catch { flagSaveErr(); }
  };
  const updatePersonPhone = (id, phone) => {
    setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, phone } : p)));
    debouncedSave(`person-${id}`, async () => {
      try { await base44.entities.DeckPerson.update(id, { phone }); } catch { flagSaveErr(); }
    });
  };
  const updatePersonEmail = (id, email) => {
    setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, email } : p)));
    debouncedSave(`person-email-${id}`, async () => {
      try { await base44.entities.DeckPerson.update(id, { email }); } catch { flagSaveErr(); }
    });
  };
  const updatePersonName = (id, name) => {
    setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
    debouncedSave(`person-name-${id}`, async () => {
      try { await base44.entities.DeckPerson.update(id, { name }); } catch { flagSaveErr(); }
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
  const updateMurbahDate = (id, dateStr) => {
    // booking_date is always a string everywhere else (an ISO string, as
    // every entity read from the API comes back JSON-serialized) —
    // MurbahPanel's dateValue does `(m.booking_date || '').slice(0, 10)`, a
    // string method. Setting this to a raw Date object here (Rob,
    // 2026-09-17: "entering and changing calendar dates in murbah causes a
    // blank screen needing a refresh") made that .slice() throw on the very
    // next render — a real crash, not a UI nit.
    const date = dateStr ? new Date(`${dateStr}T00:00:00.000Z`).toISOString() : null;
    setMurbahOpps((prev) => prev.map((m) => (m.id === id ? { ...m, booking_date: date } : m)));
    debouncedSave(`murbah-date-${id}`, async () => {
      try { await base44.entities.DeckMurbahOpportunity.update(id, { booking_date: date }); } catch { flagSaveErr(); }
    });
  };
  const syncMurbahCalendar = async (id) => {
    setMurbahSyncBusy(id);
    setMurbahSyncMsg(null);
    try {
      const { data } = await base44.functions.invoke('syncMurbahBooking', { opportunityId: id });
      setMurbahOpps((prev) => prev.map((m) => (m.id === id ? { ...m, calendar_event_id: data?.eventId || m.calendar_event_id } : m)));
      setMurbahSyncMsg('Synced to Calendar.');
    } catch (err) {
      setMurbahSyncMsg(err.message || "Couldn't sync to Calendar.");
    }
    setMurbahSyncBusy(null);
  };
  const loadMurbahCalendarEvents = async () => {
    setMurbahEventsLoading(true);
    try {
      const { data } = await base44.functions.invoke('listMurbahCalendarEvents', {});
      setMurbahCalendarEvents(data?.events || []);
    } catch {
      setMurbahCalendarEvents([]);
    }
    setMurbahEventsLoading(false);
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
  // Returns whether the note was saved. It used to swallow the failure, so the dump's
  // filing loop counted a life stream in the green "Filed N items" line for a note that
  // was never written — a success message over lost words, which is the one thing the
  // capture path must never do.
  const addLifeNote = async (streamKey, text) => {
    if (!text.trim()) return true;      // nothing to file is not a failure
    const stream = lifeStreams[streamKey];
    if (!stream) return false;          // a stream that isn't loaded means nothing landed
    try {
      const created = await base44.entities.DeckLifeStreamNote.create({ life_stream_id: stream.id, text: text.trim() });
      setLifeStreams((prev) => ({ ...prev, [streamKey]: { ...stream, notes: [created, ...stream.notes] } }));
      return true;
    } catch { flagSaveErr(); return false; }
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
      const parts = [base];
      if (data?.failed) parts.push(`${data.failed} couldn't be checked — will retry next sync.`);
      // The server stops itself well inside this request's own timeout, so a big backlog
      // reads as "more to do" rather than as a failure. Say which it is.
      if (data?.stoppedEarly) parts.push('More to check — tap sync again.');
      setGmailSyncMsg(parts.join(' '));
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

  // ---- drive backup / restore ---------------------------------------------
  // A separate mechanism from runExport above (that one's a manual JSON
  // download); this pushes/pulls the same 14-entity dataset to/from the
  // user's own connected Google Drive, so it survives even if they never
  // think to hit "download" themselves.
  const driveBackup = async () => {
    setDriveBackupBusy(true);
    setDriveBackupMsg(null);
    try {
      const { data } = await base44.functions.invoke('backupDeckToDrive', {});
      setLastBackupAt(data?.backedUpAt || null);
      // A backup that just succeeded proves the vault is reachable — no point
      // re-probing Drive to learn what we already know.
      setVaultStatus((prev) => ({
        ...(prev || {}),
        reachable: true,
        reason: 'ok',
        lastBackupAt: data?.backedUpAt || null,
        ageDays: 0,
      }));
      setDriveBackupMsg(`Backed up ${data?.totalRows ?? 0} rows to Drive.`);
    } catch (err) {
      setDriveBackupMsg(err.message || "Couldn't back up to Drive.");
    }
    setDriveBackupBusy(false);
  };
  const checkVault = async () => {
    setVaultBusy(true);
    try {
      const { data } = await base44.functions.invoke('checkDeckVault', {});
      setVaultStatus(data || null);
    } catch (err) {
      setVaultStatus({ reachable: false, reason: 'error', error: err.message });
    }
    setVaultBusy(false);
  };

  const driveRestore = async () => {
    setDriveRestoreBusy(true);
    setDriveRestoreMsg(null);
    try {
      const { data } = await base44.functions.invoke('restoreDeckFromDrive', { confirm: true });
      setDriveRestoreMsg(`Restored ${data?.totalRows ?? 0} rows from the ${data?.backedUpAt ? new Date(data.backedUpAt).toLocaleString() : 'last'} backup. Reloading…`);
      // Every Deck* row just got wiped and replaced server-side — a full
      // reload is simpler and safer than trying to patch 14 different
      // pieces of local state back into sync by hand.
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setDriveRestoreMsg(err.message || "Couldn't restore from Drive.");
    }
    setDriveRestoreBusy(false);
  };

  // ---- widgets & business profile -----------------------------------------
  const toggleWidget = async (key) => {
    const row = widgetInstances.find((w) => w.widget_key === key);
    if (!row) return;
    const next = !row.enabled;
    setWidgetInstances((prev) => prev.map((w) => (w.widget_key === key ? { ...w, enabled: next } : w)));
    try { await base44.entities.DeckWidgetInstance.update(row.id, { enabled: next }); } catch { flagSaveErr(); }
  };
  // direction: -1 (move earlier) or 1 (move later) in sort_order.
  const moveWidget = async (key, direction) => {
    const sorted = [...widgetInstances].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((w) => w.widget_key === key);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
    const updated = sorted.map((w, i) => ({ ...w, sort_order: i }));
    setWidgetInstances(updated);
    try {
      await Promise.all(updated.map((w) => base44.entities.DeckWidgetInstance.update(w.id, { sort_order: w.sort_order })));
    } catch { flagSaveErr(); }
  };
  // Rob, 2026-09-18: "you should be able to delete your own widgets that
  // you make... with an are you sure confirmation" — the confirmation
  // itself is askToDelete()'s job, called from Settings before this ever
  // runs (see WidgetManager()). This just fires the request and clears the
  // widget from local state immediately: deleteDeckWidget.js's fast phase
  // removes the DeckWidgetInstance row unconditionally before anything
  // slower runs, so this optimistic update reflects a guaranteed outcome,
  // not a guess. Whether the widget's underlying CODE actually disappears
  // from production is the slower part, surfaced via the same widget-build
  // progress card (pollWidgetBuild), not by this function.
  const deleteWidget = async (key) => {
    setWidgetInstances((prev) => prev.filter((w) => w.widget_key !== key));
    try {
      await base44.functions.invoke('deleteDeckWidget', { widgetKey: key });
    } catch {
      flagSaveErr();
    } finally {
      pollWidgetBuild();
    }
  };

  const saveBusinessProfile = async (fields) => {
    setBusinessProfileBusy(true);
    try {
      if (businessProfile?.id) {
        const updated = await base44.entities.DeckBusinessProfile.update(businessProfile.id, fields);
        setBusinessProfile(updated);
      } else {
        const created = await base44.entities.DeckBusinessProfile.create(fields);
        setBusinessProfile(created);
      }
    } catch { flagSaveErr(); }
    setBusinessProfileBusy(false);
  };

  // ---- calendar widget ------------------------------------------------------
  // The generic "Calendar" widget (Rob, 2026-09-17: alongside Inbox, the two
  // widgets every account should get by default) — separate from Signal
  // Chain's own Murbah↔Calendar sync, which stays exactly what it is.
  const loadCalendarEvents = async () => {
    setCalendarLoading(true);
    try {
      const { data } = await base44.functions.invoke('listUpcomingDeckEvents', {});
      setCalendarEvents(data?.events || []);
    } catch {
      // Best-effort — most likely cause is Google not connected yet; the
      // widget's own empty state covers that, no separate error banner needed.
    }
    setCalendarLoading(false);
  };
  const addCalendarEvent = async () => {
    if (!calendarForm.summary.trim() || !calendarForm.date) return;
    setCalendarBusy(true);
    try {
      await base44.functions.invoke('addDeckCalendarEvent', { summary: calendarForm.summary.trim(), date: calendarForm.date });
      setCalendarForm({ summary: '', date: '' });
      await loadCalendarEvents();
    } catch { flagSaveErr(); }
    setCalendarBusy(false);
  };

  // ---- jarvis ------------------------------------------------------------
  // fileUrls: photos/PDFs/Word/Excel attached via DeckJarvis.jsx's paperclip
  // button (uploaded through the same uploadFile() every other Deck photo
  // upload already uses). The optimistic bubble shows the attached filenames
  // the same lightweight way chatWithJarvis.js itself persists them, so the
  // UI and the actual saved history never disagree about what was attached.
  const sendJarvisMessage = async (fileUrls = []) => {
    const text = jarvisInput.trim();
    if ((!text && fileUrls.length === 0) || jarvisSending) return;
    const attachedNote = fileUrls.length ? `\n[attached: ${fileUrls.map((u) => decodeURIComponent(u.split('/').pop().split('?')[0])).join(', ')}]` : '';
    const optimisticUser = { id: `local-${Date.now()}`, role: 'user', content: `${text}${attachedNote}`.trim() };
    setJarvisMessages((prev) => [...prev, optimisticUser]);
    setJarvisInput('');
    setJarvisSending(true);
    setJarvisErr(false);
    try {
      const { data } = await base44.functions.invoke('chatWithJarvis', { message: text, fileUrls });
      setJarvisMessages((prev) => [...prev, { id: `local-${Date.now()}-r`, role: 'jarvis', content: data.reply }]);
    } catch {
      setJarvisErr(true);
    }
    setJarvisSending(false);
  };

  // The Jarvis "Get suggestions" card — a one-shot, self-triggered
  // synthesis over the same live snapshot chatWithJarvis.js grounds normal
  // conversation in, but with no question of the user's to answer. Saved
  // server-side as an ordinary DeckJarvisMessage (role "jarvis_synthesis"),
  // so it's already in `jarvisMessages` once loaded — lastSynthesis below
  // just needs to find the newest one, no separate fetch/state to keep in
  // sync.
  const runJarvisSynthesis = async () => {
    if (synthesisBusy) return;
    setSynthesisBusy(true);
    setSynthesisErr(false);
    try {
      const { data } = await base44.functions.invoke('runJarvisSynthesis', {});
      setJarvisMessages((prev) => [...prev, { id: `local-${Date.now()}-syn`, role: 'jarvis_synthesis', content: data.reply, created_date: data.createdAt }]);
    } catch {
      setSynthesisErr(true);
    }
    setSynthesisBusy(false);
  };
  const lastSynthesis = [...jarvisMessages].reverse().find((m) => m.role === 'jarvis_synthesis') || null;

  const createDeckDocument = async (instruction) => {
    if (!instruction.trim() || docBusy) return;
    setDocBusy(true);
    setDocErr(null);
    setDocResult(null);
    try {
      const { data } = await base44.functions.invoke('createDeckDocument', { instruction: instruction.trim() });
      setDocResult({ url: data?.url, title: data?.title });
    } catch (err) {
      setDocErr(err.message || "Couldn't create the document.");
    }
    setDocBusy(false);
  };

  const value = {
    loaded, saveErr,
    dump, dumpInput, setDumpInput, dumpPending, quickFileMsg, detectOwner, addDump, removeDump, promoteDump,
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
    lightboxImg, setLightboxImg,
    confirmDeleteState, askToDelete, resolveConfirmDelete,
    backupText, backupBusy, backupMsg, runExport, copyBackup, downloadBackup,
    driveBackupBusy, driveBackupMsg, driveRestoreBusy, driveRestoreMsg, lastBackupAt, driveBackup, driveRestore,
    vaultStatus, vaultBusy, checkVault,
    jarvisMessages, jarvisInput, setJarvisInput, jarvisSending, jarvisErr, sendJarvisMessage,
    synthesisBusy, synthesisErr, runJarvisSynthesis, lastSynthesis,
    docBusy, docErr, docResult, createDeckDocument,
    uploadFile,
    widgetInstances, toggleWidget, moveWidget, deleteWidget,
    widgetBuild, dismissWidgetBuild,
    businessProfile, businessProfileBusy, saveBusinessProfile,
    calendarEvents, calendarLoading, calendarForm, setCalendarForm, calendarBusy, loadCalendarEvents, addCalendarEvent,
  };

  return <CommandDeckContext.Provider value={value}>{children}</CommandDeckContext.Provider>;
}
