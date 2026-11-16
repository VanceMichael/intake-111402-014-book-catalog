import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
import {Catalog} from '../src/catalog.mjs';

let source;
after(async () => {if (source) await source.close();});

test('partial 场景：重复领取与分块更新在来源侧可观察',async () => {
  source = await createSource();
  try {
    const client = createClient(source.origin);
    await client('/__scenario',{method:'POST',body:{name:'partial'}});
    const messages = await client('/messages');
    assert.equal(messages.items[1],messages.items[2]);
    const update = await client('/messages/m2');
    assert.equal(update.blocks.descriptive,undefined);
    assert.equal(update.blocks.collateral.cover,'/cover/new');
  } finally {await source.close();source = undefined;}
});

test('lifecycle 场景：端到端投影覆盖更新、撤回、空块与同号多产品',async () => {
  const directory = await mkdtemp(join(tmpdir(),'scenario-'));
  source = await createSource({scenario:'lifecycle'});
  try {
    const rows = await collect(createClient(source.origin));
    assert.equal(rows.length,9);
    // m2 在投递列表中出现两次，两行投递 id 相同。
    assert.equal(rows.filter(r => r.id === 'press1:m2').length,2);
    const catalog = new Catalog(directory);
    const summary = await catalog.apply(rows,{source:source.origin,adapter:'block-aware'});
    assert.equal(summary.duplicates,1);
    assert.equal(summary.withdrawals,1);
    assert.equal(summary.products,3);
    const book1 = await catalog.get('press1:book1');
    // 撤回保留全部历史块。
    assert.equal(book1.lifecycle,'withdrawn');
    assert.equal(book1.withdrawnBy.messageId,'m5');
    assert.equal(book1.blocks.descriptive.value.title,'工厂里的科学');
    // m3 用显式空块清空 collateral。
    assert.equal(book1.blocks.collateral.state,'cleared');
    assert.equal(book1.blocks.collateral.clearReason,'empty-block');
    // m3 删除 s2 供货；m8 在撤回后用空数组清空整个 supply 块。
    assert.equal(book1.blocks.supply.state,'cleared');
    assert.equal(book1.blocks.supply.clearReason,'empty-block');
    // 同 ISBN 的套装与单册是两条独立产品。
    const set = await catalog.get('press1:book1-set');
    assert.equal(set.blocks.descriptive.value.title,'工厂里的科学（套装）');
    assert.notDeepEqual(set.identifiers,book1.identifiers);
    // 另一家出版社即使 recordReference 相同也独立成产品。
    const other = await catalog.get('press2:book1');
    assert.equal(other.lifecycle,'advance');
    // 消息级留痕完整：每条消息的覆盖/清空/未覆盖范围可追溯。
    const m2log = book1.messages.find(m => m.messageId === 'm2');
    assert.deepEqual(m2log.coveredBlocks.sort(),['collateral','supply']);
    assert.ok(m2log.notCoveredBlocks.includes('descriptive'));
    assert.ok(book1.explanations.some(line => line.includes('撤回')));
  } finally {await source.close();source = undefined;await rm(directory,{recursive:true,force:true});}
});
