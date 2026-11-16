# 图书目录更新消息的分块属性接入

出版社目录收件器。已有短标识/长标识对照和完整摘要导入；支持 ONIX 网关的 JSON 消息投影。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /products 返回分块业务投影，GET /products/:key 查看单产品的字段来源与缺失块巡检，GET /conflicts 查看同 id 内容冲突，GET /health 检查服务。

## 分块更新如何接入

- src/reader.mjs 不再只收 03 完整书目：02 提前信息、03 出版确认、04 分块更新、05 撤回通知都作为独立投递行保留。行 id 是 `sender:messageId`（投递身份，用于重复投递幂等），产品身份 recordId 是 `sender:recordReference`——同 ISBN 的套装与单册 recordReference 不同，不会被粗暴合并；标识的 type/value 原样保留并按类型分别留痕。
- src/catalog.mjs 在原件归档之上维护业务投影（catalog.json）。blocks 中缺席的块表示未覆盖、沿用旧值；显式空块（null/{}/[]）才是清空；deletedBlocks 是撤回通知。supply 按 supplierId 分主体覆盖，互不擦除，`supply/<supplierId>` 形式的删除只撤单个供货商。
- 每个标识、信息块和供货主体都记录来自哪次消息（provenance）；产品视图的 messages 给出每次投递的覆盖/清空/未覆盖清单，missingBlocks 显示当前缺哪个信息块，explanations 用中文说明本地为何沿用旧值，空字段不会悄悄擦掉未重发的信息。05 撤回只标记 withdrawn 并保留全部历史。
- 重复投递按投递 id 幂等：同内容重放不产生变化；同 id 但内容不同记为冲突（GET /conflicts）且不重放。

```sh
docker build --network=none -t book-catalog .
docker run --rm --network=none book-catalog npm test
docker run --rm --network=none book-catalog npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。
- src/catalog.mjs 是分块业务投影：块覆盖/清空/撤回、供货主体隔离、标识留痕、撤回生命周期与投递幂等。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。lifecycle 场景覆盖分块更新、空块清空、撤回、重复投递与同号多产品。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
