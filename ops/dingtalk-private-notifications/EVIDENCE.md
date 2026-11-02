# 普通文本/Markdown 可行性证据（AI 卡片由哪里决定）

调查日期 2026-11-02，全部为本机只读源码/配置检查，未读取或输出凭据，未发送任何消息。

## 结论

私人钉钉机器人（@dingtalk-real-ai/dingtalk-connector 插件）**支持普通文本/Markdown 单聊**，
无需改插件代码：插件自带的 Gateway 方法 `dingtalk-connector.send` / `sendToUser` 接受
`useAICard:false` + `msgType:"markdown"|"text"`，走钉钉 `POST /v1.0/robot/oToMessages/batchSend`
（msgKey `sampleMarkdown` / `sampleText`），即非 AI 卡片的普通消息。

## AI 卡片由哪里决定

连接器安装路径：`~/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector/dist/`

1. **单聊自动回复固定 AI Card，无配置开关。** `message-handler-C8eu5xwl.mjs:433-435`：
   `groupReplyMode`（取值 aicard/text/markdown）只在 `!isDirect`（群聊）时禁用卡片；
   单聊会话 `isDirect=true`，永远走卡片流式回复。配置 schema `GroupReplyModeSchema`
   （`runtime-CalLOr7V.mjs:446-463`）注释明确该模式仅面向群聊多 Agent 互 @ 场景。
2. **OpenClaw 核心 message 工具 / `openclaw message send` 也是卡片。** 核心出站投递路由到
   插件 channel surface 的 `sendText`（本仓库 `src/infra/outbound/deliver-channel.ts:195,480`），
   插件侧 `runtime-CalLOr7V.mjs:2992-3001` → `sendTextToDingTalk`（2385 行）→
   `sendProactive(config, target, text, { msgType: "text", replyToId })`，未传 `useAICard`，
   在 `sendProactiveInternal`（2646-2664 行）默认 `useAICard = true` →
   `createAICardForTarget` + `finishAICard`（卡片实例 API `/v1.0/card/instances[/deliver]`）。
   现场证据：`~/.openclaw/dingtalk-connector/message-context.json` 出站自动回复均为
   `card_<时间戳>_<随机>` 形态 id。
3. **普通消息路径同在插件内。** `sendProactiveInternal`（2666 行起）：`useAICard:false` 或
   卡片创建失败且 `fallbackToNormal`（默认 true）时，走
   `robot/oToMessages/batchSend`（单聊）/ `robot/groupMessages/send`（群聊），
   `body = { robotCode: clientId, msgKey, msgParam }`（2696-2720 行）；
   `buildMsgPayload`（2326-2377 行）把 `msgType:"markdown"` 映射为
   msgKey `sampleMarkdown`（msgParam `{title, text}`）、`"text"` 映射为 `sampleText`。
   `sendProactive`（2611 行）在未显式指定 msgType 时按内容自动判 markdown。
4. **该参数的现成入口。** 插件注册的 Gateway 方法（`card-bridge-CEKrZFzt.mjs:236-388`）：
   `dingtalk-connector.sendToUser`（userId/userIds + content + msgType + title + useAICard）、
   `dingtalk-connector.sendToGroup`、`dingtalk-connector.send`
   （target 形如 `user:<staffId>` / `group:<openConversationId>`）。
   三处均以 `useAICard: useAICard !== false` 传入，即调用方传 `useAICard:false` 即关闭卡片。
   CLI 调用方式：`openclaw gateway call dingtalk-connector.send --params '<json>' --json`
   （本仓库 `src/cli/gateway-cli/register.ts:433-460`；方法级 `respond(false,…)` 可能仍以
   退出码 0 返回 JSON，必须解析结果中的 `ok` 字段判断成败）。
5. **单条长度限制。** 普通消息路径**无内建分块**（channel surface 的 chunker 只服务
   `sendText` 卡片路径）；钉钉侧单条上限 2000 字符（`~/.openclaw/plugin-skills/dingtalk-channel-rules`
   SKILL.md「消息格式」节）。超长需要调用方自行分块——`dingtalk-notify.mjs` 已按 ≤1900
   字符行边界切分。

## 已排除的通道（有证据的不适用项）

- **`dws chat message send-by-bot`**：对本应用不可用。connector skill
  （`~/.openclaw/agents/main/agent/workshop-skills/dingtalk-channel-connector/SKILL.md`
  「Send to third parties」节）已记录其走钉钉 IPaaS 并失败
  `dingOpenErrcode 400106 robot 不存在`；该应用的 robot 只存在于直连 Open API 路径
  （连接器自己的发送器即 `robotCode = clientId` 直打 `robot/oToMessages/batchSend`）。
- **`dws auth status` 的 user_id 作为接收人 ID**：2026-11-02 16:06 真实测试证实不可用。
  Gateway/connector 健康、`dingtalk-connector.send` 调用以 `useAICard:false` 正常到达
  API，但以 dws user_id 为 userIds 时钉钉返回 `staffId.notExisted`，0/1 未送达。
  合法接收人是连接器消息上下文（`~/.openclaw/dingtalk-connector/message-context.json`）
  里本人私人会话 inbound 记录的 senderId：该会话多条 inbound 的 senderId 为同一个
  一致的 20 位纯数字 ID（与 dws user_id 不同），即 `oToMessages/batchSend` userIds
  接受的 staffId。该 ID 不写入本文档与任何交付物。
- **群回复模式 `groupReplyMode`**：只影响群聊，且本通知场景是单聊，不适用。
- **DM 自动回复关卡片**：插件无此配置（见第 1 条），不做全局改造去 patch 插件。

## 真实测试记录（2026-11-02 16:06，tower 执行）

- 调用：`dingtalk-connector.send`，`target=user:<dws user_id>`，`useAICard:false`，
  `msgType:markdown`——路线正确到达 API。
- 结果：失败 `staffId.notExisted`（未送达），message-context 无新增测试记录。
- 根因：dws user_id ≠ oToMessages staffId（见上节）。
- 处置（本返工）：目标权威改为连接器上下文 inbound senderId，fail-closed 解析；
  目标安全模型（钉定 + 精确匹配 + group/foreign 拒绝）保持不变。

## 现场状态（只读核验 2026-11-02）

- 频道：私人机器人绑定为 dingtalk-connector 插件（`~/.openclaw/dingtalk-connector/message-context.json`
  存在本人单聊会话记录；插件安装见上）。
- collector 自动化（id `6a45be21-ce0b-4b8b-8986-4c885d1ea659`，`openclaw cron get` 只读核验）：`enabled=true`，
  `schedule every 600000ms`，`payload.timeoutSeconds=600`，`payload.lightContext=true`，
  `payload.toolsAllow` 含 `exec`（唤醒轮可执行本包包装脚本），
  **`delivery.mode="none"`（保持不变）**；现行 payload/trigger 措辞为「灯效渠道」。
