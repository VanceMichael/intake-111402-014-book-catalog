import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('partial');
const messages = await client('/messages');
assert.equal(messages.items[1],messages.items[2]);
const update = await client('/messages/m2');
assert.equal(update.blocks.descriptive,undefined);
assert.equal(update.blocks.collateral.cover,'/cover/new');
} finally {await source.close();}
});
