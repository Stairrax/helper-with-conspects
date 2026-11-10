// Manual check against the already-running localhost backup lab.
const base = 'http://127.0.0.1:4174';
const origin = 'http://127.0.0.1:8080';
const req = { model: 'auto', messages: [{ role: 'user', content: 'Ответь одним простым предложением: зачем нужен резервный сервер?' }] };

try {
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(4_000) });
  if (!health.ok) throw new Error('No local backup server');
  const h = await health.json();
  if (h.localOnly !== true || !['mock','ollama'].includes(h.mode)) throw new Error('Unexpected server identity');
  console.log('Backup server mode: ' + h.mode);

  const response = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer lab-check' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + JSON.stringify(await response.json()));
  const data = await response.json();
  if (typeof data.choices?.[0]?.message?.content !== 'string' || !data.choices[0].message.content.trim()) {
    throw new Error('Server did not return a compatible text answer');
  }
  console.log('Answer: ' + data.choices[0].message.content.slice(0, 450));

  const streaming = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer lab-check' },
    body: JSON.stringify({ ...req, stream: true }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!streaming.ok) throw new Error('Stream returned HTTP ' + streaming.status);
  const body = await streaming.text();
  if (!body.includes('data: [DONE]') || !body.includes('"delta"')) throw new Error('Missing SSE chunks or completion marker');
  console.log('PASS: local ' + h.mode + ' backup API');
} catch (error) {
  console.error('FAIL: ' + error.message);
  console.error('Start the server first: npm run backup:lab');
  process.exitCode = 1;
}
