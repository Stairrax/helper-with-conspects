import fs from 'node:fs/promises';
import vm from 'node:vm';
import { ROOT } from './lib.mjs';
import path from 'node:path';

export default async ({ ok }) => {
  const sw = await fs.readFile(path.join(ROOT, 'sw.js'), 'utf8');
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const version = sw.match(/const VERSION = 'kd-v(\d+)'/)[1];
  const name = 'kd-v' + version;
  const old = 'kd-v1';
  const names = [old, name, 'kd-cdn', 'kd-voices', 'kd-fonts', 'kd-meta', 'other-app-v1', 'kd-v-not-ours'];
  const removed = [];
  const events = {};
  const opened = [];
  const origin = 'https://example.test';
  const scope = origin + '/helper-with-conspects/';
  const current = new Response('current shell');
  let claimed = false;
  vm.runInNewContext(sw, {
    URL, Request, Response,
    fetch: async () => { throw new Error('offline'); },
    caches: {
      keys: async () => names,
      delete: async k => { removed.push(k); return true; },
      match: async () => { throw new Error('global cache lookup must not be used'); },
      open: async k => {
        opened.push(k);
        return { match: async () => current };
      },
    },
    self: {
      location: { origin },
      registration: { scope },
      clients: { claim: async () => { claimed = true; } },
      addEventListener: (type, handler) => { events[type] = handler; },
    },
  });
  let activation;
  events.activate({ waitUntil(promise) { activation = promise; } });
  await activation;
  ok(claimed && removed.length === 1 && removed[0] === old,
    'activation removes only obsolete numeric Konspekt shell caches');
  const request = (url, mode = 'cors') => {
    let response;
    events.fetch({ request: { method: 'GET', url, mode }, respondWith(promise) { response = promise; } });
    return response;
  };
  ok(request(origin + '/other-app/index.html') === undefined,
    'worker does not intercept other same-origin applications');
  const offline = await request(scope + 'js/app.js?v=' + version);
  ok(offline === current && opened.every(k => k === name), 'offline fallback reads the current shell only');
  const mismatched = await request(scope + 'js/app.js?v=1');
  ok(mismatched.type === 'error', 'offline fallback refuses a module from a different version');
  ok(html.includes('getRegistration(location.href)') && !html.includes('getRegistrations()'),
    'boot recovery updates only the application registration');
  ok(html.includes('/^kd-v\\d+$/'), 'boot recovery does not clear unrelated cache names');
};
