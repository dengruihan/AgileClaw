# DingTalk 私聊自动回复改为普通 Markdown（directReplyMode）

状态：**补丁、可维护本地插件包与隔离环境部署测试已就绪；未部署**。线上安装、`~/.openclaw/openclaw.json`、Gateway 均未改动，未发送真实消息。

部署 owner 是 **OpenClaw 插件管理器**：由固定上游 tarball + 补丁构建本地插件包，用 `openclaw plugins install` 安装。**不再直接修改 npm 安装副本的 `src/` 或 `dist/`。**

## 1. 问题

用户在钉钉与玲珑私聊时仍收到 AI 卡片，要求改为普通 Markdown。此前只把 collector 主动通知改为普通 Markdown；私聊自动回复仍由 `@dingtalk-real-ai/dingtalk-connector` 的 direct 流程固定走 AI Card。

## 2. 根因（0.8.27）

私聊回复由 `handleDingTalkMessage` → `dispatchConversation` → `createDingtalkReplyDispatcher`（`src/reply-dispatcher.ts`，打包进 `dist/message-handler-C8eu5xwl.mjs`）处理：

```ts
// src/reply-dispatcher.ts:240-248（dist message-handler-C8eu5xwl.mjs:433-436）
const groupReplyMode = account.config?.groupReplyMode || "aicard";
const isTextMode = !isDirect && (groupReplyMode === "text" || groupReplyMode === "markdown"); // ← 单聊被排除
const streamingEnabled = !isTextMode && account.config?.streaming !== false;
```

- 单聊 `isDirect=true` → `isTextMode` 恒为 false → 创建 AI Card（`POST /v1.0/card/instances` + `/deliver`），流式 `PUT /card/streaming`，final `PUT /card/instances`（flowStatus=3）收口。
- 群聊已有 `groupReplyMode: 'text'|'markdown'` 纯文本能力，但被 `!isDirect` 显式排除在单聊之外。
- **没有纯配置路径**：运行时 zod schema 不认识该键，插件清单 `openclaw.plugin.json` 的 `channelConfigs["dingtalk-connector"].schema`（`additionalProperties: false`）也不认识。宿主校验用的是**清单 schema**：只补 zod 时 `openclaw config set` 会报 `must not have additional properties: "directReplyMode"`（本次已在隔离 state 中实测复现）。
- 上游 npm 最新版本即 0.8.27，无可升级的修复版本。

本机账号现状：`channels.dingtalk-connector` 为 `dmPolicy: allowlist` + `groupPolicy: disabled`（只用单聊），未设置 `groupReplyMode`。

## 3. 方案

新增单聊配置键 **`directReplyMode`**（`aicard`|`text`|`markdown`，默认 `aicard`，与 `groupReplyMode` 对称）。补丁改 5 个文件（src 2 + dist 2 + 插件清单 1）：

| 文件                                | 修改                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/config/schema.ts`              | 新增 `DirectReplyModeSchema`，加入 `DingtalkSharedConfigShape`                                          |
| `src/reply-dispatcher.ts`           | `replyMode = isDirect ? directReplyMode : groupReplyMode`；`isTextMode`、发送格式与日志改用 `replyMode` |
| `dist/runtime-CalLOr7V.mjs`         | zod schema 同步                                                                                         |
| `dist/message-handler-C8eu5xwl.mjs` | dispatcher 逻辑同步                                                                                     |
| `openclaw.plugin.json`              | **宿主校验用的 channel schema**，顶层与每账号 `accounts.*` 各加 `directReplyMode`                       |

关键决策：

- **不复用 `groupReplyMode` 去掉 `!isDirect`**：那会让已设该键的部署单聊行为静默翻转；独立键默认 `aicard` = 补丁安装后零行为变化，直到显式配置。
- **不改 collector/主动通知**：主动发送走 `sendProactive`（`useAICard` 由调用方控制），与 reply dispatcher 分离（验证 S11）。
- **群聊零变化**：群路径仍按 `groupReplyMode`（S9/S10）。
- **接收人解析、授权边界零变化**：dmPolicy/allowFrom 检查在 dispatcher 之前（S12）。

### 部署包（可维护 owner）

`scripts/build-package.sh` 从 **npm registry 的 0.8.27 tarball**（sha512 固定为 `package-lock.json` 中的 integrity）解包、应用补丁、把版本改为 `0.8.27-claw.1`、`npm pack` 生成本地包。随后：

```bash
openclaw plugins install <tarball> --force --accept-capabilities
```

插件管理器把它复制进托管目录（`~/.openclaw/extensions/dingtalk-connector`）、安装依赖、写入安装记录。**npm 托管副本（`~/.openclaw/npm/projects/.../node_modules/...`）不再被修改**，也不再是加载来源。

## 4. 行为变化（directReplyMode=markdown 的单聊）

| 方面       | before                        | after                                                                                    |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| 回复形态   | AI Card（创建→流式更新→收口） | 一次最终 Markdown 消息（session webhook `msgtype=markdown`），无任何 `/v1.0/card/*` 调用 |
| 流式       | 打字机式流式                  | 取消（`streamingEnabled=false`），一次性送达                                             |
| 超长文本   | 卡片内完整展示                | 按 `textChunkLimit`（默认回退 4000 字符）分块多条发送，内容无损（S3）                    |
| 空回复     | 卡片收口空文案                | 单聊口语化确认文案，纯 Markdown 发送（S4）                                               |
| 重复 final | 卡片收口去重                  | 同样去重，只发一条（S2）                                                                 |
| 发送失败   | 卡片降级路径                  | `runtime.error` 上报 + 兜底纯文本「⚠️ 消息发送失败，请稍后重试」（S5）                   |

已知限制（与上游群聊 text/markdown 模式一致的既有行为，非本补丁引入）：媒体标记在 text 模式 final 路径不做上传替换，可能以原始标记文本出现；webhook 回复受会话有效期约束。含大量媒体输出的场景可回退 `aicard`。

## 5. 验证（零真实消息、零网络发送、零 Gateway 操作）

### 5.1 离线行为验证台（45 项）

`verify/` 把 integrity 固定的上游 tarball 解成 pristine/patched 两棵树（依赖解析与真实安装一致，仅 axios 换成记录型 stub），以伪 OpenClaw host runtime 驱动**真实 dist 产物**的 `handleDingTalkMessage`，对 HTTP 边界断言。

```bash
cd verify && ./build-scratch.sh && node run-tests.mjs
```

结果（2026-11-02，Node v24.21.0）：**45/45 PASS**

- S1-S5：单聊 markdown 直发、零卡片 API、正文完整、分块无损、重复 final 去重、空回复兜底、失败可诊断
- S6-S8：默认单聊仍走卡片；pristine 与 patched 默认调用序列完全一致
- S9-S10：群聊 markdown/aicard 两模式两棵树行为不变
- S11：collector/主动发送默认卡片、`useAICard:false` 仍 batchSend，两棵树一致
- S12：非白名单 sender 拒收且无回复投递
- S13：运行时 zod schema 边界（patched 定义、pristine 严格拒绝）
- S14：**插件清单 channel schema** 边界：patched 顶层与每账号都定义 `directReplyMode` 且枚举正确；pristine 缺失且 `additionalProperties:false`

### 5.2 隔离 state 部署测试（真实插件管理器）

`verify/deploy-tests.sh` 在临时 `OPENCLAW_STATE_DIR` 中走完整路径：先安装上游 0.8.27，再构建本地包并部署，验证配置键被宿主接受，随后验证回退保护并离线回退到上游。

```bash
OPENCLAW_ROOT=/path/to/built/checkout ./verify/deploy-tests.sh
```

结果（2026-11-02）：**50/50 PASS**（`RESULT: 50/50 passed, 0 failed`）

覆盖：

- CLI 失败时原样暴露 `UpdatePreMutationError` 并提示 `OPENCLAW_CLI`（不再报 "plugins list produced no JSON"）
- 构建产物版本、补丁标记、清单 schema 正确；保存已校验的上游 tarball
- dry run 不写入任何状态
- `config-without-patch` 恢复：`config unset`/`config validate` 在该状态被拒绝（证明 CLI 不可用），`recover-config.sh` 备份后移除遗留键并通过校验；`--restore` 恢复有效快照
- `--package` 缺上游字节时部署拒绝；正常 `--package` 部署会保存上游 tarball 与部署前配置副本
- `plugins install` 后版本为 `0.8.27-claw.1`、位于托管 extensions 目录、依赖已安装
- `config set channels.dingtalk-connector.directReplyMode markdown` 被宿主接受（清单 schema 生效）
- `status.sh --json` 报告一致状态
- 回退保护：配置键未删时拒绝；deploy manifest 与已安装版本不匹配时拒绝；上游 tarball 字节被篡改时拒绝
- `--package` 部署后用保存的上游 tarball 离线回退成功，版本回到 0.8.27、补丁标记消失
- 部署/回退/构建/恢复脚本均不引用 `node_modules/@dingtalk-real-ai`；真实 npm 托管安装的字节指纹前后一致

部署与回退脚本默认调用 `pnpm openclaw`。在 `dist` 与源码不同步、且 Gateway 正在运行的 checkout 上，`pnpm openclaw` 会先拒绝发布构建产物（`UpdatePreMutationError`，与本部署无关）；脚本会原样打印该错误并提示改用已构建的 CLI。下面 §6/§7/§8 的命令都默认先设置：

```bash
export OPENCLAW_CLI="node /home/raymond/repos/AgileClaw/dist/index.js"
```

（若该 checkout 已完成 `pnpm build`，也可不设，直接使用 `pnpm openclaw`。）

## 6. 部署步骤（需人工执行；本任务未执行）

```bash
cd /home/raymond/repos/AgileClaw/ops/dingtalk-direct-text-replies
export OPENCLAW_CLI="node /home/raymond/repos/AgileClaw/dist/index.js"

./scripts/deploy.sh            # 只打印计划，不改动
./scripts/deploy.sh --yes      # 构建本地包 → plugins install → config set
./scripts/status.sh            # 应为 patched=true、directReplyMode=markdown、state=consistent
```

`--package <tgz>` 复用已构建的包时，必须同时具备同目录的 `build.json` 与它引用的 `upstream-0.8.27.tgz`，否则脚本会拒绝（避免丢失离线回退能力）；确实只接受在线回退时加 `--allow-online-rollback-only`。

重启 Gateway（**需要用户批准；脚本不会执行**；本机为 systemd user 服务，不是 launchd）：

```bash
systemctl --user restart openclaw-gateway.service
(cd /home/raymond/repos/AgileClaw && pnpm openclaw gateway health)
journalctl --user -u openclaw-gateway.service -n 50 --no-pager
```

本机服务事实（已核实）：`~/.config/systemd/user/openclaw-gateway.service`，`ExecStart` 为 `/home/raymond/repos/AgileClaw/dist/index.js gateway --port 18789`，`Linger=yes`。插件安装不涉及本 checkout 源码，**无需 `pnpm build`**。

真实私聊验证清单：

1. 白名单用户在钉钉给玲珑发一条消息 → 收到**普通 Markdown 文本**（非卡片）；日志出现 `[DingTalk] 回复模式(单聊): markdown`，且无 `POST /v1.0/card/instances`。
2. 长回复 → 按 4000 字符分块、顺序完整。
3. collector 主动通知 → 形态不变（此前已是普通 Markdown）。
4. （可选）群聊如启用 → 行为不变。

## 7. 回退步骤

```bash
cd /home/raymond/repos/AgileClaw/ops/dingtalk-direct-text-replies
export OPENCLAW_CLI="node /home/raymond/repos/AgileClaw/dist/index.js"

# 必须先删配置键：stock 清单 schema 是 strict 的，残留键会导致 Gateway 启动失败
pnpm openclaw config unset channels.dingtalk-connector.directReplyMode

./scripts/rollback.sh                 # 只打印计划
./scripts/rollback.sh --yes           # 从 npm registry 安装 stock 0.8.27
./scripts/rollback.sh --yes --offline # 或用 deploy 时保存并校验过的 0.8.27 tarball
./scripts/status.sh
```

若已处于 `config-without-patch`（stock 已安装、配置键残留），CLI 的 `config unset` 会因为整份配置无效而拒绝。此时用文件 owner 的恢复脚本（先备份、再移除、后校验，失败自动回滚备份）：

```bash
./scripts/recover-config.sh            # 只打印计划
./scripts/recover-config.sh --yes      # 备份 → 移除 channels.dingtalk-connector[.accounts.*].directReplyMode → config validate
./scripts/recover-config.sh --yes --restore ~/.openclaw/backups/dingtalk-direct-text-replies/<ts>/openclaw.json.before
```

`deploy.sh` 每次部署都会把部署前的 `openclaw.json` 存为备份目录下的 `openclaw.json.before`，可直接用于 `--restore`。

回退保护（均已测试）：

- 配置键未删 → 拒绝，并给出 `config unset`/`recover-config.sh` 两条路径
- 已安装版本不是 `0.8.27-claw.1`（例如被升级到别的版本）→ 拒绝，绝不混装两个版本的 `src`/`dist`
- `deploy.json` 中 `local.version` 与已安装版本不一致 → 拒绝
- `--offline` 时保存的上游 tarball sha512 与固定 integrity 不一致 → 拒绝

## 8. 升级/覆盖风险与长期方案

- **插件更新对本地包的实际行为（本机观察）**：`openclaw plugins update` 会跳过 archive 安装记录（`Skipping "dingtalk-connector" (source: archive).`）；`openclaw update` 的插件通道同步只处理 npm/clawhub/path/bundled 记录。因此当前不会自动换回上游，但这是观察到的实现行为、不是契约：不要依赖它。
  - 保守顺序不变：任何插件更新/核心升级前，先 `OPENCLAW_CLI=... pnpm openclaw config unset channels.dingtalk-connector.directReplyMode`。
  - 更新后运行 `./scripts/status.sh`；`state=config-without-patch` 时用 `./scripts/recover-config.sh --yes` 恢复，需要继续使用时重新 `./scripts/deploy.sh --yes`。
- **已知限制**：状态与回退脚本只读取顶层 `channels.dingtalk-connector.directReplyMode`（恢复脚本额外处理 `accounts.<id>.directReplyMode`）；使用 `$include` 的配置，键可能位于被包含文件，脚本不会编辑它们。本机为单账号、顶层配置，不受影响；多账号/include 部署需先扩展检查范围。
- **这是过渡 owner，不是上游 owner**。长期方案：向上游 `DingTalk-Real-AI/dingtalk-openclaw-connector` 提交 PR（`src/config/schema.ts`、`src/reply-dispatcher.ts`、`openclaw.plugin.json` 三处；本补丁可直接作为 PR 内容）。上游发布后：unset 配置 → 安装上游版本 → 按上游键语义重新配置。

## 9. 产物清单

- `patches/dingtalk-connector-0.8.27-direct-reply-mode.patch` — src + dist + 插件清单统一补丁
- `scripts/build-package.sh` — 从固定上游 tarball 构建本地包（校验 sha512，输出 `build.json` 记录哈希）
- `scripts/deploy.sh` / `scripts/rollback.sh` / `scripts/status.sh` — 部署/回退/状态；全部经插件管理器操作
- `scripts/recover-config.sh` — `config-without-patch` 状态的文件 owner 恢复（备份、移除、校验、可恢复快照）
- `scripts/lib.sh` — 共享路径与校验函数
- `verify/build-scratch.sh`、`verify/run-tests.mjs`、`verify/stub-axios/` — 离线行为验证台
- `verify/deploy-tests.sh` — 隔离 state 的真实插件管理器部署/回退测试
