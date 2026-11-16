import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// 本网关投影出现的信息块词汇；未出现于此的块名照常存储，只是不参与“缺失”巡检。
export const EXPECTED_BLOCKS = ['descriptive','collateral','supply'];
const STATE_VERSION = 1;
const KNOWN_TYPES = ['02','03','04'];

// 产品身份来自来源记录（sender + recordReference），绝不使用 ISBN 合并：
// 同号的套装与单册只要 recordReference 不同就是两条产品。
export function recordKey(sender, recordReference) { return `${String(sender)}:${String(recordReference)}`; }
// 单次投递的身份：同一条消息可能被重复领取，据此幂等。
export function deliveryKey(sender, messageId) { return `${String(sender)}:${String(messageId)}`; }
export function messageDigest(row) { return createHash('sha256').update(JSON.stringify(row)).digest('hex'); }

const clone = value => structuredClone(value);

function blankState() { return {version:STATE_VERSION,deliveries:[],conflicts:[],products:{}}; }
export const blankStateForTest = blankState;
function blankProduct(row) {
  return {key:row.recordId,sender:row.sender,recordReference:row.recordReference,
    lifecycle:'unknown',withdrawnBy:null,identifiers:{},blocks:{},messages:[],anomalies:[]};
}
function isEmptyBlock(value) {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
function clearBlock(product,name,provenance,reason,log) {
  product.blocks[name] = {state:'cleared',value:null,clearReason:reason,provenance};
  log.clearedBlocks.push(name);
}
function applySupply(product,content,provenance,log) {
  if (isEmptyBlock(content)) {
    product.blocks.supply = {state:'cleared',suppliers:{},clearReason:'empty-block',provenance};
    log.clearedBlocks.push('supply');
    return;
  }
  if (!Array.isArray(content)) {
    product.anomalies.push({messageId:provenance.messageId,reason:'supply-block-not-array'});
    return;
  }
  let block = product.blocks.supply;
  if (!block || block.state === 'cleared') block = {state:'present',suppliers:{},provenance};
  block.state = 'present';
  block.provenance = provenance;
  for (const item of content) {
    const supplierId = item?.supplierId === undefined ? undefined : String(item.supplierId);
    if (!supplierId) {
      product.anomalies.push({messageId:provenance.messageId,reason:'supply-entry-missing-supplier-id'});
      continue;
    }
    // 按供货主体逐条覆盖：消息里没有的供货商保持原值，互不覆盖。
    block.suppliers[supplierId] = {value:clone(item),provenance};
  }
  product.blocks.supply = block;
  log.coveredBlocks.push('supply');
}
function applyDeletedBlock(product,target,provenance,log) {
  if (target === 'supply' || target.startsWith('supply/')) {
    if (target === 'supply') {
      product.blocks.supply = {state:'cleared',suppliers:{},clearReason:'deleted-notice',provenance};
      log.clearedBlocks.push('supply');
    } else {
      // 本地约定：supply/<supplierId> 表示撤回单个供货主体，其余供货商不动。
      const supplierId = target.slice('supply/'.length);
      const block = product.blocks.supply;
      if (block?.state === 'present' && Object.hasOwn(block.suppliers,supplierId)) {
        delete block.suppliers[supplierId];
        block.provenance = provenance;
      } else {
        product.anomalies.push({messageId:provenance.messageId,reason:'deleted-block-target-absent',target});
      }
    }
    log.deletedBlocks.push(target);
    return;
  }
  product.blocks[target] = {state:'cleared',value:null,clearReason:'deleted-notice',provenance};
  log.clearedBlocks.push(target);
  log.deletedBlocks.push(target);
}

// 纯函数：把一条领取行应用到内存状态，返回处理结果分类，便于无文件单测。
export function applyMessage(state,row,run = {}) {
  const digest = messageDigest(row);
  const existing = state.deliveries.find(entry => entry.id === row.id);
  if (existing) {
    if (existing.digest !== digest) {
      state.conflicts.push({id:row.id,recordKey:row.recordId,storedDigest:existing.digest,receivedDigest:digest});
      return 'conflict';
    }
    return 'duplicate';
  }
  if (!state.products[row.recordId]) state.products[row.recordId] = blankProduct(row);
  const product = state.products[row.recordId];
  const sequence = product.messages.length + 1;
  const provenance = {sender:row.sender,messageId:row.messageId,notificationType:row.notificationType,sequence};
  const log = {messageId:row.messageId,notificationType:row.notificationType,sequence,result:'applied',
    coveredBlocks:[],clearedBlocks:[],deletedBlocks:[],notCoveredBlocks:[],identifiers:[]};
  state.deliveries.push({id:row.id,digest,recordKey:row.recordId,source:run.source ?? null,adapter:run.adapter ?? null});

  if (row.notificationType === '05') {
    // 撤回通知：标记生命周期并保留全部历史块，不做物理擦除。
    product.lifecycle = 'withdrawn';
    product.withdrawnBy = provenance;
    log.result = 'withdrawal';
    product.messages.push(log);
    return 'withdrawal';
  }
  if (!KNOWN_TYPES.includes(row.notificationType)) {
    log.result = 'unapplied';
    log.reason = 'unknown-notification-type';
    product.anomalies.push({messageId:row.messageId,reason:log.reason,notificationType:row.notificationType});
    product.messages.push(log);
    return 'unapplied';
  }
  if (row.notificationType === '02') product.lifecycle = 'advance';
  else if (row.notificationType === '03') product.lifecycle = 'confirmed';
  // 04 不改变生命周期：提前信息仍提前，已确认仍确认。

  if (Array.isArray(row.identifiers)) {
    log.identifiers = row.identifiers.map(item => ({type:item.type,value:item.value}));
    if (row.identifiers.length === 0) {
      product.identifiers = {};
      log.clearedBlocks.push('identifiers');
    } else {
      // 标识按 type 分别留痕：重发某个类型不会抹掉其他类型。
      for (const ident of row.identifiers) {
        product.identifiers[ident.type] = {type:ident.type,value:ident.value,provenance};
      }
    }
  }

  const knownBefore = Object.keys(product.blocks);
  const touched = new Set();
  for (const [name,content] of Object.entries(row.blocks)) {
    touched.add(name);
    if (name === 'supply') applySupply(product,content,provenance,log);
    else if (isEmptyBlock(content)) clearBlock(product,name,provenance,'empty-block',log);
    else {
      product.blocks[name] = {state:'present',value:clone(content),provenance};
      log.coveredBlocks.push(name);
    }
  }
  for (const target of row.deletedBlocks) {
    touched.add(target.split('/')[0]);
    applyDeletedBlock(product,target,provenance,log);
  }
  log.coveredBlocks.sort();
  log.clearedBlocks.sort();
  // 本产品已有、但本次消息没有覆盖的块：解释“为何沿用旧值”的直接证据。
  log.notCoveredBlocks = knownBefore.filter(name => !touched.has(name)).sort();
  product.messages.push(log);
  return 'applied';
}

function explain(product) {
  const lines = [];
  const typeName = type => ({'02':'提前信息','03':'出版确认','04':'分块更新','05':'撤回通知'})[type] ?? `未知类型 ${type}`;
  const sourceText = provenance => `消息 ${provenance.messageId}（${typeName(provenance.notificationType)}，序号 ${provenance.sequence}）`;
  lines.push(`产品 ${product.key} 当前生命周期：${product.lifecycle}`);
  if (product.withdrawnBy) lines.push(`产品已由${sourceText(product.withdrawnBy)}撤回，历史信息块全部保留供核对`);
  for (const ident of Object.values(product.identifiers).sort((a,b) => a.type.localeCompare(b.type))) {
    lines.push(`标识 type=${ident.type} value=${ident.value} 来自${sourceText(ident.provenance)}`);
  }
  for (const name of [...EXPECTED_BLOCKS,...Object.keys(product.blocks).filter(n => !EXPECTED_BLOCKS.includes(n))].filter((n,i,a) => a.indexOf(n) === i).sort()) {
    const block = product.blocks[name];
    if (!block) { lines.push(`信息块 ${name} 从未收到，当前缺失`); continue; }
    if (block.state === 'cleared') {
      lines.push(`信息块 ${name} 已被${sourceText(block.provenance)}清空（${block.clearReason}），并非缺失`);
      continue;
    }
    const skipped = product.messages.filter(m => m.notCoveredBlocks.includes(name)).map(m => m.messageId);
    const tail = skipped.length ? `；后续消息 ${skipped.join('、')} 未覆盖该块，本地继续沿用旧值` : '';
    lines.push(`信息块 ${name} 的当前值来自${sourceText(block.provenance)}${tail}`);
    if (name === 'supply') {
      for (const supplierId of Object.keys(block.suppliers).sort()) {
        lines.push(`供货主体 ${supplierId} 的供货状态来自${sourceText(block.suppliers[supplierId].provenance)}`);
      }
    }
  }
  return lines;
}

// 转为对外视图：数组排序、补充块状态巡检与可读解释，内部状态不直接外泄。
export function viewProduct(product) {
  const identifiers = Object.values(product.identifiers)
    .sort((a,b) => a.type.localeCompare(b.type)).map(entry => ({type:entry.type,value:entry.value,provenance:clone(entry.provenance)}));
  const blocks = {};
  for (const [name,block] of Object.entries(product.blocks)) {
    if (name === 'supply') {
      const suppliers = {};
      for (const supplierId of Object.keys(block.suppliers ?? {}).sort()) suppliers[supplierId] = clone(block.suppliers[supplierId]);
      blocks.supply = {state:block.state,clearReason:block.clearReason ?? null,provenance:clone(block.provenance),suppliers};
    } else {
      blocks[name] = clone(block);
    }
  }
  const blockStatus = EXPECTED_BLOCKS.map(name => {
    const block = product.blocks[name];
    if (!block) return {block:name,status:'missing',reason:'never-covered'};
    if (block.state === 'cleared') return {block:name,status:'cleared',reason:block.clearReason,provenance:clone(block.provenance)};
    if (name === 'supply' && Object.keys(block.suppliers ?? {}).length === 0) {
      return {block:name,status:'missing',reason:'no-active-supplier',provenance:clone(block.provenance)};
    }
    return {block:name,status:'present',provenance:clone(block.provenance)};
  });
  return {
    key:product.key,sender:product.sender,recordReference:product.recordReference,
    lifecycle:product.lifecycle,withdrawnBy:product.withdrawnBy ? clone(product.withdrawnBy) : null,
    identifiers,blocks,
    blockStatus,missingBlocks:blockStatus.filter(entry => entry.status !== 'present'),
    messages:clone(product.messages),anomalies:clone(product.anomalies),
    explanations:explain(product),
  };
}

export class Catalog {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); this.loaded = null; }
  async #load() {
    if (this.loaded) return this.loaded;
    const loading = readFile(join(this.directory,'catalog.json'),'utf8')
      .then(text => JSON.parse(text))
      .catch(error => { if (error.code === 'ENOENT') return blankState(); throw error; });
    // 读取失败不缓存拒绝态，允许下一次调用重新加载。
    loading.catch(() => { if (this.loaded === loading) this.loaded = null; });
    this.loaded = loading;
    return loading;
  }
  async #persist(state) {
    await mkdir(this.directory,{recursive:true});
    const temporary = join(this.directory,`catalog-${randomUUID().slice(0,8)}.tmp`);
    await writeFile(temporary,JSON.stringify(state,null,2)+'\n');
    const handle = await open(temporary,'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary,join(this.directory,'catalog.json'));
  }
  apply(rows,provenance = {}) {
    const operation = this.serial.then(async () => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) throw new Error('record id required');
      const state = await this.#load();
      const summary = {received:rows.length,applied:0,duplicates:0,conflicts:0,unapplied:0,withdrawals:0,products:0};
      let changed = false;
      for (const row of rows) {
        const outcome = applyMessage(state,row,provenance);
        if (outcome === 'applied') { summary.applied++; changed = true; }
        else if (outcome === 'duplicate') summary.duplicates++;
        else if (outcome === 'conflict') summary.conflicts++;
        else if (outcome === 'withdrawal') { summary.withdrawals++; changed = true; }
        else if (outcome === 'unapplied') { summary.unapplied++; changed = true; }
      }
      summary.products = Object.keys(state.products).length;
      if (changed) await this.#persist(state);
      return summary;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async list() {
    const state = await this.#load();
    return Object.keys(state.products).sort().map(key => viewProduct(state.products[key]));
  }
  async get(key) {
    const state = await this.#load();
    const product = state.products[key];
    return product ? viewProduct(product) : null;
  }
  async conflicts() {
    const state = await this.#load();
    return clone(state.conflicts);
  }
}
