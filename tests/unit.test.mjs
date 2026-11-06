import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsSchema, allowedURL, checkCoordinates, Lane } from '../src/actions.mjs';
import { assertIsolation, machineID } from '../src/identity.mjs';

test('reject invalid actions before input', () => {
  for (const actions of [[{type:'click',x:NaN,y:0}], [{type:'shell',command:'echo bad'}], [{type:'wait',ms:3001}], [{type:'type',text:'a',unexpected:true}], []]) {
    assert.throws(() => actionsSchema.parse(actions));
  }
  assert.throws(() => checkCoordinates([{type:'click',x:1280,y:0}], {width:1280,height:800}));
});
test('prevent local-file and credential navigation', () => {
  assert.equal(allowedURL('about:blank'), 'about:blank');
  assert.throws(() => allowedURL('file:///etc/passwd'));
  assert.throws(() => allowedURL('https://user:secret@example.com'));
});
test('serialize operations and recover after errors', async () => {
  const lane = new Lane(), order = [];
  const a = lane.run(async () => { order.push('a'); await new Promise(r=>setTimeout(r,10)); throw new Error('expected'); });
  const b = lane.run(async () => order.push('b'));
  assert.equal(lane.busy,2);
  await assert.rejects(a); await b;
  assert.deepEqual(order,['a','b']); assert.equal(lane.busy,0);
});
test('reject human desktop and accept separate desktop identity', () => {
  assert.throws(() => assertIsolation({machineID:'same',isolation:{kind:'dedicated'}},'same',':0'));
  assert.throws(() => assertIsolation({isolation:{kind:'dedicated'}},'same',':0'));
  assertIsolation({machineID:'different',isolation:{kind:'dedicated'}},'same',':0');
  if (process.platform==='linux') {
    assert.throws(() => assertIsolation({machineID:'same',isolation:{kind:'xvfb',display:':0',managed:true}},'same',':0'));
    assert.throws(() => assertIsolation({machineID:'same',isolation:{kind:'xvfb',display:':0',managed:true}},'same',':0.0'));
    assertIsolation({machineID:'same',isolation:{kind:'xvfb',display:':9',managed:true}},'same',':0');
  }
  assert.match(machineID(),/^[a-f0-9]{64}$/);
});
