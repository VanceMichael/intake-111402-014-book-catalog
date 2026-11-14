export function identifiers(values) { return values.map(item => ({type:String(item.type),value:String(item.value)})); }
export async function collect(client) {
  const listing = await client('/messages');
  const rows = [];
  for (const messageId of listing.items) {
    const item = await client(`/messages/${messageId}`);
    if (item.notificationType !== '03') continue;
    rows.push({id:`${item.sender}:${item.recordReference}`,title:item.blocks.descriptive.title,identifiers:identifiers(item.identifiers),messageId});
  }
  return rows;
}
