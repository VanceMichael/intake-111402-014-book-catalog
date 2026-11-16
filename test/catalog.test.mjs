import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Catalog,applyMessage,recordKey,deliveryKey,blankStateForTest} from '../src/catalog.mjs';

// blankStateForTest 由 catalog.mjs 导出；若未导出则用 applyMessage 自然建状态。
function newState() { return blankStateForTest(); }

function row(overrides = {}) {
  return {
    id:deliveryKey('press1',overrides.messageId ?? 'm1'),
    recordId:recordKey('press1',overrides.recordReference ?? 'book1'),
    sender:'press1',recordReference:overrides.recordReference ?? 'book1',
    notificationType:overrides.notificationType ?? '03',
    identifiers:overrides.identifiers ?? [{type:'15',value:'9780000000001'}],
    blocks:overrides.blocks ?? {descriptive:{title:'旧标题'},supply:[{supplierId:'s1',availability:'available'}]},
    deletedBlocks:overrides.deletedBlocks ?? [],
    messageId:overrides.messageId ?? 'm1',
  };
}

test('04 分块更新只覆盖消息内信息块，未重发的块沿用旧值', () => {
  const state = newState();
  applyMessage(state,row());
  applyMessage(state,row({messageId:'m2',notificationType:'04',identifiers:[],
    blocks:{collateral:{cover:'/cover/new'}}}));
  const product = state.products['press1:book1'];
  assert.equal(product.blocks.descriptive.value.title,'旧标题');
  assert.equal(product.blocks.descriptive.provenance.messageId,'m1');
  assert.equal(product.blocks.collateral.value.cover,'/cover/new');
  assert.equal(product.blocks.collateral.provenance.messageId,'m2');
  const m2log = product.messages.find(m => m.messageId === 'm2');
  assert.deepEqual(m2log.coveredBlocks,['collateral']);
  assert.deepEqual(m2log.notCoveredBlocks,['descriptive','supply']);
  assert.equal(product.lifecycle,'confirmed');
});

test('同一条消息重复投递幂等，不同内容同 id 记为冲突且不重放', () => {
  const state = newState();
  assert.equal(applyMessage(state,row()),'applied');
  assert.equal(applyMessage(state,row()),'duplicate');
  const tampered = row({blocks:{descriptive:{title:'被篡改'}}});
  assert.equal(applyMessage(state,tampered),'conflict');
  assert.equal(state.products['press1:book1'].blocks.descriptive.value.title,'旧标题');
  assert.equal(state.conflicts.length,1);
});

test('供货按供货商主体分别覆盖，互不擦除', () => {
  const state = newState();
  applyMessage(state,row());
  applyMessage(state,row({messageId:'m2',notificationType:'04',identifiers:[],
    blocks:{supply:[{supplierId:'s2',availability:'backorder'}]}}));
  const supply = state.products['press1:book1'].blocks.supply;
  assert.deepEqual(Object.keys(supply.suppliers).sort(),['s1','s2']);
  assert.equal(supply.suppliers.s1.provenance.messageId,'m1');
  assert.equal(supply.suppliers.s2.provenance.messageId,'m2');
  applyMessage(state,row({messageId:'m3',notificationType:'04',identifiers:[],
    blocks:{},deletedBlocks:['supply/s2']}));
  assert.deepEqual(Object.keys(state.products['press1:book1'].blocks.supply.suppliers),['s1']);
});

test('显式空块是清空语义，与块缺席（未覆盖）严格区分', () => {
  const state = newState();
  applyMessage(state,row({messageId:'m1',blocks:{descriptive:{title:'旧标题'},collateral:{cover:'/old'},
    supply:[{supplierId:'s1',availability:'available'}]}}));
  applyMessage(state,row({messageId:'m2',notificationType:'04',identifiers:[],
    blocks:{collateral:{}}}));
  const product = state.products['press1:book1'];
  assert.equal(product.blocks.collateral.state,'cleared');
  assert.equal(product.blocks.collateral.clearReason,'empty-block');
  assert.equal(product.blocks.descriptive.state,'present');
  const m2log = product.messages.find(m => m.messageId === 'm2');
  assert.deepEqual(m2log.clearedBlocks.filter(name => name !== 'identifiers'),['collateral']);
  assert.deepEqual(m2log.notCoveredBlocks,['descriptive','supply']);
});

test('空数组清空整个 supply 块，而不是保留任何供货商', () => {
  const state = newState();
  applyMessage(state,row());
  applyMessage(state,row({messageId:'m9',notificationType:'04',identifiers:[],blocks:{supply:[]}}));
  const supply = state.products['press1:book1'].blocks.supply;
  assert.equal(supply.state,'cleared');
  assert.deepEqual(supply.suppliers,{});
});

test('deletedBlocks 撤回整块并记录原因，不影响其他块', () => {
  const state = newState();
  applyMessage(state,row());
  applyMessage(state,row({messageId:'m4',notificationType:'04',identifiers:[],
    blocks:{},deletedBlocks:['descriptive']}));
  const product = state.products['press1:book1'];
  assert.equal(product.blocks.descriptive.state,'cleared');
  assert.equal(product.blocks.descriptive.clearReason,'deleted-notice');
  assert.equal(product.blocks.supply.state,'present');
  assert.deepEqual(product.messages.at(-1).deletedBlocks,['descriptive']);
});

test('05 撤回通知标记撤回并保留全部历史，不擦除块', () => {
  const state = newState();
  applyMessage(state,row());
  const outcome = applyMessage(state,row({messageId:'m5',notificationType:'05',identifiers:[],blocks:{}}));
  assert.equal(outcome,'withdrawal');
  const product = state.products['press1:book1'];
  assert.equal(product.lifecycle,'withdrawn');
  assert.equal(product.withdrawnBy.messageId,'m5');
  assert.equal(product.blocks.descriptive.value.title,'旧标题');
});

test('02 提前信息保留类型含义；04 不把生命周期改回确认', () => {
  const state = newState();
  applyMessage(state,row({messageId:'a',notificationType:'02',
    blocks:{descriptive:{title:'预告标题'}}}));
  assert.equal(state.products['press1:book1'].lifecycle,'advance');
  applyMessage(state,row({messageId:'b',notificationType:'04',identifiers:[],
    blocks:{collateral:{cover:'/x'}}}));
  assert.equal(state.products['press1:book1'].lifecycle,'advance');
  applyMessage(state,row({messageId:'c',notificationType:'03',
    blocks:{descriptive:{title:'正式标题'}}}));
  assert.equal(state.products['press1:book1'].lifecycle,'confirmed');
});

test('同 ISBN 的套装、单册与不同出版社各自成产品，不按 ISBN 合并', () => {
  const state = newState();
  applyMessage(state,row({messageId:'m1',recordReference:'book1'}));
  applyMessage(state,row({messageId:'m6',recordReference:'book1-set',
    blocks:{descriptive:{title:'套装'},supply:[{supplierId:'s1',availability:'available'}]}}));
  applyMessage(state,{...row({messageId:'m7',recordReference:'book1'}),
    id:deliveryKey('press2','m7'),recordId:recordKey('press2','book1'),sender:'press2',
    notificationType:'02',blocks:{descriptive:{title:'别家的书'}}});
  assert.deepEqual(Object.keys(state.products).sort(),['press1:book1','press1:book1-set','press2:book1']);
  assert.notEqual(state.products['press1:book1'].blocks.descriptive.value.title,
    state.products['press2:book1'].blocks.descriptive.value.title);
});

test('标识按类型留痕，重发单个类型不抹掉其他类型；空数组才清空', () => {
  const state = newState();
  applyMessage(state,row({identifiers:[{type:'15',value:'9780000000001'},{type:'03',value:'PRESS-BOOK1'}]}));
  applyMessage(state,row({messageId:'m2',notificationType:'04',
    identifiers:[{type:'15',value:'9780000000002'}]}));
  const product = state.products['press1:book1'];
  assert.equal(product.identifiers['15'].value,'9780000000002');
  assert.equal(product.identifiers['03'].value,'PRESS-BOOK1');
  applyMessage(state,row({messageId:'m3',notificationType:'04',identifiers:[]}));
  assert.deepEqual(product.identifiers,{});
});

test('未知通知类型不假装成功：留痕为未应用并记录异常', () => {
  const state = newState();
  const outcome = applyMessage(state,row({messageId:'x',notificationType:'99'}));
  assert.equal(outcome,'unapplied');
  const product = state.products['press1:book1'];
  assert.equal(product.messages[0].result,'unapplied');
  assert.equal(product.anomalies[0].reason,'unknown-notification-type');
});

test('缺 supplierId 的供货条目进入异常清单，不中断整批处理', () => {
  const state = newState();
  applyMessage(state,row({messageId:'m1',blocks:{supply:[{availability:'available'}]}}));
  const product = state.products['press1:book1'];
  assert.equal(product.anomalies[0].reason,'supply-entry-missing-supplier-id');
});

test('视图暴露缺失块巡检与可读的沿用旧值解释', async () => {
  const directory = await mkdtemp(join(tmpdir(),'catalog-'));
  try {
    const catalog = new Catalog(directory);
    const summary = await catalog.apply([row()],{source:'http://127.0.0.1:1',adapter:'block-aware'});
    assert.equal(summary.applied,1);
    const product = await catalog.get('press1:book1');
    assert.deepEqual(product.blockStatus.map(b => b.block),['descriptive','collateral','supply']);
    assert.deepEqual(product.missingBlocks.map(b => b.block),['collateral']);
    assert.equal(product.missingBlocks[0].reason,'never-covered');
    await catalog.apply([row({messageId:'m2',notificationType:'04',identifiers:[],
      blocks:{collateral:{cover:'/c'}}})]);
    const updated = await catalog.get('press1:book1');
    assert.ok(updated.explanations.some(line => line.includes('未覆盖该块')));
    assert.ok(updated.explanations.some(line => line.includes('消息 m1')));
    // 重新打开目录：状态已落盘且可恢复。
    const reloaded = await new Catalog(directory).get('press1:book1');
    assert.equal(reloaded.blocks.collateral.value.cover,'/c');
    const onDisk = JSON.parse(await readFile(join(directory,'catalog.json'),'utf8'));
    assert.equal(onDisk.version,1);
    // 再跑一次同样的批次：幂等，不新增消息、不重写。
    const again = await catalog.apply([row(),row({messageId:'m2',notificationType:'04',identifiers:[],
      blocks:{collateral:{cover:'/c'}}})]);
    assert.equal(again.duplicates,2);
    assert.equal((await catalog.list()).length,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('Catalog 拒绝无 id 的行', async () => {
  const directory = await mkdtemp(join(tmpdir(),'catalog-bad-'));
  try {
    await assert.rejects(new Catalog(directory).apply([{messageId:'z'}]),/record id/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
