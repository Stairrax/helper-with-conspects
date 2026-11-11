// Small dependency-free audit smoke: can run when Playwright/apt downloads are unavailable.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { RequestLimits } from '../server/worker.js';

globalThis.crypto ||= webcrypto;
const saved = new Map([['kd.freeProxy','https://proxy-one.test,https://proxy-two.test']]);
globalThis.localStorage = {
  getItem: key => saved.get(key) || null,
  setItem: (key,value) => saved.set(key,String(value)),
};
Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ onLine:true } });
globalThis.window = { addEventListener(){}, removeEventListener(){} };
globalThis.location = { origin:'http://localhost' };

const { generate, stream } = await import('../js/openai.js');
const input = { apiKey:'device-id', baseUrl:'https://proxy-one.test',
  model:'server-picks', parts:[{text:'hello'}], purpose:'question',
  timeoutMs:5000, retries:0 };
const realFetch = globalThis.fetch;
const seen = [];
try {
  globalThis.fetch = async (url,opts) => {
    seen.push({url,id:opts.headers['Idempotency-Key']});
    if (url.startsWith('https://proxy-one')) return Response.json(
      {error:{proxy:true,code:'unavailable',message:'temporary outage'}},{status:503});
    return Response.json({choices:[{message:{content:'got result'},finish_reason:'stop'}]});
  };
  assert.equal(await generate(input),'got result');
  assert.equal(seen.length,2);
  assert.match(seen[0].id,/^kd_[a-f0-9]{32}$/);
  assert.equal(seen[0].id,seen[1].id,'retry changed the idempotency key');
  seen.length=0;
  let chunks='';
  await stream({...input,onText:text=>{chunks+=text;}});
  assert.equal(chunks,'got result');
  assert.equal(seen.length,2);
  assert.equal(seen[0].id,seen[1].id,'stream fallback changed idempotency key');
  seen.length=0;
  globalThis.fetch = async ()=>{seen.push('request');return Response.json(
    {choices:[{message:{content:''},finish_reason:'stop'}]});};
  await assert.rejects(generate({...input,retries:3}),e=>e.code==='EMPTY');
  assert.equal(seen.length,1,'empty answer was retried');
} finally {
  globalThis.fetch=realFetch;
}

const records=new Map();
let pending=Promise.resolve();
const store={
  transaction(fn){
    const next=pending.then(async()=>{
      const draft=new Map(records), tx={
        get:async key=>draft.get(key),
        put:async (key,v)=>draft.set(key,v),
      };
      const result=await fn(tx);
      records.clear();for(const [k,v]of draft)records.set(k,v);
      return result;
    });
    pending=next.catch(()=>{});
    return next;
  },
  getAlarm:async()=>null, setAlarm:async()=>{},
  deleteAll:async()=>records.clear(),
};
const limiter=new RequestLimits({storage:store});
let inferences=0;
const env={
  REQUEST_LIMITS:{idFromName:()=> 'today', get:()=>({fetch:(url,init)=>limiter.fetch(new Request(url,init))})},
  AI:{run:async()=>{inferences++;return {response:'hello'};}},
};
const key='kd_0123456789abcdef0123456789abcdef';
const req=(id,text='hello')=>new Request('https://server.test/chat/completions',{
  method:'POST',headers:{Origin:'https://stairrax.github.io',
    Authorization:'Bearer test-device',...(id?{'Idempotency-Key':id}:{})},
  body:JSON.stringify({kd_purpose:'question',messages:[{role:'user',content:text}]}),
});
const responses=await Promise.all([worker.fetch(req(key),env),worker.fetch(req(key),env)]);
assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
assert.equal(inferences,1);
assert.equal(records.get('total'),1);
const duplicate=await worker.fetch(req(key),env);
assert.equal(duplicate.status,409);
assert.equal((await duplicate.json()).error.code,'duplicate_request');
const conflict=await worker.fetch(req(key,'other'),env);
assert.equal((await conflict.json()).error.code,'idempotency_conflict');
assert.equal(inferences,1);
console.log('PASS: HTTP failover, stable request IDs, no EMPTY replay, atomic single inference/quota.');
