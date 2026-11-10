// API contract checks for the localhost backup. Never contacts an AI provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackupLab } from './backup-lab.mjs';

async function withLab(fn) {
  const { server, url } = await startBackupLab({ port: 0, mode: 'mock' });
  try { await fn(url); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const origin = 'http://127.0.0.1:8080';
const payload = { model: 'auto', messages: [{ role: 'user', content: 'проверка' }] };
const post = (url, body = payload, headers = {}) => fetch(url + '/v1/chat/completions', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer local-test-device', ...headers },
  body: JSON.stringify(body),
});

test('mock server responds on localhost and exposes compatible health and model routes', async () => {
  await withLab(async url => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(await (await fetch(url)).text(), /local test only/);
    const health = await (await fetch(url + '/health')).json();
    assert.deepEqual({ ok: health.ok, mode: health.mode, localOnly: health.localOnly, cloudCostUsd: health.cloudCostUsd },
      { ok: true, mode: 'mock', localOnly: true, cloudCostUsd: 0 });
    const models = await (await fetch(url + '/v1/models')).json();
    assert.equal(models.data[0].id, 'auto');
  });
});

test('returns OpenAI-compatible nonstream and SSE stream replies', async () => {
  await withLab(async url => {
    const res = await post(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    const json = await res.json();
    assert.match(json.choices[0].message.content, /ТЕСТОВЫЙ ОТВЕТ/);
    assert.equal(json.choices[0].finish_reason, 'stop');
    const streamed = await post(url, { ...payload, stream: true });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
    const sse = await streamed.text();
    assert.match(sse, /"delta":\{"content":/);
    assert.match(sse, /data: \[DONE\]/);
  });
});

test('CORS rejects unrelated origins and never enables production-site calls', async () => {
  await withLab(async url => {
    const bad = await post(url, payload, { Origin: 'https://stairrax.github.io' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const ok = await fetch(url + '/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), origin);
  });
});

test('rejects nontext, invalid formats and nonexistent endpoints', async () => {
  await withLab(async url => {
    const photo = await post(url, { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] });
    assert.equal(photo.status, 422);
    assert.equal((await photo.json()).error.code, 'text_only');
    const broken = await fetch(url + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{no',
    });
    assert.equal(broken.status, 400);
    assert.equal((await fetch(url + '/other')).status, 404);
  });
});

test('a local request cap prevents unlimited model calls', async () => {
  await withLab(async url => {
    for (let i = 0; i < 10; i++) assert.equal((await post(url)).status, 200);
    const blocked = await post(url);
    assert.equal(blocked.status, 429);
    const json = await blocked.json();
    assert.equal(json.error.code, 'daily_limit');
    assert.equal(json.error.proxy, true);
  });
});

test('refuses public-bind options and unknown model backends', async () => {
  await assert.rejects(startBackupLab({ mode: 'other', port: 0 }), /BACKUP_LAB_MODE/);
  await assert.rejects(startBackupLab({ port: -1 }), RangeError);
});
