# 来源网关契约

GET /messages 返回按序消息；GET /messages/:id 返回 sender、recordReference、notificationType、identifiers、blocks、deletedBlocks。block 缺席表示未覆盖，显式空 block 表示清空该块。supply 内按 supplierId 区分。identifiers 有 type/value，recordReference 是来源记录身份；notificationType=03 出版确认（本来源提供完整块）、04 分块更新、02 提前信息、05 删除，均为本地网关枚举。

## 本地来源操作

默认场景 normal，其他场景为 partial。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行，每行对应一次消息投递（id=`sender:messageId`），不再按通知类型过滤：02/03/04/05 与未知类型都保留为独立投递行；重复领取产生同 id 重复行。产品身份是 `sender:recordReference`（行内字段 recordId），identifiers 的 type/value 原样保留，绝不使用单一 ISBN 合并——同号的套装、单册或不同出版社的记录各自成产品。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

## 分块投影约定（src/catalog.mjs）

Catalog.apply(rows, provenance) 在原件之上维护业务投影，状态持久化于同一 DATA_DIR 的 catalog.json（原子写入，可跨进程恢复）。

- 幂等身份：按投递 id 去重。同 id 同内容重放返回 duplicate，不改变任何当前值；同 id 内容不一致记入 /conflicts 且不重放，避免把被篡改或版本错位的消息当更新。
- 通知类型：02 提前信息把生命周期置为 advance；03 出版确认置为 confirmed 并提供完整块；04 分块更新不改生命周期，只处理消息内出现的块；05 撤回把生命周期置为 withdrawn 并记录 withdrawnBy，历史块全部保留不擦除；未知类型登记 anomalies 并标记 unapplied，不假装成功。
- 块覆盖语义：blocks 中缺席的键表示“未覆盖”，该块沿用旧值并在该消息留痕的 notCoveredBlocks 中列出；显式空块（null、{}、[]）表示“清空”，块状态置为 cleared 并记录 clearReason=empty-block。deletedBlocks 列出的块名按撤回处理（clearReason=deleted-notice）；本地约定 supply/<supplierId> 表示只撤回单个供货主体。
- supply 块：按 supplierId 逐个供货主体存储，消息只覆盖其中出现的主体，未出现的主体保留原值与各自来源；空数组清空整块。缺 supplierId 的条目不丢弃整批消息，登记 anomaly。
- 标识：identifiers 按 type 分别留痕并记录来源消息；重发某个类型不抹掉其他类型；显式空数组才清空全部标识。
- 可追溯性：每个值（标识、块、供货主体）都带 provenance（sender、messageId、notificationType、产品内序号）。产品视图的 messages 记录每次投递的 coveredBlocks、clearedBlocks、deletedBlocks、notCoveredBlocks；blockStatus/missingBlocks 巡检 descriptive、collateral、supply 的 present/cleared/missing 状态；explanations 给出采购可读的中文说明，包括“后续消息未覆盖该块，本地继续沿用旧值”。

## 查询服务端点

GET /health 健康检查；GET /records 原件归档；GET /products 业务投影产品列表；GET /products/:key 单个产品（key 为 sender:recordReference，缺失返回 404）；GET /conflicts 同 id 内容冲突清单。未知路径 404，非 GET 方法 405。
