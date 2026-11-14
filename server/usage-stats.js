// Anonymous usage counters for the author's free proxy.
// Never store a user's study text, API keys, raw IP address or device ID.
// Per-day HMACs cannot be joined across days, and are removed after 40 days.
const DAY_MS = 86400000;
const KEEP_DAYS = 40;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const validDevice = (device) => /^kd-[0-9a-f]{24}$/.test(device || '');
const emptyDay = () => ({ requests: 0, devices: [], notes: 0, questions: 0 });

export class UsageStats {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    if (body.action === 'signal') {
      return Response.json({ observed: !!(await this.storage.get('first:at')) });
    }
    if (body.action === 'days') {
      const now = Date.now(), days = [];
      for (let i = 29; i >= 0; i--) {
        const day = dayOf(now - i * DAY_MS);
        const row = await this.storage.get('day:' + day) || emptyDay();
        days.push({
          day, requests: row.requests || 0, devices: row.devices?.length || 0,
          notes: row.notes || 0, questions: row.questions || 0,
        });
      }
      return Response.json({ timezone: 'UTC', days, observed: !!(await this.storage.get('first:at')) });
    }
    if (body.action !== 'success' || !validDevice(body.device) ||
        !['notes', 'question'].includes(body.purpose)) {
      return Response.json({ counted: false }, { status: 400 });
    }
    const day = dayOf(Date.now());
    // Generate the HMAC key once, atomically. It never leaves this Durable Object.
    const salt = await this.storage.transaction(async (tx) => {
      let v = await tx.get('private:hmac-key');
      if (!v) {
        v = hex(crypto.getRandomValues(new Uint8Array(32)));
        await tx.put('private:hmac-key', v);
      }
      return v;
    });
    const key = await crypto.subtle.importKey(
      'raw', Uint8Array.from(salt.match(/../g), h => parseInt(h, 16)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const digest = hex(new Uint8Array(await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(day + ':' + body.device),
    )));
    await this.storage.transaction(async (tx) => {
      const row = await tx.get('day:' + day) || emptyDay();
      row.requests++;
      if (!row.devices.includes(digest)) row.devices.push(digest);
      if (body.purpose === 'question') row.questions++;
      else row.notes++;
      await tx.put('day:' + day, row);
      if (!await tx.get('first:at')) await tx.put('first:at', new Date().toISOString());
    });
    if (!await this.storage.getAlarm()) await this.storage.setAlarm(Date.now() + DAY_MS);
    return Response.json({ counted: true });
  }

  async alarm() {
    const cutoff = dayOf(Date.now() - KEEP_DAYS * DAY_MS);
    const old = await this.storage.list({ prefix: 'day:' });
    for (const key of old.keys()) {
      if (key.slice(4) < cutoff) await this.storage.delete(key);
    }
    // Stop waking a dormant application once everything has expired.
    if ((await this.storage.list({ prefix: 'day:' })).size) {
      await this.storage.setAlarm(Date.now() + DAY_MS);
    }
  }
}

async function sendUsage(env, action, args = {}) {
  if (!env.USAGE_STATS) return null;
  const ns = env.USAGE_STATS;
  const stub = ns.get(ns.idFromName('global'));
  const response = await stub.fetch('https://usage.internal/', {
    method: 'POST', body: JSON.stringify({ action, ...args }),
  });
  if (!response.ok) throw new Error('Usage stats unavailable');
  return response.json();
}

export const recordSuccessfulUsage = (env, device, purpose) =>
  sendUsage(env, 'success', { device, purpose });
export const readUsageDays = (env) => sendUsage(env, 'days');
export const readUsageSignal = (env) => sendUsage(env, 'signal');
