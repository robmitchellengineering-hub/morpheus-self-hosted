import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DEFAULT_PEOPLE, OWNER_COLOR_CYCLE, LIFE_STREAMS_META,
  nextMurbahStage, nextRepairStage, nextInboxStage,
  isYou, todayKey, todayISO, randomDeleteConfirmPhrase, commissionFor, feeTiersFromProfile,
} from '@/pages/CommandDeck/deckConstants';
import { DECK_WIDGETS } from '@/pages/CommandDeck/deckWidgets';
import { summarizeFiling, captureFailureMessage } from '@/pages/CommandDeck/dumpFiling';
import { SECONDS_PER_TASK, bankSeconds } from '@/pages/CommandDeck/game/playBank';
import { normalizePrice } from '@/pages/CommandDeck/murbahMoney';
import { initialJarvisLive, reduceJarvisEvent } from '@/lib/jarvisStream';
import PlayModal from '@/pages/CommandDeck/game/PlayModal';
import { useAuth } from '@/lib/AuthContext';

// All of Command Deck's shared state, data loading, and CRUD handlers —
// lifted out of the old single-file CommandDeck.jsx unchanged, so every tab
// page (DeckHome, DeckJarvis, DeckTools, DeckSettings) can read/mutate the
// same data without each tab reloading it independently.

const CommandDeckContext = createContext(null);

// Which finished widget-build card the operator has closed. Kept in localStorage because the card is
// re-read from the NEWEST DeckWidgetBuild row on every mount — an in-memory dismissal was undone by
// the next page load, so the X looked broken (see pollWidgetBuild/dismissWidgetBuild).
const DISMISSED_WIDGET_BUILD_KEY = 'morpheus.deck.dismissedWidgetBuild';

// Date-only fields (murbah's booking_date, a repair's promised_date) are stored as an ISO string and
// never as a Date object: every row read back from the API comes JSON-serialized, so the renderers'
// `(value || '').slice(0, 10)` — a string method — would throw on a real Date and blank the screen
// (Rob, 2026-09-17: "entering and changing calendar dates in murbah causes a blank screen needing a
// refresh"). One definition, used by every date-only write, so the next field cannot get it wrong.
const toIsoDate = (dateStr) => (dateStr ? new Date(`${dateStr}T00:00:00.000Z`).toISOString() : null);

export function useCommandDeck() {
  const ctx = useContext(CommandDeckContext);
  if (!ctx) throw new Error('useCommandDeck must be used within CommandDeckProvider');
  return ctx;
}

// A capture is supposed to be instant — the classifier's own code fast path answers without any
// model call at all. The global 210s API timeout (base44Client's API_FETCH_TIMEOUT_MS) is right for
// a compile and wrong here: it left a failed press silent for three and a half minutes, and an
// operator gives up long before that (measured 2026-10-02).
//
// The cap has to sit ABOVE the slow path, not below it. Measured in usage_events: the classify call
// that reaches the model takes 18-34s, and the 34s one is the last dump that ever filed anything
// successfully (it wrote the strategy and knowledge notes at 2026-10-01T02:58:38Z). A 20s cap would
// have thrown that success away and piled it, so the wait is bounded at 45s — past every observed
// finish, far short of the 210s that made a failure look like a dead button.
//
// Abandoning the wait loses nothing that has not already been lost: the server only classifies and
// every row is written by the caller below, so a request we stop waiting for has filed nothing.
const CLASSIFY_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => {
        const err = new Error(`No answer from Morpheus within ${Math.round(ms / 1000)}s.`);
        err.code = 'CLIENT_TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]);
}

export function CommandDeckProvider({ children }) {
  const [loaded, setLoaded] = useState(false);
  const [saveErr, setSaveErr] = useState(false);
  const flagSaveErr = () => {
    setSaveErr(true);
    window.setTimeout(() => setSaveErr(false), 4000);
  };

  // ── ONE re-entrancy guard for every add action (2026-09-28) ───────────────
  // Rob: "i was able to hot the button twice in repairs and it entered the entry twice ... it
  // just greys out". Both halves are the same missing thing. Until now only the brain dump had
  // a guard; every other add was `if (!input.trim()) return` followed by a network call, which
  // two presses in the same tick BOTH pass — React state is not visible to a second press in
  // the same tick, so a ref is what makes it airtight, and the state is what makes the wait
  // visible. One definition, so a new add cannot be written without it (asserted by
  // scripts/verify-deck-add-guard.mjs).
  //
  // `key` is per-form, not global: filing a dump while typing a repair must still work.
  // Rejections are caught here and reported once — a handler that throws must not become an
  // unhandled rejection, and it must not look like a success either.
  const addInFlight = useRef(new Set());
  const [addPending, setAddPending] = useState({});
  const guardAdd = useCallback((key, fn) => {
    if (addInFlight.current.has(key)) return Promise.resolve(false);
    addInFlight.current.add(key);
    setAddPending((p) => ({ ...p, [key]: true }));
    return Promise.resolve()
      .then(fn)
      .then(
        () => true,
        (err) => {
          console.error(`[deck] add "${key}" failed:`, err?.message || err);
          flagSaveErr();
          return false;
        },
      )
      .finally(() => {
        addInFlight.current.delete(key);
        setAddPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      });
  }, []);

  const [dump, setDump] = useState([]);
  const [dumpInput, setDumpInput] = useState('');
  const [quickFileMsg, setQuickFileMsg] = useState(null);
  const quickFileTimeout = useRef(null);
  // Why the last capture filed nothing. Separate from quickFileMsg, which is the green "where it
  // went" line: a failure and a success must not share a channel, or a failed capture reads as one.
  const [dumpError, setDumpError] = useState(null);

  // ---- Asteroids reward ---------------------------------------------------
  // The bank is a ledger read whole (every credit, every game), and the popup is opened by ticking a
  // task off. See src/pages/CommandDeck/game/.
  const [playCredits, setPlayCredits] = useState([]);
  const [playScores, setPlayScores] = useState([]);
  const [playOpen, setPlayOpen] = useState(false);
  // The board is Morpheus-wide, so it has to know which row is the viewer's — and the initials the
  // player last used are their own most recent score, which is why nothing separate stores them.
  const { user } = useAuth();
  const meId = user?.id || null;
  const playInitials = playScores
    .filter((s) => s.created_by_id === meId)
    .sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')))[0]?.initials || '';

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
  // Why the last draft attempt produced nothing — a message of its own, because the old
  // path called flagSaveErr() and sent the operator looking for a storage problem that
  // did not exist.
  const [replyDraftErr, setReplyDraftErr] = useState(null);

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
  // 2026-10-04 (Rob: "it doesnt look like its doing anything") — what Jarvis's in-flight turn is
  // actually doing, and the words it has written so far. Reduced from the events chatWithJarvis streams
  // by the pure `reduceJarvisEvent` (src/lib/jarvisStream.js), so the same state can be asserted with no
  // browser. It exists from the moment the message is sent — before the server has said anything — so
  // the surface is alive from the first frame rather than from the first token (UI feedback rule 1).
  const [jarvisLive, setJarvisLive] = useState(null);
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

  const [cForm, setCForm] = useState({ item: '', consignor: '', phone: '', price: '', sold_price: '', paid_out: false, photo_url: null });
  const [rForm, setRForm] = useState({ customer: '', phone: '', item: '', notes: '', quote: '', promised_date: '', pendingFiles: [] });

  // ---- widgets & business profile ----------------------------------------
  // Rob, 2026-09-17: "I should be able to add custom widgets there too, I
  // just don't want to lose the tools I already have." widgetInstances
  // drives which DECK_WIDGETS entries actually render on this account's
  // Deck, and in what order — see deckWidgets.js for the registry itself.
  const [widgetInstances, setWidgetInstances] = useState([]); // [{id, widget_key, enabled, sort_order}]
  const [businessProfile, setBusinessProfile] = useState(null); // {id, shop_name, tagline, contact_email, business_context, fee_threshold, fee_rate_under, fee_rate_over} | null
  const [businessProfileBusy, setBusinessProfileBusy] = useState(false);

  // The consignment fee structure the account set in Settings, defaulting to 30% to $2000 / 20%
  // above for a profile nobody has edited (the fee_* columns stay NULL for exactly that reason).
  // Derived ONCE here and handed to every fee call site, so a fee shown in preview and a fee
  // written to a row cannot come from different rules. It is deliberately read only when a sale is
  // being recorded: an already-stored fee is never re-derived, so changing this setting cannot
  // rewrite what was agreed with a consignor (see deckConstants/feeTiers.js and deckSnapshot.js).
  const feeTiers = useMemo(() => feeTiersFromProfile(businessProfile), [businessProfile]);

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
          playCreditRows, playScoreRows, lifeFileRows,
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
          // The Asteroids reward's ledger. Both are read whole: the bank is a running total over
          // every credit and score, and the board needs everyone's best — see game/playBank.js.
          base44.entities.DeckPlayCredit.list(),
          base44.entities.DeckPlayScore.list(),
          // Life-stream attachments. `life_stream_id` on each row lets them hang on the stream the
          // widget already renders, exactly as the notes above do.
          base44.entities.DeckLifeFile.list(),
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
          {
            ...ls,
            notes: lifeStreamNoteRows.filter((n) => n.life_stream_id === ls.id),
            files: lifeFileRows.filter((f) => f.life_stream_id === ls.id),
          },
        ])));
        setEnergyHistory(energyRows);
        setJarvisMessages(jarvisRows);
        setWidgetInstances(widgetList);
        setBusinessProfile(businessProfileRows[0] || null);
        setPlayCredits(playCreditRows);
        setPlayScores(playScoreRows);

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
      // A FINISHED card stays until the operator dismisses it, and the dismissal has to outlive the
      // page. It did not: the X only cleared this component's state, while this effect re-reads the
      // NEWEST row on every mount — so the card came back on every reload and the X looked broken.
      // Rob, 2026-09-29: "the hung state is still in settings". The dismissed id is remembered
      // instead, and only ever suppresses a SETTLED build: a running build has no X to press, and a
      // new build carries a new id, so an old dismissal can never hide live progress.
      let dismissedId = null;
      try { dismissedId = window.localStorage.getItem(DISMISSED_WIDGET_BUILD_KEY); } catch { /* private mode */ }
      const settled = latest ? ['done', 'failed'].includes(latest.status) : false;
      setWidgetBuild(settled && latest.id === dismissedId ? null : latest);
      if (latest && !settled) {
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
  const dismissWidgetBuild = () => {
    setWidgetBuild((current) => {
      if (current?.id) {
        try { window.localStorage.setItem(DISMISSED_WIDGET_BUILD_KEY, current.id); } catch { /* private mode */ }
      }
      return null;
    });
  };

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

  const addDump = () => guardAdd('dump', async () => {
    const text = dumpInput.trim();
    if (!text) return;
    // Clear immediately, so even a press that slips past the guard finds nothing to submit.
    // Restored in the catch below, so a capture is never lost to a failure.
    setDumpInput('');
    setDumpError(null);
    // Declared out here so the catch below can tell "nothing landed" from "some landed":
    // restoring the whole dump after a partial success would duplicate the items that
    // already filed. See ./dumpFiling.js.
    const labels = [];
    const failedTexts = [];
    const fallbackReasons = [];
    try {
      // ONE classification call for the whole dump. This used to short-circuit
      // to a single owner as soon as any person's name appeared anywhere in the
      // text — which filed every thought in a multi-thought dump to that one
      // person ("get milk and ask Dave about the trailer" put the milk on
      // Dave's list). The classifier now assigns a destination and an owner per
      // item, so a dictated dump lands in several places instead of one.
      let items;
      try {
        const { data } = await withTimeout(base44.functions.invoke('classifyDeckDumpItem', { text }), CLASSIFY_TIMEOUT_MS);
        items = Array.isArray(data?.items) && data.items.length
          ? data.items
          // A backend still on the previous build (it deploys independently)
          // answers in the single-destination shape.
          : [{ text, destination: data?.destination, life_stream_key: data?.life_stream_key, owner_name: null }];
      } catch {
        // Classification unavailable — fall back to the name regex, and otherwise to KNOWLEDGE rather
        // than straight to the unsorted pile.
        //
        // The pile is the last resort for when Morpheus cannot be reached at all, and a failed
        // classify call does not mean that: measured 2026-10-02, a 108-character reflection —
        // "I have AuHD and excecutive disfunction issue, i have a hard time keeping track of things
        // and actioning tasks" — landed in the pile this way while the create itself succeeded, which
        // proves the API was up. Rob on the pile: "thats a just in case so you can file it manually".
        // Knowledge is where the server already files a dump it could not classify, so this makes the
        // two halves agree; the pile is kept as a SECOND fallback, because a create that fails must
        // still not lose what someone just typed.
        const owner = detectOwner(text);
        if (owner) {
          const created = await base44.entities.DeckTask.create({ text, owner_person_id: owner.id, energy: 'any', done: false });
          setTasks((prev) => [created, ...prev]);
          flagQuickFile(`Filed straight to ${owner.name}'s tasks`);
        } else {
          try {
            const created = await base44.entities.DeckKnowledgeNote.create({ text });
            setKnowledge((prev) => [created, ...prev]);
            flagQuickFile('Filed to Knowledge — it would not classify, so your words are in there whole');
          } catch {
            const created = await base44.entities.DeckDumpItem.create({ text });
            setDump((prev) => [created, ...prev]);
            flagQuickFile('Saved to the unsorted pile');
          }
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
        // The classifier marks a fallback item so the line below can say "I could not
        // classify it" instead of reporting it as sorted.
        if (item?.fallback_reason) fallbackReasons.push(item.fallback_reason);

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
      const outcome = summarizeFiling({ labels, failedTexts, originalText: text, fallbackReasons });
      if (failedTexts.length) {
        setDumpInput(outcome.restore);
        flagSaveErr();
      }
      if (outcome.message) flagQuickFile(outcome.message);
    } catch (err) {
      // Say WHY, here, next to the box the operator just typed in. The generic save flag renders
      // as a suffix elsewhere on the page and was the only signal a failed capture produced — so a
      // press that filed nothing looked identical to a press that did nothing at all.
      setDumpError(captureFailureMessage(err));
      flagSaveErr();
      // Put it back: the box was cleared optimistically on the way in, and losing what
      // someone just typed is worse than making them press again — but only when NOTHING
      // landed. Restoring the whole dump after some items filed would duplicate every one
      // of them on the retry, which is what this used to do.
      if (!labels.length) setDumpInput(text);
    }
  });
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
  const addTask = () => guardAdd('task', async () => {
    if (!taskInput.trim()) return;
    try {
      const created = await base44.entities.DeckTask.create({ text: taskInput.trim(), owner_person_id: taskOwner, energy: taskEnergy, done: false });
      setTasks((prev) => [created, ...prev]);
      setTaskInput('');
    } catch { flagSaveErr(); }
  });
  const toggleTask = async (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const nowDone = !t.done;
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, done: nowDone } : x)));
    try { await base44.entities.DeckTask.update(id, { done: nowDone }); } catch { flagSaveErr(); }
    // Completing a task earns a minute of Asteroids — "you can play asteroids for 1 min or choose to
    // bank the time to play more later". The credit is written either way, so the popup's two answers
    // are really "play now" and "play later"; both are the same bank.
    //
    // Un-ticking does NOT take the minute back — the credit is a ledger row, and clawing it back
    // would let a mis-tap destroy play time that was already earned. Re-ticking cannot earn a SECOND
    // one: deck_play_credits is unique on (created_by_id, task_id), so the duplicate create is
    // refused by the database. That refusal is the intended outcome, not an error to show.
    if (nowDone) {
      try {
        const credit = await base44.entities.DeckPlayCredit.create({ task_id: id, seconds: SECONDS_PER_TASK, reason: 'task' });
        setPlayCredits((prev) => [...prev, credit]);
      } catch { /* already paid for this task, or offline — the task itself is still done */ }
      setPlayOpen(true);
    }
  };
  const removeTask = async (id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try { await base44.entities.DeckTask.delete(id); } catch { flagSaveErr(); }
  };

  // One row per game played. The time was already spent when the session opened, so a failure here
  // loses the score (flagged) rather than the score being double-counted.
  const submitPlayScore = async ({ score, seconds_played, initials }) => {
    try {
      const created = await base44.entities.DeckPlayScore.create({ score, seconds_played, initials });
      setPlayScores((prev) => [...prev, created]);
    } catch { flagSaveErr(); }
  };

  // ---- people ----------------------------------------------------------
  const addPerson = () => guardAdd('person', async () => {
    if (!personForm.name.trim()) return;
    try {
      const color = OWNER_COLOR_CYCLE[people.length % OWNER_COLOR_CYCLE.length];
      const created = await base44.entities.DeckPerson.create({
        name: personForm.name.trim(), phone: personForm.phone.trim(), email: personForm.email.trim(), color,
      });
      setPeople((prev) => [...prev, created]);
      setPersonForm({ name: '', phone: '', email: '' });
    } catch { flagSaveErr(); }
  });
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
  // A row is created either "on the floor" or as an already-completed sale: the shop takes
  // consignments that sell the same day, so the sold fields belong in the add form as well as on
  // the row (2026-09-27, the deck's CRM edit work).
  const addConsignment = () => guardAdd('consignment', async () => {
    if (!cForm.item.trim()) return;
    const soldPrice = cForm.sold_price === '' ? null : Number(cForm.sold_price) || 0;
    try {
      const created = await base44.entities.DeckConsignmentItem.create({
        item: cForm.item.trim(),
        consignor: cForm.consignor.trim() || '—',
        phone: cForm.phone.trim(),
        price: Number(cForm.price) || 0,
        date_in: new Date().toISOString(),
        sold: soldPrice !== null,
        sold_price: soldPrice,
        sold_date: soldPrice !== null ? new Date().toISOString() : null,
        fee: soldPrice !== null ? commissionFor(soldPrice, feeTiers) : null,
        paid_out: soldPrice !== null ? !!cForm.paid_out : false,
        photo_url: cForm.photo_url || null,
      });
      setConsignment((prev) => [created, ...prev]);
      setCForm({ item: '', consignor: '', phone: '', price: '', sold_price: '', paid_out: false, photo_url: null });
    } catch { flagSaveErr(); }
  });
  const toggleSold = async (id) => {
    const c = consignment.find((x) => x.id === id);
    if (!c) return;
    const sold = !c.sold;
    // Un-selling clears the payout state: "paid out" on an item that is not sold is not a fact
    // worth keeping, and it would leave the owed total quietly wrong.
    const patch = sold
      ? { sold: true, sold_date: c.sold_date || new Date().toISOString() }
      : { sold: false, sold_date: null, paid_out: false };
    setConsignment((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try { await base44.entities.DeckConsignmentItem.update(id, patch); } catch { flagSaveErr(); }
  };
  // Inline edits. `fee` is derived at the moment of the edit from the account's OWN tiers
  // (context `feeTiers`), so the recorded commission cannot disagree with the sale price it was
  // agreed on — while staying STORED, so a later change to the rule cannot rewrite what was
  // agreed with a consignor. Only a price the operator actually re-enters re-derives it.
  const updateConsignment = async (id, patch) => {
    const next = { ...patch };
    if ('sold_price' in next) {
      const p = next.sold_price === '' || next.sold_price === null ? null : Number(next.sold_price) || 0;
      next.sold_price = p;
      next.fee = p === null ? null : commissionFor(p, feeTiers);
    }
    setConsignment((prev) => prev.map((x) => (x.id === id ? { ...x, ...next } : x)));
    try { await base44.entities.DeckConsignmentItem.update(id, next); } catch { flagSaveErr(); }
  };
  const removeConsignment = async (id) => {
    setConsignment((prev) => prev.filter((c) => c.id !== id));
    try { await base44.entities.DeckConsignmentItem.delete(id); } catch { flagSaveErr(); }
  };

  // ---- repairs -------------------------------------------------------
  const addRepair = () => guardAdd('repair', async () => {
    if (!rForm.item.trim()) return;
    try {
      const created = await base44.entities.DeckRepairJob.create({
        customer: rForm.customer.trim() || '—',
        phone: rForm.phone.trim(),
        item: rForm.item.trim(),
        notes: rForm.notes.trim(),
        stage: 'waiting',
        // A quote of 0 is a real answer ("no charge"), so blank and zero are kept apart — the
        // distinction the snapshot's `r.quote ?` test is allowed to lose only because a $0 quote
        // prints nothing either way.
        quote: rForm.quote === '' ? null : Number(rForm.quote) || 0,
        promised_date: toIsoDate(rForm.promised_date),
      });
      let files = [];
      if (rForm.pendingFiles?.length) {
        files = await Promise.all(rForm.pendingFiles.map((pf) => base44.entities.DeckRepairFile.create({
          repair_job_id: created.id, name: pf.name, file_url: pf.file_url, is_image: pf.is_image,
        })));
      }
      setRepairs((prev) => [{ ...created, files }, ...prev]);
      setRForm({ customer: '', phone: '', item: '', notes: '', quote: '', promised_date: '', pendingFiles: [] });
    } catch { flagSaveErr(); }
  });
  // Inline edit for the two things that change after a job is booked: what was quoted, and when it
  // was promised for.
  const updateRepair = async (id, patch) => {
    const next = { ...patch };
    if ('quote' in next) next.quote = next.quote === '' || next.quote === null ? null : Number(next.quote) || 0;
    if ('promised_date' in next) next.promised_date = toIsoDate(next.promised_date);
    setRepairs((prev) => prev.map((x) => (x.id === id ? { ...x, ...next } : x)));
    try { await base44.entities.DeckRepairJob.update(id, next); } catch { flagSaveErr(); }
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
  const addFilesToJob = (jobId, uploadedFiles) => guardAdd(`jobFiles:${jobId}`, async () => {
    try {
      const created = await Promise.all(uploadedFiles.map((f) => base44.entities.DeckRepairFile.create({
        repair_job_id: jobId, name: f.name, file_url: f.file_url, is_image: f.is_image,
      })));
      setRepairs((prev) => prev.map((r) => (r.id === jobId ? { ...r, files: [...(r.files || []), ...created] } : r)));
    } catch { flagSaveErr(); }
  });
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
    // See toIsoDate above: booking_date is always a string, and a raw Date here crashed the render.
    const date = toIsoDate(dateStr);
    setMurbahOpps((prev) => prev.map((m) => (m.id === id ? { ...m, booking_date: date } : m)));
    debouncedSave(`murbah-date-${id}`, async () => {
      try { await base44.entities.DeckMurbahOpportunity.update(id, { booking_date: date }); } catch { flagSaveErr(); }
    });
  };
  // The money half — price, deposit paid, fully paid, and the end of the range. One handler, because
  // they are edited together and share a debounce.
  //
  // `price` arrives as the raw input string, so it is normalised here: an empty box means "no price"
  // (null), never NaN and never 0 — a booking at zero and a booking with no price agreed are
  // different facts, and only one of them should show as £0. A half-typed number is dropped rather
  // than stored, so "1e" or "-" mid-keystroke cannot become a value.
  const updateMurbahMoney = (id, patch) => {
    const clean = { ...patch };
    if ('price' in clean) {
      const { ok, value } = normalizePrice(clean.price);
      if (!ok) return; // a keystroke in progress, not a value — store nothing
      clean.price = value;
    }
    if ('end_date' in clean) clean.end_date = toIsoDate(clean.end_date);
    setMurbahOpps((prev) => prev.map((m) => (m.id === id ? { ...m, ...clean } : m)));
    debouncedSave(`murbah-money-${id}`, async () => {
      try { await base44.entities.DeckMurbahOpportunity.update(id, clean); } catch { flagSaveErr(); }
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
  const addStrategy = (text) => guardAdd('strategy', async () => {
    if (!text.trim()) return;
    try {
      const created = await base44.entities.DeckStrategyNote.create({ text: text.trim() });
      setStrategy((prev) => [created, ...prev]);
    } catch { flagSaveErr(); }
  });
  const removeStrategy = async (id) => {
    setStrategy((prev) => prev.filter((s) => s.id !== id));
    try { await base44.entities.DeckStrategyNote.delete(id); } catch { flagSaveErr(); }
  };
  const addKnowledge = (text) => guardAdd('knowledge', async () => {
    if (!text.trim()) return;
    try {
      const created = await base44.entities.DeckKnowledgeNote.create({ text: text.trim() });
      setKnowledge((prev) => [created, ...prev]);
    } catch { flagSaveErr(); }
  });
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

  // Attachments on a stream — a bill, a scan, a photo. The files arrive already uploaded (the widget
  // uses the same uploadFile() every other Deck photo does), so this only records them, exactly as the
  // repair files do. `describeUpload` decides is_image, because guessing the other way round shows a
  // broken <img> where a document icon would have been merely plain.
  const addLifeFiles = (streamKey, uploadedFiles) => guardAdd(`lifeFiles:${streamKey}`, async () => {
    const stream = lifeStreams[streamKey];
    if (!stream || !uploadedFiles?.length) return;
    try {
      const created = await Promise.all(uploadedFiles.map((f) => base44.entities.DeckLifeFile.create({
        life_stream_id: stream.id,
        file_url: f.file_url,
        file_name: f.file_name,
        file_type: f.file_type,
        is_image: f.is_image,
      })));
      setLifeStreams((prev) => ({ ...prev, [streamKey]: { ...stream, files: [...created, ...(stream.files || [])] } }));
    } catch { flagSaveErr(); }
  });
  const removeLifeFile = async (streamKey, fileId) => {
    const stream = lifeStreams[streamKey];
    if (!stream) return;
    setLifeStreams((prev) => ({ ...prev, [streamKey]: { ...stream, files: (stream.files || []).filter((f) => f.id !== fileId) } }));
    try { await base44.entities.DeckLifeFile.delete(fileId); } catch { flagSaveErr(); }
  };

  // ---- inbox -------------------------------------------------------------
  const addInbox = () => guardAdd('inbox', async () => {
    if (!iForm.message.trim()) return;
    try {
      const created = await base44.entities.DeckInboxItem.create({
        channel: iForm.channel, from_name: iForm.from.trim() || '—', message: iForm.message.trim(), stage: 'new',
      });
      setInbox((prev) => [created, ...prev]);
      setIForm({ channel: iForm.channel, from: '', message: '' });
    } catch { flagSaveErr(); }
  });
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
    setReplyDraftErr(null);
    setReplyBusy(true);
    try {
      const { data } = await base44.functions.invoke('suggestDeckReply', { inboxItemId });
      const draft = (data?.reply || '').trim();
      if (!draft) {
        // Belt and braces: the server refuses an empty draft now, but the frontend and the
        // server deploy independently, so a stale server can still answer with one.
        setReplyDraftErr('Jarvis came back with an empty draft — ask again.');
        return;
      }
      setReplyDraftText(draft);
    } catch (err) {
      // Deliberately NOT flagSaveErr(): nothing was being saved, and "couldn't save last
      // change — try again" sent the operator hunting for a storage fault. The message is
      // the failure's own, and it stays on screen beside the empty box.
      setReplyDraftErr(err?.message || 'Could not draft a reply just now — ask again.');
      console.error(err);
    } finally {
      setReplyBusy(false);
    }
  };
  const cancelReplyDraft = () => {
    setReplyDraftFor(null);
    setReplyDraftText('');
    setReplyDraftErr(null);
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

  // Returns whether the server had to DROP the fee fields to make the save succeed — the H11
  // fallback, before the fee_* migration has been applied (server/src/lib/deckProfileColumns.js).
  // The marker is stripped out of the profile state (it is not a column) and handed back instead of
  // being swallowed, because a save whose fee structure vanished must not read as a plain success.
  const saveBusinessProfile = async (fields) => {
    setBusinessProfileBusy(true);
    let feeFieldsDropped = false;
    try {
      const saved = businessProfile?.id
        ? await base44.entities.DeckBusinessProfile.update(businessProfile.id, fields)
        : await base44.entities.DeckBusinessProfile.create(fields);
      feeFieldsDropped = saved?.fee_fields_dropped === true;
      if (saved && typeof saved === 'object') {
        const row = { ...saved };
        delete row.fee_fields_dropped;
        setBusinessProfile(row);
      } else {
        setBusinessProfile(saved);
      }
    } catch { flagSaveErr(); }
    setBusinessProfileBusy(false);
    return { feeFieldsDropped };
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
  const addCalendarEvent = () => guardAdd('calendar', async () => {
    if (!calendarForm.summary.trim() || !calendarForm.date) return;
    setCalendarBusy(true);
    try {
      await base44.functions.invoke('addDeckCalendarEvent', { summary: calendarForm.summary.trim(), date: calendarForm.date });
      setCalendarForm({ summary: '', date: '' });
      await loadCalendarEvents();
    } catch { flagSaveErr(); }
    setCalendarBusy(false);
  });

  // ---- jarvis ------------------------------------------------------------
  // fileUrls: photos/PDFs/Word/Excel attached via DeckJarvis.jsx's paperclip
  // button (uploaded through the same uploadFile() every other Deck photo
  // upload already uses). The optimistic bubble shows the attached filenames
  // the same lightweight way chatWithJarvis.js itself persists them, so the
  // UI and the actual saved history never disagree about what was attached.
  //
  // 2026-10-04 — this goes through `invokeStream`, not `invoke`. The body carries `stream: true`, which
  // is the negotiation chatWithJarvis requires (a caller that sends no such field still gets today's
  // plain JSON), and the streamed `stage`/`delta` events are reduced into `jarvisLive` as they arrive.
  // `invokeStream` also resolves a plain JSON body from a server that does not stream, so the frontend
  // and the backend can deploy in either order.
  const sendJarvisMessage = async (fileUrls = []) => {
    const text = jarvisInput.trim();
    if ((!text && fileUrls.length === 0) || jarvisSending) return;
    const attachedNote = fileUrls.length ? `\n[attached: ${fileUrls.map((u) => decodeURIComponent(u.split('/').pop().split('?')[0])).join(', ')}]` : '';
    const optimisticUser = { id: `local-${Date.now()}`, role: 'user', content: `${text}${attachedNote}`.trim() };
    setJarvisMessages((prev) => [...prev, optimisticUser]);
    setJarvisInput('');
    setJarvisSending(true);
    setJarvisErr(false);
    const turnId = `local-${Date.now()}-turn`;
    setJarvisLive(initialJarvisLive(turnId));
    try {
      const { data } = await base44.functions.invokeStream(
        'chatWithJarvis',
        { message: text, fileUrls, stream: true },
        null,
        (evt) => setJarvisLive((live) => reduceJarvisEvent(live, evt)),
      );
      // The terminal event's reply is the AUTHORITY — it is what was stored, which is not always the
      // last fragment (the length budget's repair pass can shorten it after it has already streamed).
      const reply = typeof data?.reply === 'string' ? data.reply : '';
      const replyId = `local-${Date.now()}-r`;
      setJarvisMessages((prev) => [...prev, { id: replyId, role: 'jarvis', content: reply }]);
      // `replyId` is what tells DeckJarvis.jsx this reply was ALREADY spoken sentence by sentence, so the
      // whole-message auto-speak must not say it a second time.
      setJarvisLive((live) => ({ ...(live || initialJarvisLive(turnId)), done: true, label: null, etaSeconds: null, text: reply, replyId, error: null }));
    } catch (err) {
      setJarvisErr(true);
      // The server's own words when it sent a terminal `error` event (e.g. "Jarvis was cut off…"), and
      // the old generic line only for a connection that never got that far. A raw provider error is
      // never what the operator needs to read (UI feedback rule 5).
      setJarvisLive((live) => ({
        ...(live || initialJarvisLive(turnId)),
        done: true, label: null, etaSeconds: null,
        error: typeof err?.message === 'string' && err.message ? err.message : "Couldn't reach Jarvis that time — give it another go.",
      }));
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

  // The dump widget asks for its own flag by name; every other form reads `addPending[key]`.
  // Both come from the one guard above, so there is no second source of truth for "is an add
  // still in flight".
  const value = {
    loaded, saveErr, addPending,
    dump, dumpInput, setDumpInput, dumpPending: !!addPending.dump, quickFileMsg, dumpError, detectOwner, addDump, removeDump, promoteDump,
    tasks, taskInput, setTaskInput, taskOwner, setTaskOwner, taskEnergy, setTaskEnergy, openOwner, setOpenOwner,
    addTask, toggleTask, removeTask,
    people, personForm, setPersonForm, managePeople, setManagePeople, addPerson, updatePersonPhone, updatePersonEmail, updatePersonName, removePerson,
    energy, energyHistory, focusTask, setEnergyLevel, saveFocus,
    openStream, setOpenStream, consignment, repairs, murbahOpps,
    cForm, setCForm, addConsignment, toggleSold, updateConsignment, removeConsignment,
    rForm, setRForm, addRepair, updateRepair, cycleRepairStage, removeRepair, addFilesToJob, removeFileFromJob,
    cycleMurbahStage, updateMurbahNote, updateMurbahDate, updateMurbahMoney, syncMurbahCalendar, murbahSyncBusy, murbahSyncMsg,
    murbahCalendarEvents, murbahEventsLoading, loadMurbahCalendarEvents,
    strategy, knowledge, addStrategy, removeStrategy, addKnowledge, removeKnowledge,
    inbox, iForm, setIForm, addInbox, cycleInboxStage, removeInbox,
    gmailSyncing, gmailSyncMsg, syncGmailInbox,
    replyDraftFor, replyDraftText, setReplyDraftText, replyBusy, replyDraftErr, startReplyDraft, cancelReplyDraft, sendReplyDraft,
    lifeStreams, toggleLifeStatus, addLifeNote, removeLifeNote, addLifeFiles, removeLifeFile,
    lightboxImg, setLightboxImg,
    confirmDeleteState, askToDelete, resolveConfirmDelete,
    backupText, backupBusy, backupMsg, runExport, copyBackup, downloadBackup,
    driveBackupBusy, driveBackupMsg, driveRestoreBusy, driveRestoreMsg, lastBackupAt, driveBackup, driveRestore,
    vaultStatus, vaultBusy, checkVault,
    jarvisMessages, jarvisInput, setJarvisInput, jarvisSending, jarvisErr, sendJarvisMessage, jarvisLive,
    synthesisBusy, synthesisErr, runJarvisSynthesis, lastSynthesis,
    docBusy, docErr, docResult, createDeckDocument,
    uploadFile,
    widgetInstances, toggleWidget, moveWidget, deleteWidget,
    widgetBuild, dismissWidgetBuild,
    businessProfile, businessProfileBusy, saveBusinessProfile, feeTiers,
    calendarEvents, calendarLoading, calendarForm, setCalendarForm, calendarBusy, loadCalendarEvents, addCalendarEvent,
  };

  return (
    <CommandDeckContext.Provider value={value}>
      {children}
      {/* The Asteroids reward, opened by ticking a task off. Rendered by the provider rather than a
          widget so it survives whichever tab or widget set the account has enabled. */}
      {playOpen && (
        <PlayModal
          seconds={bankSeconds(playCredits, playScores)}
          initials={playInitials}
          scores={playScores}
          meId={meId}
          onClose={() => setPlayOpen(false)}
          onSubmitScore={submitPlayScore}
        />
      )}
    </CommandDeckContext.Provider>
  );
}
