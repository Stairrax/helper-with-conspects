// Optional LOCAL experiment. Real study plan + dictation chunks through Ollama 7B.
// No cloud, paid API or real student data. Run manually, never in CI.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, makeOpen } from '../tests/lib.mjs';
import { startBackupLab } from './backup-lab.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.MODEL_NAME || 'qwen2.5:7b';
const OUTPUT_TOKENS = Number(process.env.LOCAL_OUTPUT_TOKENS || 1536);
const argv = process.argv.slice(2);
const id = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;
if (argv.includes('--case') && !id) throw Error('Use --case physics-ru (or another case ID)');
if (!/^[\w.:+-]{1,100}$/.test(MODEL)) throw Error('Invalid MODEL_NAME');
if (!Number.isSafeInteger(OUTPUT_TOKENS) || OUTPUT_TOKENS < 128 || OUTPUT_TOKENS > 2048) {
  throw Error('LOCAL_OUTPUT_TOKENS must be 128..2048');
}
const fixtures = JSON.parse(await readFile(new URL('../tests/quality/cases.json', import.meta.url), 'utf8'));
const cases = fixtures.cases.filter(c => !id || c.id === id);
if (!cases.length) throw Error('Unknown case ID: ' + id);
const destination = path.join(ROOT, 'reports', 'quality-ollama', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(destination, { recursive: true });
const saved = (name, data) => writeFile(path.join(destination, name), data, { flag: 'wx' });
const asJson = data => JSON.stringify(data, null, 2) + '\n';
const summary = { model: MODEL, localOnly: true, outputTokens: OUTPUT_TOKENS, cases: [] };
let browser, site, failures = 0;

async function checkOllama() {
  const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
  assert.ok(res.ok, 'Ollama is not running on 127.0.0.1:11434');
  const data = await res.json();
  assert.ok(data.models?.some(m => m.name === MODEL), 'Not installed: ' + MODEL + '. Check ollama list');
}

async function runCase(item, open) {
  // New isolated localhost instance per case so one failure cannot exhaust the next case's quota.
  const lab = await startBackupLab({ port: 0, mode: 'ollama', model: MODEL,
    maxOutputTokens: OUTPUT_TOKENS, perDeviceLimit: 30, totalLimit: 40 });
  let ctx, result;
  const started = Date.now();
  try {
    const opened = await open({ freeProxy: lab.url, settings: {
      provider: 'free', contentLang: item.lang, coverageCheck: false,
      formulasApart: false, selfCheck: false,
    } });
    ctx = opened.ctx;
    console.log('[' + item.id + '] Generating real plan and dictation with ' + MODEL);
    const generated = await opened.page.evaluate(async ({ item, endpoint }) => {
      const { analyze, generateTopicChunks } = await import('/js/analyze.js');
      const { conn } = await import('/js/ai.js');
      const settings = JSON.parse(localStorage.getItem('kd.settings'));
      const baseUrl = conn(settings, 'notes').baseUrl;
      let step = 'plan', project = null, error = null;
      const events = [];
      const log = message => { if (events.length < 50) events.push(String(message).slice(0, 250)); };
      try {
        if (endpoint !== baseUrl) throw Error('Unexpected AI endpoint; must be localhost');
        project = await analyze({
          sources: [{ id: item.id, name: item.title, kind: 'text', text: item.source }],
          budgetMin: 15, priority: 'original', settings, log,
        });
        step = 'dictation';
        for (const t of project.topics) {
          await generateTopicChunks(t, settings, log);
          t.status = 'ready';
        }
        step = 'done';
      } catch (e) {
        error = { code: e.code || null, message: String(e.message || e).slice(0, 450) };
      }
      return { step, error, events, baseUrl, topics: (project?.topics || []).map(t => ({
        title: t.title, text: t.text, difficulty: t.difficulty, status: t.status,
        chunks: t.chunks, points: t.points, formulas: t.formulas, recap: t.recap, quiz: t.quiz,
      })) };
    }, { item, endpoint: lab.url });
    const health = await (await fetch(lab.url + '/health')).json();
    assert.equal(generated.baseUrl, lab.url, 'Browser changed the proxy');
    assert.equal(health.mode, 'ollama', 'Mock mode is not a real quality test');
    const notes = generated.topics.flatMap(t => [
      '# ' + t.title,
      ...(t.chunks || []).map(c => c.t),
      (t.formulas || []).length ? 'Формулы:\n' +
        t.formulas.map(f => [f.f, f.d].filter(Boolean).join(' — ')).join('\n') : '',
    ]).filter(Boolean).join('\n\n');
    result = {
      case: item.id, model: MODEL, step: generated.step, error: generated.error,
      requestsAccepted: health.requestsAccepted, seconds: Math.round((Date.now()-started)/1000),
      browserErrors: opened.errors, externalProviderMockRequests: opened.ai.prompts.length,
      topics: generated.topics, events: generated.events,
    };
    result.ok = generated.step === 'done' && generated.topics.length > 0 &&
      generated.topics.every(t => t.chunks?.length > 0) && health.requestsAccepted > 0 &&
      !opened.ai.prompts.length && !opened.errors.length;
    await saved(item.id + '.md', notes + '\n');
    await saved(item.id + '.json', asJson(result));
    if (result.ok) {
      const proc = spawnSync(process.execPath, [
        path.join(ROOT, 'tests/quality/evaluate.mjs'), '--case', item.id,
        '--answer', path.join(destination, item.id + '.md'),
        '--report', path.join(destination, item.id + '-review.json'),
      ], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
      if (proc.status !== 0) console.warn('[' + item.id + '] Marker checklist could not be created: ' + proc.stderr);
      console.log('[' + item.id + '] Saved real dictation and review draft; human accuracy review is required.');
    } else {
      failures++;
      console.error('[' + item.id + '] Incomplete: ' + (generated.error?.message || 'No valid chunks'));
    }
  } catch (e) {
    failures++;
    result = { case: item.id, model: MODEL, ok: false, seconds: Math.round((Date.now()-started)/1000),
      error: String(e.message || e) };
    console.error('[' + item.id + '] Failed: ' + result.error);
    await saved(item.id + '-error.json', asJson(result)).catch(() => {});
  } finally {
    summary.cases.push({ id: item.id, ok: result?.ok === true, error: result?.error || null,
      requests: result?.requestsAccepted ?? null });
    await ctx?.close().catch(() => {});
    await new Promise(resolve => lab.server.close(resolve));
  }
}

try {
  await checkOllama();
  site = await startServer(0);
  browser = await chromium.launch({ headless: true });
  const open = await makeOpen(browser, site.base);
  for (const item of cases) await runCase(item, open);
} catch (e) {
  failures++;
  summary.setupError = String(e.message || e);
  console.error('Setup: ' + summary.setupError);
} finally {
  await browser?.close().catch(() => {});
  if (site) await new Promise(resolve => site.server.close(resolve));
  await saved('summary.json', asJson(summary)).catch(() => {});
  console.log('Results saved locally: ' + destination);
  console.log('Generated: ' + summary.cases.filter(x => x.ok).length + '/' + cases.length +
    '. Matching markers is NOT proof of accuracy.');
  if (failures) process.exitCode = 1;
}
