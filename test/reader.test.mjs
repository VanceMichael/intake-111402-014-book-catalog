import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect,identifiers} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('标识类型与来源记录一起保留', async () => {
  const row = (await collect(client))[0];
  assert.equal(row.id, 'press1:m1');
  assert.equal(row.recordId, 'press1:book1');
  assert.equal(row.identifiers[0].type, '15');
  assert.equal(row.notificationType, '03');
});

test('标识清单原样保留类型与值', () => {
  assert.deepEqual(identifiers([{type:15,value:123}]), [{type:'15',value:'123'}]);
  assert.throws(() => identifiers(null), /identifiers/);
});
