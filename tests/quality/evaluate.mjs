#!/usr/bin/env node
// Offline evidence-marker aid: a human must inspect source, output and unsupported claims.
import { readFile, writeFile } from 'node:fs/promises';

const fixtures = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const cases = fixtures.cases;
const normalize = s => String(s).normalize('NFKC').toLocaleLowerCase('und')
  .replace(/ё/g, 'е').replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim();

function inspect(item, answer) {
  const text = normalize(answer);
  const checks = item.checkpoints.map(p => {
    const evidence = p.evidenceAny.find(v => text.includes(normalize(v))) || null;
    return {
      id: p.id, type: p.type, question: p.question,
      evidenceMarkerFound: Boolean(evidence), exampleMatched: evidence,
      humanVerdict: null, humanNotes: '',
    };
  });
  return {
    caseId: item.id, language: item.lang,
    // An exact substring is NOT proof of correctness; a paraphrase can also be correct.
    accuracyVerified: false, humanReviewRequired: true,
    evidenceMarkersFound: checks.filter(c => c.evidenceMarkerFound).length,
    checkpointCount: checks.length, checks,
  };
}
function validate() {
  if (fixtures.schemaVersion !== 1 || !Array.isArray(cases) || cases.length < 3) throw Error('Invalid fixture set');
  const ids = new Set();
  for (const c of cases) {
    if (!c.id || ids.has(c.id) || !c.source || !c.exampleAnswer || !['ru', 'en'].includes(c.lang)) throw Error('Invalid case ' + c.id);
    ids.add(c.id);
    const keys = new Set();
    if (!Array.isArray(c.checkpoints) || c.checkpoints.length < 3) throw Error('Missing checkpoints');
    for (const p of c.checkpoints) {
      if (!p.id || keys.has(p.id) || !p.question || !Array.isArray(p.evidenceAny) || !p.evidenceAny.length ||
          p.evidenceAny.some(a => typeof a !== 'string' || !a.trim())) throw Error('Invalid checkpoint ' + c.id);
      keys.add(p.id);
    }
  }
}
validate();

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] || null; };
const current = cases.find(c => c.id === arg('--case'));
if (args.includes('--self-test')) {
  for (const c of cases) {
    if (inspect(c, c.exampleAnswer).evidenceMarkersFound !== c.checkpoints.length ||
        inspect(c, '').evidenceMarkersFound !== 0) throw Error('Broken fixture: ' + c.id);
  }
  console.log('PASS: ' + cases.length + ' original study fixtures; positive and negative marker controls. No AI or network used.');
} else if (args.includes('--list')) {
  for (const c of cases) console.log(c.id + ' — ' + c.title + ' (' + c.checkpoints.length + ' checks)');
} else if (current && args.includes('--show-source')) {
  console.log(current.title + '\n\n' + current.source);
} else if (current && arg('--answer')) {
  const answer = await readFile(arg('--answer'), 'utf8');
  if (answer.length > 2_000_000) throw Error('Answer file too large');
  const result = inspect(current, answer);
  console.log(current.title + ': found ' + result.evidenceMarkersFound + '/' +
    result.checkpointCount + ' literal markers (NOT a quality score)');
  for (const p of result.checks) console.log((p.evidenceMarkerFound ? '[marker] ' : '[review] ') + p.question);
  console.log('Human review required for every item: meaning, omissions, changes to numbers/formulas/negation and invented facts.');
  if (args.includes('--report')) {
    const destination = arg('--report');
    if (!destination) throw Error('Missing --report path');
    await writeFile(destination, JSON.stringify({ createdAt: new Date().toISOString(), ...result }, null, 2) + '\n', { flag: 'wx' });
    console.log('Draft checklist saved: ' + destination);
  }
} else {
  console.log('Usage:\n  npm run quality:list\n  npm run test:quality\n  node tests/quality/evaluate.mjs --case physics-ru --show-source\n  node tests/quality/evaluate.mjs --case physics-ru --answer exported.md --report review.json');
  process.exitCode = 1;
}
