import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRelease } from '../scripts/build.mjs';
import { ROOT, startServer, fakeSpeech, makeOpen } from './lib.mjs';

export default async ({ browser, ok }) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kd-release-test-'));
  const source = path.join(temp, 'source'), out = path.join(temp, 'dist');
  const archived = path.join(temp, 'archived');
  let server, ctx;
  try {
    await fs.mkdir(source);
    for (const name of ['js', 'css', 'fonts', 'icons', 'index.html', 'sw.js', 'manifest.webmanifest']) {
      await fs.cp(path.join(ROOT, name), path.join(source, name), { recursive: true });
    }
    const probe = path.join(source, 'js', 'release-probe.js');
    await fs.writeFile(probe, 'export default "first";\n');
    const a = await buildRelease({ source, out });
    const duplicate = await buildRelease({ source, out });
    ok(a.id === duplicate.id, 'unchanged inputs produce the same immutable release');
    const aDir = path.join(out, 'releases', a.id);
    const aManifest = await fs.readFile(path.join(aDir, 'release.json'), 'utf8');
    const aHtml = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    ok(aHtml.includes('releases/' + a.id + '/js/app.js') && aHtml.includes('releases/' + a.id + '/css/styles.css'), 'entry point and styles use the same release path');
    ok(!aHtml.includes('js/app.js?v='), 'built HTML does not reference mutable entry modules');
    const voice = await fs.readFile(path.join(aDir, 'js', 'neural.js'), 'utf8');
    ok(voice.includes("new URL('voices/silero-ru/', document.baseURI)"), 'large neural voice files remain at the common root');
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.webmanifest'), 'utf8'));
    ok(manifest.id === './' && manifest.scope === './' && manifest.start_url === './?source=app', 'PWA identity and scope are preserved');

    const served = await startServer(0, out, '/helper-with-conspects/');
    server = served.server;
    const open = await makeOpen(browser, served.base);
    const phone = await open({ settings: { voiceEngine: 'system' } });
    ctx = phone.ctx;
    let page = phone.page;
    await page.waitForFunction(() => window.__kdReady && !!navigator.serviceWorker.controller);
    const release = () => page.locator('meta[name="kd-release"]').getAttribute('content');
    ok(await release() === a.id, 'release A starts on the Pages-style subpath');
    await page.evaluate(() => localStorage.setItem('kd.releaseTest', 'preserved'));
    await fs.writeFile(probe, 'export default "second";\n');
    await fs.appendFile(path.join(source, 'css', 'styles.css'), '\n:root { --release-test: second; }\n');
    const b = await buildRelease({ source, out });
    ok(a.id !== b.id, 'changing assets without increasing the human version creates a different release');
    ok(await fs.readFile(path.join(aDir, 'release.json'), 'utf8') === aManifest &&
      await fs.readFile(path.join(aDir, 'js', 'release-probe.js'), 'utf8') === 'export default "first";\n',
      'building B does not overwrite files belonging to A');
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).waiting), null, { timeout: 30000 });
    const oldModule = await page.evaluate(async id => (await import('./releases/' + id + '/js/release-probe.js')).default, a.id);
    ok(await release() === a.id && oldModule === 'first', 'open page remains on A and can load its own module while B waits');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__kdReady);
    ok(await release() === a.id, 'offline reload of a controlled A page does not mix with B');
    await ctx.setOffline(false);
    await page.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    page = await ctx.newPage();
    await page.addInitScript(fakeSpeech);
    await page.goto(served.base);
    await page.waitForFunction(id => window.__kdReady && document.querySelector('meta[name="kd-release"]')?.content === id, b.id, { timeout: 30000 });
    const after = await page.evaluate(async id => ({
      marker: (await import('./releases/' + id + '/js/release-probe.js')).default,
      data: localStorage.getItem('kd.releaseTest'),
    }), b.id);
    ok(after.marker === 'second' && after.data === 'preserved', 'B activates after closing A and retains browser data');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__kdReady);
    ok(await release() === b.id, 'release B boots offline after activation');
    await ctx.setOffline(false);

    await fs.cp(path.join(out, 'releases'), archived, { recursive: true });
    const restored = await buildRelease({ source, out: path.join(temp, 'fresh-dist'), history: archived });
    ok(restored.id === b.id && await fs.readFile(path.join(restored.out, 'releases', a.id, 'release.json'), 'utf8') === aManifest,
      'fresh CI build retains the prior release from the archive');
    await fs.appendFile(path.join(archived, a.id, 'js', 'release-probe.js'), 'tampered');
    let rejected = false;
    try { await buildRelease({ source, out: path.join(temp, 'bad-dist'), history: archived }); }
    catch (error) { rejected = error.message.includes('Corrupt release file'); }
    ok(rejected, 'build rejects a corrupted archived release rather than publishing it');
  } finally {
    if (ctx) await ctx.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
};
