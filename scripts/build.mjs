import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_NAME = /^v\d+-[a-f0-9]{20}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const read = (root, file) => fs.readFile(path.join(root, file));
const exists = async file => fs.access(file).then(() => true, () => false);

async function files(root, dir) {
  const list = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const name = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) list.push(...await files(root, name));
    else if (entry.isFile()) list.push(name);
    else throw new Error('Unsupported release entry: ' + name);
  }
  return list.sort();
}

async function write(root, file, value) {
  const dest = path.join(root, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, value);
}

async function validateRelease(dir, id) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'release.json'), 'utf8'));
  if (manifest.id !== id || !RELEASE_NAME.test(id)) throw new Error('Invalid release manifest: ' + id);
  const actual = (await files(dir, '.')).filter(name => name !== 'release.json');
  if (actual.length !== Object.keys(manifest.files).length) throw new Error('Unexpected release files: ' + id);
  for (const name of actual) {
    if (sha(await read(dir, name)) !== manifest.files[name]) throw new Error('Corrupt release file: ' + id + '/' + name);
  }
  return manifest;
}

async function preserve(history, destination) {
  if (!history) return;
  for (const entry of await fs.readdir(history, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RELEASE_NAME.test(entry.name)) throw new Error('Invalid archived release: ' + entry.name);
    const source = path.join(history, entry.name);
    const target = path.join(destination, entry.name);
    const original = await validateRelease(source, entry.name);
    if (!await exists(target)) await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
    const retained = await validateRelease(target, entry.name);
    if (JSON.stringify(original) !== JSON.stringify(retained)) throw new Error('Release collision: ' + entry.name);
  }
}

export async function buildRelease({ source = ROOT, out = path.join(ROOT, 'dist'), history, legacy } = {}) {
  source = path.resolve(source);
  out = path.resolve(out);
  if (out === source || source.startsWith(out + path.sep)) throw new Error('Unsafe output directory');
  const html = (await read(source, 'index.html')).toString('utf8');
  const sw = (await read(source, 'sw.js')).toString('utf8');
  const version = sw.match(/const VERSION\s*=\s*['"]kd-v(\d+)['"]/)?.[1];
  const entry = html.match(/src="js\/app\.js\?v=(\d+)"/)?.[1];
  if (!version || version !== entry) throw new Error('Source version mismatch');
  const workerTemplate = await fs.readFile(new URL('./release-worker.js', import.meta.url), 'utf8');
  const notificationStart = sw.indexOf('const META =');
  if (notificationStart < 0) throw new Error('Missing notification handlers');
  const notifications = sw.slice(notificationStart);
  const names = (await Promise.all(['js', 'css', 'fonts'].map(dir => files(source, dir)))).flat().sort();
  const assets = new Map(await Promise.all(names.map(async name => [name, await read(source, name)])));
  const neural = assets.get('js/neural.js').toString('utf8');
  const oldVoiceBase = "new URL('../voices/silero-ru/', import.meta.url).href";
  if (!neural.includes(oldVoiceBase)) throw new Error('Voice base changed; review release mapping');
  assets.set('js/neural.js', Buffer.from(neural.replace(oldVoiceBase, "new URL('voices/silero-ru/', document.baseURI).href")));
  const builder = await fs.readFile(fileURLToPath(import.meta.url));
  const fingerprint = sha(JSON.stringify({
    version, html: sha(html), worker: sha(workerTemplate), notifications: sha(notifications), builder: sha(builder),
    files: [...assets].map(([name, value]) => [name, sha(value)]),
  })).slice(0, 20);
  const id = 'v' + version + '-' + fingerprint;
  const prefix = 'releases/' + id + '/';
  const importMap = html.match(/<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/);
  if (!importMap) throw new Error('Missing import map');
  const imports = JSON.parse(importMap[1]).imports;
  for (const [key, value] of Object.entries(imports)) {
    if (value !== key + '?v=' + version || !assets.has(key.replace(/^\.\//, ''))) throw new Error('Invalid module mapping: ' + key);
    imports[key] = './' + prefix + key.replace(/^\.\//, '');
  }
  let shell = html.replace(importMap[0], '<script type="importmap">\n' + JSON.stringify({ imports }, null, 2) + '\n  </script>')
    .replace('src="js/app.js?v=' + version + '"', 'src="' + prefix + 'js/app.js"')
    .replace(/href="(css\/[^"]+)"/g, (_, name) => {
      if (!assets.has(name)) throw new Error('Missing stylesheet: ' + name);
      return 'href="' + prefix + name + '"';
    })
    .replace(/^\s*try \{ jobs\.push\(caches\.keys\(\).*$/m, '')
    .replace(/navigator\.serviceWorker\.getRegistrations\(\)\.then\(function \(rs\) \{ return Promise\.all\(rs\.map\(function \(r\) \{ return r\.update\(\); \}\)\); \}\)/, 'navigator.serviceWorker.getRegistration(location.href).then(function (r) { return r && r.update(); })');
  if (/getRegistrations\(\)|jobs\.push\(caches\.keys|js\/app\.js\?v=/.test(shell)) throw new Error('Unsafe recovery or mutable entry remains');
  shell = shell.replace('</head>', '  <meta name="kd-release" content="' + id + '">\n</head>');
  assets.set('shell.html', Buffer.from(shell));
  const manifest = { id, files: Object.fromEntries([...assets].map(([name, data]) => [name, sha(data)])) };

  const releases = path.join(out, 'releases');
  await fs.mkdir(releases, { recursive: true });
  await preserve(history, releases);
  const releaseDir = path.join(releases, id);
  if (await exists(releaseDir)) {
    const previous = await validateRelease(releaseDir, id);
    if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('Refusing to overwrite an immutable release');
  } else {
    const temp = await fs.mkdtemp(path.join(out, '.release-'));
    try {
      for (const [name, data] of assets) await write(temp, name, data);
      await write(temp, 'release.json', JSON.stringify(manifest, null, 2) + '\n');
      await validateRelease(temp, id);
      await fs.rename(temp, releaseDir);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  for (const dir of ['icons', 'screenshots', 'voices']) {
    if (await exists(path.join(source, dir))) await fs.cp(path.join(source, dir), path.join(out, dir), { recursive: true });
  }
  if (legacy) {
    for (const dir of ['js', 'css', 'fonts']) {
      await fs.cp(path.join(legacy, dir), path.join(out, dir), { recursive: true });
    }
  }
  for (const file of ['manifest.webmanifest', 'LICENSE', 'LICENSE.ru.md', '.nojekyll']) {
    if (await exists(path.join(source, file))) await write(out, file, await read(source, file));
  }
  const expected = Object.fromEntries(Object.entries(manifest.files).map(([name, hash]) => [prefix + name, hash]));
  const worker = workerTemplate.replace('__KD_RELEASE__', JSON.stringify(id))
    .replace('__KD_FILES__', JSON.stringify(expected, null, 2)) + '\n' + notifications;
  await write(out, 'sw.js', worker);
  await write(out, 'release.json', JSON.stringify({ id, shell: prefix + 'shell.html' }, null, 2) + '\n');
  await write(out, 'index.html', shell);
  return { id, out, files: assets.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!['out', 'history', 'legacy'].includes(name) || !args[i + 1]) throw new Error('Unknown build option: ' + args[i]);
    options[name] = path.resolve(args[i + 1]);
  }
  const result = await buildRelease(options);
  console.log('Built ' + result.id + ': ' + result.files + ' immutable files in ' + result.out);
}
