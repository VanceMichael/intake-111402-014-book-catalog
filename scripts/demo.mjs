import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {Catalog} from '../src/catalog.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const scenario = process.env.SCENARIO ?? 'lifecycle';
const source = await createSource({scenario});
const archive = new Archive(directory);
const catalog = new Catalog(directory);
const api = await createApi(archive,catalog);
try {
  console.log('本地来源',source.origin,'场景',scenario);
  const rows = await collect(createClient(source.origin));
  const provenance = {source:source.origin,adapter:'block-aware'};
  console.log('原件归档',JSON.stringify(await archive.put(rows,provenance)));
  console.log('分块投影',JSON.stringify(await catalog.apply(rows,provenance)));
  for (const product of await catalog.list()) {
    console.log(`\n=== 产品 ${product.key}（生命周期：${product.lifecycle}）===`);
    for (const line of product.explanations) console.log(' -',line);
    if (product.anomalies.length) console.log(' - 异常：',JSON.stringify(product.anomalies));
  }
  const conflicts = await catalog.conflicts();
  if (conflicts.length) console.log('\n投递内容冲突',JSON.stringify(conflicts));
  const response = await fetch(`${api.origin}/products/press1:book1`);
  console.log('\n查询示例 GET /products/press1:book1 ->',response.status);
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
