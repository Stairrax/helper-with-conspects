import assert from 'node:assert/strict';

const values = new Map([['kd.freeProxy','https://unit-proxy.test']]);
let failSet=false,failRemove=false;
const events=[];
globalThis.window={dispatchEvent:e=>{events.push(e.detail?.failed);return true;}};
globalThis.CustomEvent = class {constructor(type,options){this.type=type;this.detail=options.detail;}};
globalThis.localStorage={
  getItem:key=>values.has(key)?values.get(key):null,
  setItem(key,value){if(failSet&&key==='kd.freeProxyOk')throw Error('quota');values.set(key,String(value));},
  removeItem(key){if(failRemove&&key==='kd.progress:unit')throw Error('quota');values.delete(key);},
};
const { GeminiError } = await import('../js/gemini.js');
const config = await import('../js/config.js');
const storage = await import('../js/storage.js');
const underlying=new SyntaxError('malformed JSON');
assert.equal(new GeminiError('BAD_JSON',{code:'BAD_JSON',cause:underlying}).cause,underlying);
failSet=true;
config.useFreeProxy('https://unit-proxy.test');
assert.equal(storage.storageFailures.has('kd.freeProxyOk'),true);
failSet=false;
config.useFreeProxy('https://unit-proxy.test');
assert.equal(storage.storageFailures.has('kd.freeProxyOk'),false);
failRemove=true;
assert.equal(storage.clearProgress('unit'),false);
assert.equal(storage.storageFailures.has('kd.progress:unit'),true);
failRemove=false;
assert.equal(storage.clearProgress('unit'),true);
assert.equal(storage.storageFailures.has('kd.progress:unit'),false);
assert.ok(events.includes(true)&&events.includes(false));
console.log('PASS: cause propagation and recovery from config/progress persistence errors.');
