import worker from '../server/worker.js';
export default async ({ open, ok }) => {
 const { page } = await open();
 const results = await page.evaluate(async () => {
  const result = {};
  const storage = await import('./js/storage.js');
  const settings = JSON.parse(localStorage.getItem('kd.settings'));
  settings.apiKey = 'SECRET_ACTIVE'; settings.profiles = { gemini: { apiKey: 'SECRET_PROFILE', model: 'keep' } };
  localStorage.setItem('kd.settings', JSON.stringify(settings));
  const backup = await storage.makeBackup();
  result.keys = !JSON.stringify(backup).includes('SECRET_') && JSON.parse(localStorage.getItem('kd.settings')).apiKey === 'SECRET_ACTIVE';
  const realFetch = window.fetch;
  try {
   for (const name of ['openai', 'gemini', 'anthropic']) {
    const client = await import('./js/' + name + '.js');
    const first = name === 'openai' ? { choices: [{ delta: { content: 'Partial answer' } }] } : name === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'Partial answer' }] } }] } : { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } };
    const ending = name === 'openai' ? '[DONE]' : JSON.stringify(name === 'gemini' ? { candidates: [{ finishReason: 'STOP' }] } : { type: 'message_stop' });
    const truncated = name === 'openai' ? { choices: [{ finish_reason: 'length' }] } : name === 'gemini' ? { candidates: [{ finishReason: 'MAX_TOKENS' }] } : { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
    for (const mode of ['complete', 'interrupted', 'truncated', 'malformed', 'broken', 'cancelled', 'timeout']) {
     let text = '', count = 0;
     const ctrl = new AbortController();
     window.fetch = async () => { count++; return new Response(new ReadableStream({
      start(c) {
       c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(first) + '\n\n'));
       if (mode === 'broken') { setTimeout(() => c.error(new Error('connection lost')), 10); return; }
       if (mode === 'cancelled' || mode === 'timeout') return;
       if (mode !== 'interrupted') c.enqueue(new TextEncoder().encode('data: ' + (mode === 'complete' ? ending : mode === 'malformed' ? '{invalid json' : JSON.stringify(truncated)) + '\n\n'));
       c.close();
      }
     }), { headers: { 'Content-Type': 'text/event-stream' } }); };
     if (mode === 'cancelled') setTimeout(() => ctrl.abort(), 20);
     let outcome = 'complete';
     try { await client.stream({ apiKey: 'fake', baseUrl: 'https://fake.test', model: 'model', parts: [{ text: 'test' }], signal: ctrl.signal, timeoutMs: 80, onText: d => { text += d; } }); }
     catch(e) { outcome = e.name === 'AbortError' ? 'cancelled' : e.code || 'error'; }
     result[name + '-' + mode] = count === 1 && text === 'Partial answer' && (mode === 'complete' ? outcome === 'complete' : mode === 'cancelled' ? outcome === 'cancelled' : mode === 'timeout' ? outcome === 'REQUEST_TIMEOUT' : mode === 'truncated' ? outcome === 'MAX_TOKENS' : outcome !== 'complete');
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 20);
    try { await client.generate({ apiKey: 'fake', baseUrl: 'https://fake.test', model: 'model', parts: [], signal: ctrl.signal, timeoutMs: 200 }); result[name+'-offline'] = false; }
    catch(e) { result[name+'-offline'] = e.name === 'AbortError'; }
    delete navigator.onLine;
   }
   const { analyze } = await import('./js/analyze.js');
   let ocrCount = 0;
   const cache = new Map(), counts = [];
   window.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.messages.some(m => Array.isArray(m.content))) return Response.json({error:{message:'stop after OCR'}}, {status:400});
    ocrCount++;
    return Response.json({choices:[{message:{content:'Recognised fact.'},finish_reason:'stop'}]});
   };
   for (const [model,revision] of [['a',0],['a',0],['b',0],['b',1]]) {
    const source={kind:'images',name:'page',images:[{mime:'image/png',data:'YQ=='}],ocrRevision:revision};
    try { await analyze({sources:[source],ocrCache:cache,settings:{provider:'custom',apiKey:'fake',baseUrl:'https://fake.test',model},log:()=>{}}); } catch {}
    counts.push(ocrCount);
   }
   result.ocrIdentity = counts.join() === '1,1,2,3';
   const { generateTopicChunks } = await import('./js/analyze.js');
   let calls = 0;
   window.fetch = async () => { calls++; return Response.json({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }); };
   try { await generateTopicChunks({ title: 'test', text: 'x'.repeat(2000) }, { provider: 'custom', apiKey: 'fake', baseUrl: 'https://fake.test', model: 'm' }, () => {}); }
   catch(e) { result.split = e.code === 'MAX_TOKENS' && calls <= 17; }
   for (const mode of ['failed', 'empty', 'passed']) {
    let requests = 0;
    window.fetch = async () => {
     requests++;
     if (requests > 1 && mode === 'failed') return Response.json({ error: { message: 'bad request' } }, { status: 400 });
     const data = requests === 1 ? { chunks: [{ t: 'Content' }], points: mode === 'empty' ? [] : [{ p: 'Fact', c: [0] }] } : { checks: mode === 'empty' ? [] : [{ i: 0, c: [0] }], missing: [] };
     return Response.json({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }] });
    };
    const topic = { title: 'test', text: 'fact' };
    await generateTopicChunks(topic, { provider: 'custom', apiKey: 'fake', baseUrl: 'https://fake.test', model: 'm', coverageCheck: true }, () => {});
    result['coverage-'+mode] = topic.coverage.state === (mode === 'empty' ? 'partial' : mode);
   }
  } finally { window.fetch = realFetch; delete navigator.onLine; }
  const { Dictation } = await import('./js/dictation.js');
  const context = Dictation.prototype.buildContext.call({
   project: {fullText:'Introduction. '.repeat(40000)+' Rareterm: answer at end of textbook.'},
   seq:()=>[],pos:{done:{},chunk:0},resumePos:null,topicById:()=>null,lastSpokenText:()=>'',qa:[]
  }, 'What is Rareterm?');
  result.contextTail = context.includes('answer at end of textbook') && context.length < 18000;
  return result;
 });
 for (const [name, pass] of Object.entries(results)) ok(pass, 'audit: ' + name);
 const mixed = await open();
 const pdf = await mixed.page.evaluate(async () => {
  const append = document.head.appendChild;
  let destroyed = false, rendered = [];
  document.head.appendChild = function(el) {
   if (el.src?.includes('pdf.min.js')) {
    window.pdfjsLib = { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({
     numPages: 3, destroy: async () => { destroyed = true; },
     getPage: async i => ({
      getTextContent: async () => ({ items: i === 2 ? [] : [{ str: ('Page ' + i + ' original text. ').repeat(10) }] }),
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => { rendered.push(i); return { promise: Promise.resolve() }; }
     })
    }) }; } };
    queueMicrotask(() => el.onload()); return el;
   }
   return append.call(this,el);
  };
  try {
   const { fileToSource } = await import('./js/extract.js');
   const s = await fileToSource(new File(['pdf'], 'mixed.pdf'));
   const { analyze } = await import('./js/analyze.js');
   // Stop after OCR: the source itself must already preserve ordered page text.
   const realFetch = window.fetch;
   window.fetch = async () => Response.json({ choices: [{ message: { content: 'SCANNED MIDDLE PAGE' }, finish_reason: 'stop' }] });
   try { await analyze({ sources: [s], settings: { provider: 'custom', apiKey: 'fake', baseUrl: 'https://fake.test', model: 'm' }, log: () => {} }); } catch {}
   finally { window.fetch = realFetch; }
   return { rendered, destroyed, ordered: s.text.indexOf('Page 1') < s.text.indexOf('SCANNED MIDDLE PAGE') && s.text.indexOf('SCANNED MIDDLE PAGE') < s.text.indexOf('Page 3') };
  } finally { document.head.appendChild = append; }
 });
 ok(pdf.destroyed && pdf.rendered.join() === '2' && pdf.ordered, 'mixed PDF preserves digital and scanned pages in order');
 const counter = { idFromName: () => 'daily', get: () => ({ fetch: async () => Response.json({ accepted: true }) }) };
 let aiCalls = 0;
 const env = { AI: { run: async () => { aiCalls++; return { response: 'answer' }; } }, REQUEST_LIMITS: counter, MODELS: 'sample:free' };
 const req = (body) => new Request('https://test/chat/completions', { method: 'POST', headers: { Origin: 'https://stairrax.github.io' }, body });
 const response = await worker.fetch(req(JSON.stringify({ kd_purpose: 'question', messages: [{ role: 'user', content: 'hi' }] })), env);
 ok(response.status === 200 && aiCalls === 1, 'Workers AI works without OpenRouter key after quota check');
 const large = await worker.fetch(req(' '.repeat(12 * 1024 * 1024 + 1)), env);
 ok(large.status === 413 && aiCalls === 1, 'actual body size is bounded without Content-Length');
};

