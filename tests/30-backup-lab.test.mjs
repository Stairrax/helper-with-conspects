// Real Chromium integration: the EXISTING PWA client speaks to the local backup API.
// No OpenRouter, Cloudflare or Ollama call is needed.
import { startBackupLab } from '../server/backup-lab.mjs';

export default async ({ open, ok }) => {
  const { server, url } = await startBackupLab({ port: 0, mode: 'mock' });
  try {
    const { page } = await open({ freeProxy: url, settings: { provider: 'free' } });
    const result = await page.evaluate(async () => {
      const ai = await import('/js/ai.js');
      const settings = JSON.parse(localStorage.getItem('kd.settings'));
      const args = ai.conn(settings, 'question');
      const prompt = { system: 'Ответь по-русски', parts: [{ text: 'Привет!' }] };
      const text = await ai.generate({ ...args, ...prompt, retries: 0 });
      const chunks = [];
      await ai.stream({ ...args, ...prompt, onText: chunk => chunks.push(chunk) });
      const models = await ai.listModels(args);
      return { base: args.baseUrl, text, streamed: chunks.join(''), models };
    });
    ok(result.base === url, 'приложение выбрало локальный резервный API, не Cloudflare');
    ok(result.text.includes('ТЕСТОВЫЙ ОТВЕТ'), 'существующий клиент разобрал OpenAI JSON');
    ok(result.streamed.includes('ТЕСТОВЫЙ ОТВЕТ'), 'существующий клиент разобрал поток SSE');
    ok(result.models.includes('auto'), 'существующий клиент получил список моделей');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};
