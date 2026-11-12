// Real Worker ↔ usage Durable Object flow with stubbed inference only.
// No paid/free provider is contacted; the product's quota logic is exercised.
import worker, { RequestLimits } from '../server/worker.js';
import { UsageStats } from '../server/usage-stats.js';

function storage() {
  const db = new Map();
  let pending = Promise.resolve(), alarm = 0;
  return {
    db,
    get: async key => db.get(key),
    put: async (key, value) => { db.set(key, value); },
    delete: async key => db.delete(key),
    list: async ({prefix}) => new Map([...db].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm || null,
    setAlarm: async next => {alarm = next;},
    deleteAll: async () => db.clear(),
    transaction(fn) {
      const next = pending.then(async () => {
        const draft = new Map(db), tx = {
          get: async key => draft.get(key),
          put: async (key,value) => { draft.set(key,value); },
          delete: async key => draft.delete(key),
        };
        const value = await fn(tx);
        db.clear();
        for (const [key,item] of draft) db.set(key,item);
        return value;
      });
      pending=next.catch(()=>{});
      return next;
    },
  };
}

export default async ({ok}) => {
  const statsStorage=storage(), limitStorage=storage();
  const stats=new UsageStats({storage:statsStorage});
  const limits=new RequestLimits({storage:limitStorage});
  const env = {
    USAGE_ADMIN_TOKEN:'private-owner-token',
    USAGE_STATS:{idFromName:()=>'global',get:()=>({fetch:(u,init)=>stats.fetch(new Request(u,init))})},
    REQUEST_LIMITS:{idFromName:()=> 'daily',get:()=>({fetch:(u,init)=>limits.fetch(new Request(u,init))})},
    AI:{run:async()=>({response:'Ответ модели'})},
  };
  const deviceA='kd-0123456789abcdef01234567';
  const deviceB='kd-aaaaaaaaaaaaaaaaaaaaaaaa';
  const origin='https://stairrax.github.io';
  const req=(id,device,site=origin,purpose='notes')=>new Request('https://proxy.example/v1/chat/completions',{
    method:'POST',
    headers:{Origin:site,Authorization:'Bearer '+device,'Idempotency-Key':id,'Content-Type':'application/json'},
    body:JSON.stringify({kd_purpose:purpose,messages:[{role:'user',content:'Приватный учебный материал, не сохранять в статистику'}]}),
  });
  const ids=['kd_'+'1'.repeat(32),'kd_'+'2'.repeat(32),'kd_'+'3'.repeat(32),'kd_'+'4'.repeat(32)];
  const post=async (id,device,site,purpose)=>(await worker.fetch(req(id,device,site,purpose),env)).status;
  ok(await post(ids[0],deviceA)===200 && await post(ids[1],deviceA,origin,'question')===200 &&
     await post(ids[2],deviceB)===200,'normal successful app AI requests still work');
  ok(await post(ids[0],deviceA)===409,'idempotency blocks a repeated logical request');
  ok(await post(ids[3],deviceA,'http://localhost:8080')===200,
     'localhost development request succeeds but must not count');
  ok(await post('kd_'+'5'.repeat(32),'kd-deploy-check')===200,
     'deployment probe succeeds but must not count');

  const signal=await (await worker.fetch(new Request('https://proxy.example/usage-signal'),env)).json();
  ok(signal.enabled===true && signal.observed===true,'public signal confirms first non-test AI response without revealing count');

  const denied=await worker.fetch(new Request('https://proxy.example/usage/data'),env);
  ok(denied.status===401,'stats dashboard rejects requests without owner token');
  const granted=await worker.fetch(new Request('https://proxy.example/usage/data',{
    headers:{Authorization:'Bearer private-owner-token'},
  }),env);
  const data=await granted.json(), today=data.days.at(-1);
  ok(granted.status===200 && today.requests===3 && today.devices===2 &&
     today.notes===2 && today.questions===1,
     'owner-only counters reflect three actual responses and two different devices');
  ok(data.days.length===30 && data.timezone==='UTC',
     'owner dashboard receives thirty daily buckets in UTC');
  const page=await worker.fetch(new Request('https://proxy.example/usage'),env);
  ok(page.status===200 && (await page.text()).includes('Активность по дням'),
     'live dashboard HTML is served at /usage');
  ok(!JSON.stringify([...statsStorage.db]).includes('Приватный учебный материал') &&
     !JSON.stringify([...statsStorage.db]).includes(deviceA),
     'statistics persist neither source text nor raw device IDs');
};
