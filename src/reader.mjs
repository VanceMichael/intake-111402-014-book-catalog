import {deliveryKey,recordKey} from './catalog.mjs';

// 标识保留来源的 type/value 原样：type 是标识类型（如 15=ISBN-13），
// 投影按类型分别留痕，绝不拿单一 ISBN 当合并键。
export function identifiers(values) {
  if (!Array.isArray(values)) throw new Error('identifiers must be a list');
  return values.map(item => ({type:String(item.type),value:String(item.value)}));
}

function normalize(item,messageId) {
  if (typeof item.sender !== 'string' || !item.sender) throw new Error(`message ${messageId} missing sender`);
  if (typeof item.recordReference !== 'string' || !item.recordReference) throw new Error(`message ${messageId} missing recordReference`);
  if (typeof item.notificationType !== 'string' || !item.notificationType) throw new Error(`message ${messageId} missing notificationType`);
  if (item.blocks !== undefined && (typeof item.blocks !== 'object' || item.blocks === null || Array.isArray(item.blocks))) {
    throw new Error(`message ${messageId} blocks must be an object`);
  }
  if (item.deletedBlocks !== undefined && !Array.isArray(item.deletedBlocks)) {
    throw new Error(`message ${messageId} deletedBlocks must be a list`);
  }
}

// 每次投递产生独立的一行：重复领取保留同 id 的重复行，由业务投影按投递身份幂等；
// 同 ISBN 的套装与单册 recordReference 不同，recordId 不同，不会合并。
export async function collect(client) {
  const listing = await client('/messages');
  const rows = [];
  for (const messageId of listing.items) {
    const item = await client(`/messages/${messageId}`);
    normalize(item,messageId);
    rows.push({
      id:deliveryKey(item.sender,messageId),
      recordId:recordKey(item.sender,item.recordReference),
      sender:item.sender,
      recordReference:item.recordReference,
      notificationType:item.notificationType,
      identifiers:identifiers(item.identifiers ?? []),
      // 缺席与空块是两种语义：块键缺席=未覆盖；null/{} /[] =显式清空。
      blocks:item.blocks ?? {},
      deletedBlocks:Array.isArray(item.deletedBlocks) ? item.deletedBlocks.map(String) : [],
      messageId:String(messageId),
    });
  }
  return rows;
}
