import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Archive} from '../src/archive.mjs';
import {Catalog,recordKey,deliveryKey} from '../src/catalog.mjs';
import {createApi} from '../src/api.mjs';

const sampleRow = () => ({
  id:deliveryKey('press1','m1'),recordId:recordKey('press1','book1'),
  sender:'press1',recordReference:'book1',notificationType:'03',
  identifiers:[{type:'15',value:'9780000000001'}],
  blocks:{descriptive:{title:'一本书'},supply:[{supplierId:'s1',availability:'available'}]},
  deletedBlocks:[],messageId:'m1',
});

test('查询服务区分原件归档与业务投影',async () => {
  const directory = await mkdtemp(join(tmpdir(),'api-'));
  const archive = new Archive(directory);
  const catalog = new Catalog(directory);
  await archive.put([sampleRow()],{source:'local',adapter:'block-aware'});
  await catalog.apply([sampleRow()],{source:'local',adapter:'block-aware'});
  const api = await createApi(archive,catalog);
  try {
    assert.equal((await (await fetch(`${api.origin}/health`)).json()).status,'ok');
    assert.equal((await (await fetch(`${api.origin}/records`)).json()).length,1);
    const products = await (await fetch(`${api.origin}/products`)).json();
    assert.equal(products.length,1);
    assert.equal(products[0].key,'press1:book1');
    const detail = await (await fetch(`${api.origin}/products/press1:book1`)).json();
    assert.equal(detail.blocks.descriptive.value.title,'一本书');
    assert.deepEqual(detail.missingBlocks.map(b => b.block),['collateral']);
    assert.equal((await (await fetch(`${api.origin}/conflicts`)).json()).length,0);
    const missing = await fetch(`${api.origin}/products/nonexistent`);
    assert.equal(missing.status,404);
    const badMethod = await fetch(`${api.origin}/products`,{method:'POST'});
    assert.equal(badMethod.status,405);
    const unknown = await fetch(`${api.origin}/nope`);
    assert.equal(unknown.status,404);
  } finally {
    await api.close();
    await rm(directory,{recursive:true,force:true});
  }
});
