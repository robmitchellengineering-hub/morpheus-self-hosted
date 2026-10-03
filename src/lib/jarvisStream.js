// The live state of a Jarvis turn, reduced from the events `chatWithJarvis` streams.
//
// WHY THIS EXISTS (2026-10-04, Rob: *"i think the problem is it doesnt look like its doing anything
// ... i want to see it earlier and being written"*). Two things were invisible before this change: the
// deck showed the constant string "Jarvis is thinking…" for as long as the model took — no step name,
// no clock, nothing moving — and the reply itself arrived in one piece at the very end. The server now
// streams `{type:'stage'}` events for what it is doing and `{type:'delta'}` events for the words as they
// are written; this module is the client's half of that, as a pure reducer so it can be tested without a
// browser, a server or a model (`scripts/verify-jarvis-stream.mjs`).
//
// KEEPING IT HONEST. Every field here is something the server actually said:
//   * `label`/`etaSeconds` come from a real stage event (the ETA is the deployment's own measured
//     average latency for that role — lib/timingStats.js — never an invented countdown);
//   * `startedAt` is a client clock, used only to tick "12s" — a number that is always true;
//   * `text` is the reply so far, fragment by fragment, and it is REPLACED by the terminal event's
//     `data.reply`, because the stored reply is the authority — a dropped final chunk must not leave a
//     UI showing something the database never got.
//
// The reducer never throws and never mutates: an event it does not recognize (a `ping`, a field from a
// newer server) leaves the state exactly as it was, which is what makes a frontend deploy and a backend
// deploy free to happen in either order.

/** A fresh live state for one turn. `turnId` is what the speech path binds a speaking session to. */
export function initialJarvisLive(turnId, now = Date.now()) {
  return {
    turnId,
    label: null,
    etaSeconds: null,
    // When the CURRENT step started (for "~8s remaining"), and when the whole turn started (for the
    // total clock). Two clocks, because a three-step turn would otherwise reset its own elapsed time.
    stepStartedAt: now,
    startedAt: now,
    text: '',
    done: false,
    error: null,
  };
}

/**
 * One parsed NDJSON event → the next live state.
 *
 * @param {object} live as returned by initialJarvisLive
 * @param {object} evt {type:'stage'|'delta'|'result'|'error'|'ping', ...}
 * @param {number} [now] injectable clock, so a test can assert exact elapsed seconds
 */
export function reduceJarvisEvent(live, evt, now = Date.now()) {
  if (!live || !evt || typeof evt !== 'object' || Array.isArray(evt)) return live;

  if (evt.type === 'stage') {
    if (evt.status === 'start') {
      return {
        ...live,
        label: typeof evt.label === 'string' && evt.label ? evt.label : live.label,
        etaSeconds: Number.isFinite(evt.etaSeconds) ? evt.etaSeconds : null,
        stepStartedAt: now,
      };
    }
    if (evt.status === 'done') return { ...live, label: null, etaSeconds: null };
    return live; // 'progress' — the growing text is the progress; the label stands.
  }

  if (evt.type === 'delta') {
    if (typeof evt.text !== 'string' || !evt.text) return live;
    return { ...live, text: live.text + evt.text };
  }

  if (evt.type === 'result') {
    const reply = evt.data?.reply;
    return {
      ...live,
      done: true,
      label: null,
      etaSeconds: null,
      // The terminal payload wins over the accumulated fragments — it is what was STORED.
      ...(typeof reply === 'string' ? { text: reply } : {}),
    };
  }

  if (evt.type === 'error') {
    return {
      ...live,
      done: true,
      label: null,
      etaSeconds: null,
      error: typeof evt.message === 'string' && evt.message ? evt.message : 'Jarvis could not answer.',
    };
  }

  return live; // 'ping', or anything a newer server sends
}

/** Seconds since the turn started — the always-true number under the label. */
export function jarvisElapsedSeconds(live, now = Date.now()) {
  if (!live?.startedAt) return 0;
  return Math.max(0, Math.round((now - live.startedAt) / 1000));
}

/**
 * Seconds left on the CURRENT step from the server's own ETA, or null when there is no estimate to show
 * (nothing running, or a server that sent none). Null means "show nothing" rather than a zero.
 */
export function jarvisRemainingSeconds(live, now = Date.now()) {
  if (!live || !Number.isFinite(live.etaSeconds) || !live.stepStartedAt) return null;
  return Math.max(0, Math.round(live.etaSeconds - (now - live.stepStartedAt) / 1000));
}

/** `9s` / `1m 05s`. Same shape as the Morpheus chat's own pipeline clock, so the two read alike. */
export function formatElapsed(totalSeconds) {
  const clamped = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (clamped < 60) return `${clamped}s`;
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
