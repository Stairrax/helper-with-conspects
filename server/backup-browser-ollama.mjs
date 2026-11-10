// Optional end-to-end LOCAL integration: PWA -> backup lab -> Ollama.
// Requires installed Chromium (Playwright) and an already running Ollama.
// Does NOT call Cloudflare, OpenRouter, Google Cloud or any paid service.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, makeOpen } from '../tests/lib.mjs';
import { startBackupLab } from './backup-lab.mjs';

const model = process.env.MODEL_NAME || 'qwen2.5:0.5b';
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 180_000);
let browser;
let context;
let site;
let lab;

async function verifyOllama() {
  if (!model || model.length > 100) throw new Error('Invalid MODEL_NAME');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new Error('MODEL_TIMEOUT_MS must be between 1000 and 600000');
  }
  const response = await fetch('http://127.0.0.1:11434/api/tags', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Ollama returned HTTP ' + response.status);
  const { models } = await response.json();
  if (!Array.isArray(models) || !models.some(item => item.name === model)) {
    throw new Error('Model ' + model + ' is not installed. Run: ollama list');
  }
}

try {
  await verifyOllama();
  site = await startServer(0);
  lab = await startBackupLab({ port: 0, mode: 'ollama', model });
  browser = await chromium.launch({ headless: true });

  // Reuse the application's existing browser setup. Its network mocks cover
  // external AI providers, NOT the 127.0.0.1 backup lab used in this test.
  const open = await makeOpen(browser, site.base);
  const opened = await open({ freeProxy: lab.url, settings: { provider: 'free' } });
  context = opened.ctx;
  const { page, errors } = opened;

  const apiResponses = [];
  page.on('response', response => {
    if (response.url() === lab.url + '/chat/completions') {
      apiResponses.push({
        status: response.status(),
        contentType: response.headers()['content-type'] || '',
      });
    }
  });

  console.log('Live browser check: application -> ' + lab.url + ' -> Ollama (' + model + ')');
  console.log('Sending two short, text-only requests. No clouds or API keys are used.');
  const result = await page.evaluate(async (deadline) => {
    const ai = await import('/js/ai.js');
    const settings = JSON.parse(localStorage.getItem('kd.settings'));
    const options = ai.conn(settings, 'question');
    const input = {
      system: 'Отвечай по-русски одним коротким предложением.',
      parts: [{ text: 'Для чего нужен резервный сервер?' }],
      maxOutputTokens: 100,
    };
    const jsonText = await ai.generate({
      ...options, ...input, retries: 0, timeoutMs: deadline,
    });
    const pieces = [];
    await ai.stream({
      ...options, ...input, timeoutMs: deadline,
      onText: text => pieces.push(text),
    });
    return { selectedUrl: options.baseUrl, jsonText, streamedText: pieces.join(''), pieces: pieces.length };
  }, timeoutMs);

  const health = await (await fetch(lab.url + '/health')).json();
  assert.equal(result.selectedUrl, lab.url, 'PWA must use the local backup address');
  assert.equal(health.mode, 'ollama', 'Backup must actually use Ollama, not mock mode');
  assert.ok(health.requestsAccepted >= 2, 'Backup must handle two real requests');
  assert.ok(result.jsonText.trim(), 'Non-streamed answer must contain text');
  assert.ok(result.streamedText.trim(), 'Streamed answer must contain text');
  assert.ok(result.pieces > 0, 'PWA must receive text from the stream callback');
  assert.ok(!result.jsonText.includes('[ТЕСТОВЫЙ ОТВЕТ'), 'Must not return the mock answer');
  assert.equal(apiResponses.length, 2, 'Expect one JSON and one SSE request, without fallback retries');
  assert.ok(apiResponses.every(response => response.status === 200), 'Both requests must be successful');
  assert.ok(apiResponses.some(response => response.contentType.includes('application/json')), 'JSON reply missing');
  assert.ok(apiResponses.some(response => response.contentType.includes('text/event-stream')), 'SSE reply missing');
  assert.deepEqual(errors, [], 'Browser should report no JavaScript errors');

  console.log('Non-streamed answer: ' + result.jsonText.slice(0, 250));
  console.log('Streamed answer:     ' + result.streamedText.slice(0, 250));
  console.log('PASS: PWA -> local backup -> Ollama; JSON and SSE worked in Chromium.');
} catch (error) {
  console.error('FAIL: ' + (error.message || String(error)));
  console.error('Check Ollama, "ollama list", Playwright Chromium and your active test branch.');
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (site) await new Promise(resolve => site.server.close(resolve));
  if (lab) await new Promise(resolve => lab.server.close(resolve));
}
