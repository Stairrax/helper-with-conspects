// Regression tests for the actual backup button and Cloudflare Workers AI SSE proxy.
// Both cases previously passed helper-level tests while the user-visible path was unsafe.
import worker from '../server/worker.js';

export default async ({ open, ok }) => {
  // Test the same file the user shares/downloads, not just storage.makeBackup().
  const { page } = await open({ settings: {
    provider: 'openrouter',
    apiKey: 'HOTFIX_ACTIVE_SECRET',
    profiles: {
      gemini: { apiKey: 'HOTFIX_PROFILE_SECRET', model: 'gemini-test' },
      anthropic: { apiKey: 'HOTFIX_SECOND_SECRET', model: 'claude-test' },
    },
  } });
  await page.evaluate(() => {
    window.__backupForAudit = null;
    navigator.canShare = () => true;
    navigator.share = async ({ files }) => {
      window.__backupForAudit = { name: files[0].name, content: await files[0].text() };
    };
    document.getElementById('backupBtn').click();
  });
  await page.waitForFunction(() => Boolean(window.__backupForAudit), null, { timeout: 12000 });
  const file = await page.evaluate(() => window.__backupForAudit);
  const exported = JSON.parse(file.content);
  const settings = JSON.parse(exported.localStorage['kd.settings']);
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('kd.settings')));
  ok(/^diktor-backup-\d{4}-\d{2}-\d{2}\.json$/.test(file.name), 'UI export produced the real backup file');
  ok(!file.content.includes('HOTFIX_'), 'UI backup contains no active or profile API keys');
  ok(settings.apiKey === '' && settings.profiles.gemini.apiKey === '' &&
    settings.profiles.anthropic.apiKey === '' && settings.profiles.gemini.model === 'gemini-test',
    'UI backup preserves non-secret settings and clears all provider keys');
  ok(original.apiKey === 'HOTFIX_ACTIVE_SECRET' && original.profiles.gemini.apiKey === 'HOTFIX_PROFILE_SECRET',
    'export does not modify live credentials on the user's device');

  // Test a complete upstream stream, a silent early EOF, malformed SSE and
  // the provider's "length" finish_reason. Do not fabricate a successful [DONE].
  const enc = new TextEncoder();
  const limits = { idFromName: () => 'daily', get: () => ({ fetch: async () => Response.json({ accepted: true }) }) };
  const modes = {
    complete: ['data: {"response":"First"}\n\n', 'data: {"response":" second"}\n\n', 'data: [DO', 'NE]\n\n'],
    interrupted: ['data: {"response":"Only part"}\n\n'],
    malformed: ['data: {"response":"Part"}\n\n', 'data: not-json\n\n'],
    truncated: ['data: {"response":"Part"}\n\n', 'data: {"choices":[{"finish_reason":"length"}]}\n\n', 'data: [DONE]\n\n'],
  };
  for (const [mode, fragments] of Object.entries(modes)) {
    const env = {
      REQUEST_LIMITS: limits,
      AI: { run: async () => new ReadableStream({
        start(c) { for (const part of fragments) c.enqueue(enc.encode(part)); c.close(); },
      }) },
    };
    const response = await worker.fetch(new Request('https://test/chat/completions', {
      method: 'POST',
      headers: { Origin: 'https://stairrax.github.io', Authorization: 'Bearer hotfix-device' },
      body: JSON.stringify({
        kd_purpose: 'question',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }), env);
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let output = '', failed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += dec.decode(value, { stream: true });
      }
    } catch { failed = true; }
    finally { reader.releaseLock(); }
    if (mode === 'complete') {
      ok(response.status === 200 && !failed && output.includes('First') &&
        output.includes(' second') && output.includes('data: [DONE]\n\n'),
        'Workers AI forwards a genuinely completed stream, even when [DONE] is split across chunks');
    } else if (mode === 'truncated') {
      ok(!failed && output.includes('"finish_reason":"length"') && output.includes('data: [DONE]\n\n'),
        'Workers AI forwards the output-length signal to the browser');
    } else {
      ok(failed && !output.includes('[DONE]') && /part/i.test(output),
        'Workers AI ' + mode + ' stream cannot masquerade as successfully completed');
    }
  }
};
