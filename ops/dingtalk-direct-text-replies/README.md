# DingTalk 私聊自动回复改为普通 Markdown（directReplyMode）

状态：**补丁与验证已就绪，未部署**。本文档面向部署决策（tower/用户审批后执行）。
目标安装：`~/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector`（npm 版 `0.8.27`，上游 [DingTalk-Real-AI/dingtalk-openclaw-connector](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector)）。

## 1. 问题

用户在钉钉与玲珑私聊时仍收到 AI 卡片，要求改掉。此前只把 collector 主动通知改成普通 Markdown；私聊自动回复仍由 `@dingtalk-real-ai/dingtalk-connector` 的 direct 流程固定走 AI Card。

## 2. 根因（0.8.27 安装产物调用链）

私聊回复由 `handleDingTalkMessage` → `dispatchConversation` → `createDingtalkReplyDispatcher`（`src/reply-dispatcher.ts`，打包进 `dist/message-handler-C8eu5xwl.mjs`）处理：

```ts
// src/reply-dispatcher.ts:240-248（dist message-handler-C8eu5xwl.mjs:433-436）
const groupReplyMode = account.config?.groupReplyMode || "aicard";
const isTextMode = !isDirect && (groupReplyMode === "text" || groupReplyMode === "markdown"); // ← 单聊被排除
const streamingEnabled = !isTextMode && account.config?.streaming !== false;
```

- 单聊 `isDirect=true` → `isTextMode` 恒为 false → `streamingEnabled=true` → `onReplyStart` 即创建 AI Card（`POST /v1.0/card/instances` + `/deliver`），流式 `PUT /v1.0/card/streaming`，final 经 `finishAICard`（`PUT /v1.0/card/instances`, flowStatus=3）收口。这就是用户看到的卡片。
- 群聊已有 `groupReplyMode: 'text'|'markdown'` 纯文本能力，但被 `!isDirect` 显式排除在单聊之外。
- **没有纯配置路径**：配置 schema（`src/config/schema.ts`，`.strict()`）不认识 `streaming`（代码里 `(account.config as any)?.streaming` 是读不到的死配置键），也没有任何单聊回复模式键。设置 `groupReplyMode: 'markdown'` 对单聊无效。上游 npm 最新即 0.8.27，无可升级版本。

本机账号现状：`channels.dingtalk-connector` 为 `dmPolicy: allowlist` + `groupPolicy: disabled`（只用单聊），未设置 `groupReplyMode`。

## 3. 方案

新增单聊配置键 **`directReplyMode`**（`aicard`|`text`|`markdown`，默认 `aicard`，与 `groupReplyMode` 完全对称），补丁共改 4 个文件（src 2 + dist 2）：

| 文件                                | 修改                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/schema.ts`              | 新增 `DirectReplyModeSchema`，加入 `DingtalkSharedConfigShape`（顶层与每账号都可用）                                                  |
| `src/reply-dispatcher.ts`           | `replyMode = isDirect ? directReplyMode : groupReplyMode`；`isTextMode = replyMode text/markdown`；发送格式选择与日志改用 `replyMode` |
| `dist/runtime-CalLOr7V.mjs`         | schema 同步（宿主配置校验按 dist schema 走，不打就会被 strict 拒绝）                                                                  |
| `dist/message-handler-C8eu5xwl.mjs` | dispatcher 逻辑同步                                                                                                                   |

关键决策：

- **不复用 `groupReplyMode` 去掉 `!isDirect`**：那会让已设该键的部署单聊行为静默翻转，且语义耦合（群开关改单聊）；独立键默认 `aicard` = 打补丁后零行为变化，直到显式配置。
- **不改 collector/主动通知**：主动发送走 `sendProactive`（gateway methods → `sendProactiveInternal`，`useAICard` 由调用方控制），与 reply dispatcher 完全分离，补丁不触碰（验证场景 S11）。
- **群聊零变化**：群路径分支照旧按 `groupReplyMode`（S9/S10）。
- **接收人解析、授权边界零变化**：dmPolicy/allowFrom 检查在 dispatcher 之前，不动（S12）。

补丁文件：`patches/dingtalk-connector-0.8.27-direct-reply-mode.patch`（版本钉死 0.8.27，`patch -p1` 于包根应用；已对安装副本做 dry-run + 应用 + 逐字节回环校验）。

## 4. 行为变化（directReplyMode=markdown 的单聊）

| 方面                | before                                     | after                                                                                                          |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 回复形态            | AI Card（创建→流式更新→收口 flowStatus=3） | 一次最终 Markdown 消息（session webhook `msgtype=markdown`），无任何 `/v1.0/card/*` 调用                       |
| 流式                | 打字机式流式                               | 取消（`streamingEnabled=false`）——回复一次性送达，这是目标体验                                                 |
| 超长文本            | 卡片内完整展示                             | 按 `textChunkLimit`（默认回退 4000 字符）分块多条发送，内容无损（S3）                                          |
| 空回复              | 卡片收口空文案                             | 单聊口语化确认文案，纯 Markdown 发送（S4）                                                                     |
| 重复 final          | 卡片收口去重                               | 同样去重，只发一条（S2）                                                                                       |
| 发送失败            | 卡片降级路径                               | `assertDingtalkMessageDelivered` 抛错 → `runtime.error` 上报 + 兜底纯文本「⚠️ 消息发送失败，请稍后重试」（S5） |
| settle 后迟到 block | 普通消息降级                               | 同左（webhook markdown，不变）                                                                                 |

已知限制（与群聊 text/markdown 模式一致的上游既有行为，非本补丁引入）：

- 媒体标记（file/video/audio marker、内联图）在 text 模式 final 路径不做上传替换，可能以原始标记文本出现；裸本地文件路径仍会经 `processRawMediaPaths` 上传替换为链接。含大量媒体输出的场景如体验不佳，可回退 `aicard`。
- webhook 回复受会话有效期约束（与既有降级路径相同）。

## 5. 验证（全部 mock，零真实消息、零网络、零 Gateway 操作）

`verify/` 下离线验证台：把已安装插件复制为 pristine/patched 两棵 scratch 树（依赖解析与真实安装一致，仅 axios 换成记录型 stub），以伪 OpenClaw host runtime 驱动**真实 dist 产物**的 `handleDingTalkMessage`，对 HTTP 边界断言。

```bash
cd verify && ./build-scratch.sh && node run-tests.mjs
```

结果（2026-11-02，Node v24.21.0）：**38/38 PASS**

- S1-S5 补丁效果：单聊 markdown 直发、零卡片 API、正文完整、分块无损、重复 final 去重、空回复兜底、失败可诊断（runtime.error + 兜底文本）
- S6-S8 默认回归：默认单聊仍走卡片；pristine 与 patched 默认调用序列完全一致
- S9-S10 群聊回归：markdown/aicard 两模式两棵树行为不变
- S11 collector/主动发送回归：默认仍卡片、`useAICard:false` 仍 batchSend 普通 API，两棵树一致
- S12 授权边界：非白名单 sender 拒收且无任何回复投递
- S13 配置 schema 边界：patched schema 定义 `directReplyMode`（枚举校验），pristine schema 严格拒绝该键（证明必须打补丁才能配置）

## 6. 部署步骤（需人工执行；本任务未执行）

```bash
cd ops/dingtalk-direct-text-replies
./scripts/apply.sh          # 校验版本 0.8.27 → 备份 → 打补丁 → 校验（幂等）
pnpm openclaw config set channels.dingtalk-connector.directReplyMode markdown
# 重启 Gateway（repo AGENTS.md 规定顺序；本机为 launchd 托管本 checkout 构建）:
launchctl bootout gui/501/ai.openclaw.gateway
pnpm build
launchctl bootstrap gui/501 ~/Library/LaunchAgents/ai.openclaw.gateway.plist
pnpm openclaw gateway health && pnpm openclaw models list
./scripts/status.sh         # 确认 patch APPLIED + config markdown
```

真实私聊验证清单：

1. 白名单用户在钉钉给玲珑发一条消息 → 收到**普通 Markdown 文本**（非卡片）；日志出现 `[DingTalk] 回复模式(单聊): markdown`，无 `POST /v1.0/card/instances`。
2. 让玲珑产出一个长回复 → 按 4000 字符分块、顺序完整。
3. collector 主动通知 → 形态不变（此前已是普通 Markdown）。
4. （可选）群聊如启用 → 行为不变。
5. 回退验证路径演练：见下节。

## 7. 回退步骤

```bash
pnpm openclaw config unset channels.dingtalk-connector.directReplyMode   # 必须先做
./scripts/rollback.sh        # 从 ~/.openclaw/backups/dingtalk-direct-text-replies/<ts> 逐字节恢复
# 重启 Gateway（同上 launchctl 顺序）
```

`rollback.sh` 在 config 键仍存在时拒绝恢复（避免 strict schema 拒绝配置导致 Gateway 启动失败），已对退出码与字节级恢复做过演练（临时副本上验证，未触碰真实安装）。

## 8. 升级风险与长期方案

- **任何插件重装/升级**（`openclaw plugins install … --force`、更新到 0.8.28+ 等）都会覆盖补丁：行为静默回到卡片，且残留的 `directReplyMode` 配置会被 stock strict schema 拒绝，**Gateway 启动失败**。升级前务必先 `config unset`，升级后如需继续用，重新生成/应用对应版本补丁。`apply.sh` 对非 0.8.27 版本会拒绝。
- **这是过渡方案，不是长期 owner**。长期方案：向上游提 PR（改动即 `src/config/schema.ts` + `src/reply-dispatcher.ts` 两处，本补丁的 src 部分可直接作为 PR 内容；上游仓库 `DingTalk-Real-AI/dingtalk-openclaw-connector`，PR 前先搜 issue 避免重复）。合入发布后，撤销本地方案：unset 配置 → 升级插件 → 按上游配置键语义重新配置。

## 9. 产物清单

- `patches/dingtalk-connector-0.8.27-direct-reply-mode.patch` — src+dist 统一补丁
- `scripts/apply.sh` / `rollback.sh` / `status.sh` — 部署/回退/状态（均支持 `DT_CONNECTOR_INSTALL`、`DT_BACKUP_BASE`、`OPENCLAW_CONFIG` 覆盖用于演练）
- `verify/build-scratch.sh`、`verify/run-tests.mjs`、`verify/stub-axios/` — 离线验证台（scratch 树可随时重建，不入库）
