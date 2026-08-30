/**
 * Batches a guest's rapid-fire messages into one combined intent, and separately
 * schedules a delayed send that a staff member's manual reply can cancel.
 *
 * CRITICAL: every wait in this file is a per-jid setTimeout stored in a Map — never
 * a blocking `await sleep()` in a shared handler. A blocking sleep in the main
 * message handler previously stalled ALL guests' conversations system-wide on
 * OpenClaw; this design keeps every guest's timers fully independent.
 */

export class Debouncer {
  /**
   * @param {number} debounceMs
   * @param {(jid: string, batch: Array) => void} onReady called once a guest has
   *   been quiet for debounceMs, with all messages collected since the last batch.
   */
  constructor(debounceMs, onReady) {
    this.debounceMs = debounceMs;
    this.onReady = onReady;
    this.buffers = new Map(); // jid -> { messages: [], timer }
  }

  /** Add a message to the guest's pending batch and reset their quiet-timer. */
  push(jid, message) {
    let entry = this.buffers.get(jid);
    if (!entry) {
      entry = { messages: [], timer: null };
      this.buffers.set(jid, entry);
    }
    entry.messages.push(message);

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const batch = entry.messages;
      this.buffers.delete(jid);
      this.onReady(jid, batch);
    }, this.debounceMs);
  }
}

export class DelayedReplyScheduler {
  /** @param {number} replyDelayMs */
  constructor(replyDelayMs) {
    this.replyDelayMs = replyDelayMs;
    this.pending = new Map(); // key -> timer (one reply may be registered under several JID aliases)
  }

  /**
   * Schedule sendFn to run after the delay, unless cancelled first.
   *
   * @param {string|string[]} keys one or more JIDs identifying this chat. WhatsApp
   *   may address the same conversation by a LID (`@lid`) or by the real phone
   *   JID (`@s.whatsapp.net`); registering under every known alias means a
   *   cancel arriving under EITHER form still finds this timer.
   * @param {() => Promise<any>} sendFn
   * @param {() => boolean} [shouldSend] re-checked immediately before sending.
   *   Return false to skip the send (e.g. a human replied in the meantime).
   *   This is a second line of defence: cancel() handles the normal case, but
   *   this catches anything cancel() missed, including a staff reply that
   *   arrived under a JID alias we hadn't seen yet.
   */
  schedule(keys, sendFn, shouldSend = () => true) {
    const keyList = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    for (const k of keyList) this.cancel(k); // a fresh reply supersedes any still-pending one

    const timer = setTimeout(async () => {
      for (const k of keyList) this.pending.delete(k);
      try {
        if (!shouldSend()) {
          console.log(`[scheduler] send SKIPPED for ${keyList[0]} - human replied, bot staying silent`);
          return;
        }
        await sendFn();
      } catch (err) {
        console.error(`[scheduler] send failed for ${keyList[0]}:`, err);
      }
    }, this.replyDelayMs);

    for (const k of keyList) this.pending.set(k, timer);
  }

  /** Cancel a guest's queued reply (e.g. staff replied manually first). Safe to call if nothing pending. */
  cancel(key) {
    const timer = this.pending.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    // Drop every alias pointing at this same timer, not just the one matched.
    for (const [k, t] of this.pending) {
      if (t === timer) this.pending.delete(k);
    }
    return true;
  }
}
