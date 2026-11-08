export default async ({ open, ok }) => {
  const { page } = await open();
  const r = await page.evaluate(async () => {
    const realWorker = window.Worker;
    const workers = [];
    class FakeWorker {
      constructor() { this.messages = []; workers.push(this); }
      postMessage(m) { this.messages.push(m); }
      terminate() { this.terminated = true; }
      reply(m) { this.onmessage?.({ data: m }); }
    }
    window.Worker = FakeWorker;
    const neural = await import('./js/neural.js?cancel-test');
    const first = neural.synth('test').catch((e) => e.name);
    const w1 = workers.at(-1);
    neural.cancelSynthesis();
    const firstResult = await first;
    const second = neural.synth('test').catch((e) => e.name);
    const w2 = workers.at(-1);
    neural.cancelSynthesis();
    const secondResult = await second;
    const init = neural.prepare('irina', () => {});
    const w3 = workers.at(-1);
    const queued = neural.synth('queued').catch((e) => e.name);
    neural.cancelSynthesis();
    const queueResult = await queued;
    const initMsg = w3.messages.find((m) => m.type === 'init');
    w3.reply({ type: 'ready', id: initMsg.id });
    await init;
    window.Worker = realWorker;
    return { firstResult, secondResult, queueResult, terminated: w1.terminated, recreated: w1 !== w2, initKept: !w3.terminated, cancelSent: w3.messages.some((m) => m.type === 'cancel') };
  });
  ok(r.terminated && r.firstResult === 'AbortError', 'остановка прерывает незавершённый синтез');
  ok(r.recreated && r.secondResult === 'AbortError', 'та же фраза может быть запущена повторно');
  ok(r.queueResult === 'AbortError' && r.initKept && r.cancelSent, 'заготовка отменена без прерывания загрузки голоса');
};
