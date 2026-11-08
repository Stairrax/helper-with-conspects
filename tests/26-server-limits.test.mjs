import { RequestLimits } from '../server/worker.js';

export default async ({ ok }) => {
  const records = new Map();
  let chain = Promise.resolve(), alarm = null;
  const storage = {
    transaction(fn) {
      const operation = chain.then(async () => {
        const draft = new Map(records);
        const tx = { get: async (k) => draft.get(k), put: async (k, v) => draft.set(k, v) };
        const result = await fn(tx);
        records.clear(); for (const [k, v] of draft) records.set(k, v);
        return result;
      });
      chain = operation.catch(() => {});
      return operation;
    },
    async getAlarm() { return alarm; },
    async setAlarm(at) { alarm = at; },
    async deleteAll() { records.clear(); },
  };
  const limiter = new RequestLimits({ storage });
  const send = async (device, ip, limits = [5, 2, 4]) => (await (await limiter.fetch(new Request('https://internal/', {
    method: 'POST', body: JSON.stringify({ device, ip, limits }),
  }))).json()).accepted;
  const results = await Promise.all(Array.from({ length: 4 }, () => send('one', 'ip1')));
  ok(results.filter(Boolean).length === 2, 'параллельные запросы не обходят лимит устройства');
  ok(await send('two', 'ip1') && await send('two', 'ip1'), 'другое устройство использует собственный лимит');
  ok(!(await send('three', 'ip1')), 'ограничение IP работает для разных устройств');
  ok(await send('three', 'ip2') && !(await send('four', 'ip3')), 'общий лимит ограничивает все устройства');
  ok(alarm !== null, 'устаревшие счётчики запланированы к удалению');
  await limiter.alarm();
  ok(records.size === 0, 'счётчики удаляются после срока хранения');
  const category = async (purpose) => (await (await limiter.fetch(new Request('https://internal/', {
    method: 'POST', body: JSON.stringify({ device: 'student', ip: 'ip', purpose, limits: [20, 20, 20, purpose === 'notes' ? 2 : 1] }),
  }))).json());
  const n1 = await category('notes'), n2 = await category('notes'), n3 = await category('notes');
  const q1 = await category('question'), q2 = await category('question');
  ok(n1.accepted && n2.accepted && !n3.accepted && n3.category, 'лимит подготовки применяется отдельно');
  ok(q1.accepted && !q2.accepted && q2.category, 'после исчерпания подготовки остаются отдельные вопросы');
};
