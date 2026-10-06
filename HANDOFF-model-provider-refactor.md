# 任务交接：完成「模型供应商配置重构」的验证与收尾

你在 `/Users/raymond/Documents/Rayclaw` 仓库工作。前一个 agent（Codex）已经完成了这个重构的**实施主体**，因达到用量上限在验证阶段中途停止。工作区里 387 项未提交改动全部属于本任务，是你接手的基础。**你的职责是验证、补齐、收尾、落地，不是重新设计。**

先读仓库根目录 `AGENTS.md` 以及你改动到的目录下最近的 scoped `AGENTS.md`。本提示词与仓库规则冲突时，以仓库规则为准；本提示词中已锁定的产品决策不要重新讨论。

---

## 0. 进度快照（2026-10-06 早晨，第二个接手 agent 留下；转移机器前先读本节）

工作区约 **75–80% 完成**。下面是相对第 5 节清单的真实进度；`git status --porcelain | wc -l` 应约 816 项（含未跟踪），diff 约 +4,265 / −65,147。

### 已完成并有证据

1. **typecheck**：core=0、ui=0、`-b tsconfig.extensions.projects.json` 新缓存复核=0（原 418/109 已由子代理清零）、core:test=0。`models.test.ts` 的 2 个 `ModelDefinitionConfig` 类型错误已修并复跑 **49/49 全绿**（fixture 补 `input/cost/maxTokens/reasoning` 必填字段、provider 仅补必填 `baseUrl`——注意**不要**加 `api`，会改变 thinking 阶梯投影路径、快照断言相应补 `reasoning/thinkingDefault/thinkingLevels`）。**未跑**：`tsgo:scripts`、`tsgo:test:root`、`tsgo:extensions:test`。
2. **发现接口验证（第 5 节步骤 2）完成**：`src/gateway/server-methods/models-discover.failures.integration.test.ts` 新增并全绿（401/空结果/超时/invalid-api 四失败路径 + config-untouched 副作用断言 + draft-key 成功路径）。
3. **Control UI E2E（步骤 4）主体完成**：`ui/src/e2e/model-providers-manager.e2e.test.ts` 2 用例全绿（全流程走查：模板自定义首位/搜索/OpenAI 预填/拉取参数断言/模型增删改/保存 config.set|patch + 独立 `models.authSetApiKey` 通道且 Key 不进 patch；桌面+窄屏 × 加载/空/错误/密集四状态）。证据截图 12 张在 `.artifacts/control-ui-e2e/provider-manager-{CoGsxm,i4N1lB}/`（不入库）。视觉判定 **6/9 过**，3 张不合格均为证明质量而非产品缺陷：
   - `04-saved-provider-list.png`：保存后页面 mock 的 `config.get` 仍返回旧配置 → 显示空态。修法：测试保存 ack 后 `gateway.setMethodResponse("config.get", <含已保存 provider 的配置>)`，等 `[data-provider-id]` 卡片出现再截全页图。
   - `13-{desktop,narrow}-dense-models.png`：24 行模型列表在折叠线下只露出 1 行。修法：截图前 `manager.locator(".provider-manager__model").nth(12).scrollIntoViewIfNeeded()`。
4. **UI 单测修复**：`ui/src/pages/model-providers/` 14 套件 229 用例全绿。要点：3 个 stale catalog 测试改为「config 夹具带 `models.providers` 保存行」（新契约：`model-providers-page.ts:546` 只渲染已保存 provider）并剥离已删的内联 Set-API-key 编辑器路径；受限访问页身份隐藏断言改 api_key 世界；probe 夹具补必填 `results`；Edit provider 按钮补 `configMutationDisabled` busy 锁；probe 按钮恢复 `probe.unavailable` title；删除死 i18n 键 `credentials.oauth/tokenProfiles`。
5. **扩展 typecheck 109→0**（子代理完成并新缓存复核两次）。**但扩展运行时测试仍有 4–5 条失败 lane 待修**（子代理逐一如实验证为重构附带损伤、非其造成）：github-copilot index.test ~40 例（`provider.auth` 现为空）、anthropic index.test setup-token/Claude CLI native auth 10 例、telegram /login 流（源码不再调 `runModelsAuthLoginFlow`）、xai OAuth 发现类用例、lmstudio `/api/v1` 端点规范化 1 例。
   5b. **codex 批（转移时停止，状态如下）**：codex typecheck 0（清缓存全量重建复核）。已落地且验证全绿：settled-turn-finalizer 21/21、isolated-completion 8/8、run-attempt-client-prewarm 5/5、auth-binding 3/3、command-plugins-runtime 15/15（fixture oauth→api_key；删除 chatgpt-login/token-partition 用例）、command-rpc 删 subscription-routing 用例。**已落地但未复跑**：shared-client websocket 启动组 6 例（`shared-client-websocket-startup.test-support.ts` 已改 `authProfileId: null` → api-key `preparedAuth`，接手后先复跑）。**未修**：`shared-client.test.ts` "reports the real shared acquisition boundary *" 7 例全部 120s 挂起（诊断点 `shared-client-acquisition-diagnostics.test-support.ts:46`，疑似需给 `withCodexAppServerJsonClient` 选项加 `preparedAuth`）。**保留上报的预存在失败**：command-rpc.test.ts "resumes with the prepared environment API key"——src 侧路由规划对空存储 + 环境 `OPENAI_API_KEY` 不成路由，需 src 所有者处理。
6. **真实生产 bug 修复**：`src/agents/model-auth-availability.ts` `modeAllowed` 现同时接受 "api-key"/"api_key" 两种拼写。
7. **文档一致性**：~10 页修复（`models auth paste-api-key` 话术）、links 0-broken、format 已跑。`codex-harness.md` + `codex-harness-reference/` 两页**有意保留**待 codex 相关批落地后补。
8. `models.list` 其余套件此前已由另一子代理修至全绿（49/49）。

### 未完成（按优先级）

1. E2E 04/13 修复 + 重拍 + **before/after 对比**（before 侧：HEAD worktree 跑旧 UI 截图，或找 `.artifacts/control-ui-e2e/provider-refactor-7qhhUn` 旧目录）。
2. 扩展运行时测试 4–5 条 lane 修复（见上清单及 5b codex 批状态；修不了就按测试失败政策记录证据）。
3. `tsgo:scripts`、`tsgo:test:root`、`tsgo:extensions:test` 三个未跑 legs。
4. **build 门**：运行中 launchd Gateway（跑本 checkout dist）使 `pnpm build` 拒绝覆盖 dist——用隔离 worktree build，或与操作者确认停机窗口走 AGENTS.md 的 launchctl 路径；至少捕获 fence 拒绝证据。
5. **执行通道验证（第 5 节步骤 3）大体未做**：直接模型调用（本地 HTTP）+ 外部运行器显式 API Key + 非 API 凭据（旧 OAuth/token）不能登录/刷新/调用的证明。
6. 回归审计（`test-audit` 技能过新改测试）+ 新鲜代码审查。
7. 分主题 Conventional Commits（只 stage 本任务文件）+ `git diff --check` + 最终报告（做/缺口/未跑+原因）。

### 给下一个 agent 的坑位提示

- **tsgo 假 0**：`.artifacts/tsgo-cache/*.tsbuildinfo` 陈旧会报 0 错误。信结果前 `rm -f .artifacts/tsgo-cache/*.tsbuildinfo` 重跑。
- **stale lock**：`.artifacts/dist-artifacts.lock` 残留时先 `pgrep -fl tsgo` 确认无进程再 `rm -rf`。
- **E2E 惯例**：chai expect（无 Playwright 断言），`waitFor()/expect.poll`；`installMockGateway` 必须在 `page.goto` 前；scenario `featureMethods` 会整体替换默认表，要展开 `defaultControlUiFeatureMethods`；`config.get` mock 需带 `raw/valid`，`agents.defaults.model` + `agents.entries` 缺失会重定向到 /chat/main；`deferNext`/`resolveDeferred` 需先 `waitForRequest` 等请求到达；config ack 要回完整 snapshot 形状。
- **子代理配额**：约 5h 上限会杀掉在跑代理并留 stale lock；每轮死亡后先核对落盘状态再重启。
- **提交约束**：`31b39798`、`20f09306` 是前置本地提交不混入；Conventional Commits、无 agent 署名 trailer；凭据不进提交/日志/截图。
- 本机 ZCode 会话状态与 `.artifacts/` 均不入库（后者被 gitignore），转移机器后截图证据需重拍或随行拷贝 `.artifacts/control-ui-e2e/`。

---

## 1. 背景（已发生的事实）

- 前序会话：今天 14:42–15:58，Codex Desktop 在本仓库完成规划与实施，15:58 因 Codex 用量上限中断，任务没有自然收尾。
- 中断时状态：实施基本完成，正在准备验证阶段（当时在翻 Control UI E2E 测试支撑代码），主 agent 正在向三个收尾子代理（`provider_backend_finish`、`model_api_auth_finish`、`external_api_runners_finish`）派活。
- **子代理的结论不可恢复**（会话内消息加密存储），磁盘上的工作区 diff 是唯一事实。不要信任任何"已完成验证"的说法，一切以下面的剩余工作清单为准重新验证。
- 前序会话的完整记录（仅供取证，不是必读）：
  `~/.codex/sessions/2026/10/05/rollout-2026-10-05T14-42-48-01a10acc-fd62-7a61-8fa3-c79240906ab4.jsonl`
  （约 10.9 MB 的 JSONL，每行一个事件；不要修改 `~/.codex` 下的任何内容。）

## 2. 原始需求（用户原文，目标不变）

**任务**：重构「模型供应商配置」功能，使其逻辑清晰、流程顺畅。

**期望的用户流程**：

1. **打开配置入口**：用户在网页控制台打开「模型配置」页面。
2. **添加供应商**：用户点击「添加供应商」，系统展示一个供应商模板库，在模板库的第一位，是自定义供应商。
3. **选择模板**：用户从模板列表中搜索/选中自己的服务商，点击确认。
4. **自动拉取模型**：系统从对应的供应商插件中读取该服务商的接口配置，调用其 API 获取可用模型列表，自动加载进来。
5. **前端展示**：前端将拉取到的信息渲染为一份初始配置，展示给用户，包括：服务商名称、Base URL、API 格式、API Key、模型列表。
6. **用户编辑**：用户可在这份初始配置基础上做任意修改，包括但不限于：修改服务商名称、更换 Base URL、切换 API 格式（如 OpenAI 兼容 / Anthropic message）、填写或更换 API Key、增删改模型列表中的条目。

**核心逻辑要求**：

- **模板只是初始化来源**：模板的作用是「一键预填」，拉取完成后，所有字段都应以用户可见、可编辑的普通配置数据存在，不再区分「来自模板」还是「手动添加」。
- **拉取与手动添加的模型地位平等**：无论是系统自动拉取的还是用户手动添加的模型，都进入同一个模型列表，统一支持编辑和删除。
- **重复添加去重**：同一 Base URL 下模型名相同的条目不应重复出现；如已存在，提示用户改为编辑现有条目。
- **修改即时生效**：用户修改 Base URL 或 API Key 后，可重新触发「拉取模型」刷新列表，同时保留用户手动添加的自定义模型不被覆盖（手动添加的条目需标记来源，刷新时默认只更新自动拉取部分，或提示用户选择合并策略）。
- 用户可以建立多个供应商，使用同一个模板，但是要要求用户所有的供应商的名称不能相同。

## 3. 已批准的实施计划（按此执行，不要重新设计）

### 目标与范围

建立统一流程：**添加供应商 → 搜索并确认模板 → 预填配置并拉取模型 → 编辑 → 保存**。模板只负责初始化，保存后的普通配置是运行时唯一数据来源。

仅保留 API Key 和无密钥 HTTP 接入。保留外部 CLI/app-server 使用 API Key 的执行通道；移除模型 OAuth、订阅账号登录、设备码登录、令牌刷新及非 API Key 凭据接入。频道与 MCP 的独立鉴权不在本次范围内。

### 配置与界面

- 「添加供应商」打开可搜索模板库，自定义供应商固定第一位。已使用的模板仍可再次选择。
- 统一供应商编辑器，同时展示名称、Base URL、API 格式、API Key 和模型列表；支持新建时直接管理模型。
- 供应商使用稳定内部 ID，新增独立显示名称。名称可修改，修改不影响引用；名称去除首尾空格、忽略大小写后全局唯一，由前后端共同校验。
- 所有字段先修改草稿；「拉取模型」使用当前草稿，点击保存才更新运行配置，取消不产生写入。
- Key 默认隐藏，已有凭据显示其配置状态；空白表示保留，提供明确的清除操作。无密钥接口允许 Key 为空。
- 模型统一支持添加、编辑和删除。以当前供应商内的有效 Base URL 与模型 ID 去重，重复时提示编辑已有条目。
- 模型 ID 被默认模型、回退或其他配置引用时，阻止改 ID 或删除，列出引用位置并引导先解除。

### 后端与模型列表

- 从供应商插件现有轻量元数据构建模板库，避免打开页面时加载全部插件运行时代码。新增 `models.providerTemplates` 查询接口，返回可用接口型模板及普通配置默认值。
- 新增无配置写入副作用的 `models.discover` 接口，接收当前草稿的地址、API 格式、凭据及请求设置，返回完整模型配置或明确失败结果。
- 复用现有模型发现底层；插件负责接口路径、鉴权和响应解析。模板初始化时复制所需发现设置为普通配置，后续拉取尊重当前配置和 API 格式，不依赖原模板身份。
- 有可用凭据或接口无需凭据时自动拉取；否则先展示预填配置，填写 Key 后手动拉取。不支持模型列表接口、鉴权失败、超时和空结果分别显示可操作提示，不用静态目录冒充成功。
- `models.providers` 保存供应商和完整模型列表；新增名称字段及模型来源标记。来源仅用于刷新，不能限制编辑权限。
- 自动模型被用户编辑后转为手动维护。刷新保留手动条目，替换其余自动部分；相同模型由手动条目优先，结果去重。失败不改变列表；刷新将删除被引用模型时，保留原列表并提示解除引用。
- 运行时只消费保存的模型列表，移除隐式目录合并、覆盖项和隐藏模型的双层管理。删除的模型不会被后台目录重新加入；主动拉取可以再次发现它。
- 保存复用现有配置写入、凭据存储和并发冲突机制。配置与凭据保存分别报告真实结果，失败保留草稿；迟到的拉取结果不能覆盖新编辑或另一个供应商。

### 非 API 接入清理与验证

- 同步清理网页、个人模型账号、CLI、初始化向导、Gateway RPC、插件元数据、凭据选择和运行时中的非 API 接入路径，连同专属测试、文案和失去调用者的代码一起删除。
- 保留 API Key 存储、SecretRef、轮转及冷却机制；保留使用 API Key 的 Coding Plan 服务。外部运行器必须使用明确准备的 API Key，禁止回退到原生账号登录。
- 保留已运行的本地 HTTP 接口接入，删除程序代管模型安装和进程启动流程。
- 回归覆盖模板重复使用、名称冲突、未保存参数拉取、协议切换、模型增删改、去重、刷新保护、引用保护、取消、并发冲突及迟到响应。
- 通过实际 Gateway 边界和本地 HTTP 测试服务验证发现请求；验证直接模型调用与外部 API Key 通道，并证明残留非 API 凭据不能触发登录、刷新或调用。
- 使用隔离的 Control UI 测试环境，检查桌面与窄屏的加载、空列表、错误和密集列表状态，提供已检查的改动前后截图；完成相关检查、构建和新鲜代码审查。

### 已确定的默认与限制

- 不建设旧非 API 配置的兼容迁移，不自动转换旧令牌或选择替代模型；不删除真实历史数据或修改当前运行状态。
- 本次交付代码和验证证据，不自动发布或重启现有 Gateway。
- 当前 `../codex` 没有源码。修改保留的 Codex API Key 桥接行为前，需补齐对应版本源码并按仓库要求核对；不凭推测修改外部协议。
  （前序会话报告已找到与本机 Codex CLI 0.160.0 对应的官方源码并核对了协议边界；你若要动 Codex 桥接行为，先自行验证 `../codex` 是否存在且版本匹配。）

## 4. 接手时的工作区事实（用 `git status -sb` / `git diff --stat` 自行复核）

- 分支 `main`，领先 `origin/main` 2 个提交。**这 2 个提交（`31b39798`、`20f09306`）是本任务开始前就存在的本地提交，与本任务无关，保留即可，不要 rebase、不要混入新提交。**
- 未提交改动共 387 项：243 个修改、137 个删除、7 个新文件；diff 合计 **+2,322 / −47,832 行**。全部属于本任务。
- 7 个新增（未跟踪）文件，对应新能力：
  - `src/plugins/provider-model-templates.ts` — 模板库（`models.providerTemplates`）
  - `src/gateway/server-methods/models-discover.integration.test.ts` — `models.discover` 集成测试
  - `src/config/model-provider-normalization.ts` — 供应商名称归一/唯一性
  - `src/agents/models-config.saved-provider-inventory.test.ts`
  - `ui/src/pages/model-providers/provider-manager-view.ts` — 统一供应商编辑器
  - `extensions/github-copilot/api-key.ts`、`extensions/llama-cpp/src/provider.ts` — 插件迁移到 API Key 接入
- 大规模删除是**有意为之**：旧的模型 OAuth/订阅登录/设备码登录/令牌刷新、分离式模型管理页（如整个 `ui/src/pages/model-setup/view.ts`）、目录覆盖与隐藏模型双层管理、程序代管模型安装等（涉及 `extensions/anthropic`、`extensions/codex`、`extensions/chutes` 等插件的 auth/provider-discovery 文件）。不要"恢复"这些删除。
- 文档已同步改动：`docs/cli/models.md`、`docs/concepts/model-providers/control-ui-and-keys.md`、`docs/concepts/model-providers/custom-providers.md`、`docs/providers/xai.md` 等。
- 前序会话中途已修复一个回归：统一编辑器拆分时漏导入 schema 解析函数导致「添加供应商」打不开——说明曾做过实际浏览器验证并通过。

## 5. 剩余工作（按顺序执行；每步给出可检查的证据）

1. **健康门**：按 `package.json` 的入口跑 typecheck、build 和受影响测试套件。子代理收尾完成度未知，这一步确定真实基线；先修掉在此暴露的编译/测试问题再继续。
2. **发现接口验证**：通过实际 Gateway 边界 + 本地 HTTP 测试服务验证 `models.discover`（含鉴权失败、超时、空结果、不支持模型列表接口各自的失败路径；确认该接口无配置写入副作用）。
3. **执行通道验证**：验证直接模型调用与外部运行器（Codex/Claude CLI 等）使用显式 API Key 的通道仍工作；并证明残留的非 API 凭据（旧 OAuth/token）**不能**触发登录、刷新或调用。
4. **Control UI 隔离 E2E**（仓库 `control-ui-e2e` 技能，隔离环境，不碰运行中的 Gateway）：桌面与窄屏视口下的加载、空列表、错误、密集列表状态；完整走查「添加供应商 → 模板（自定义在首位）→ 预填 → 拉取 → 编辑 → 保存」流程。**硬性门槛： inspected、脱敏的改动前/后截图，进对话、进 PR。**
5. **回归测试补齐与核对**：模板重复使用、名称冲突（trim + 忽略大小写全局唯一、前后端共同校验）、未保存草稿参数拉取、协议切换、模型增删改、去重（Base URL + 模型 ID）、刷新保留手动/已编辑自动条目、引用保护（默认模型/回退引用时阻止改删）、取消不写入、并发保存冲突、迟到发现响应不覆盖新编辑/另一供应商。已有测试按 `test-audit` 技能审一遍价值与重复。
6. **收尾**：新鲜代码审查并解决实质发现；按 Conventional Commits 分主题提交（只 stage 本任务文件）；**不推送发布、不重启现有 Gateway、不改 release 相关文件**。文档与行为保持一致，检查 `git diff --check`。

## 6. 仓库规则要点（详见根 `AGENTS.md`，这里是本任务最容易踩的）

- CLI 一律 `pnpm openclaw ...` 或 `pnpm dev`，**绝不** `node --import tsx src/index.ts`。
- 不修改、不重启当前运行中的 Gateway（launchd `ai.openclaw.gateway`）；验证一律用隔离测试环境/端口。
- 测试遵循仓库成本预算：`pnpm test <file> --maxWorkers=1`，无真实定时器/睡眠/轮询；测试失败要么修复并加回归，要么记录证据，不得掩盖。
- 视觉改动必须先看前后截图对比（见第 5 步第 4 条，这是验收门槛不是可选项）。
- 凭据、私有配置、真实 Key 不进提交、日志、截图与文本；截图脱敏。
- 保持工作区里与本任务无关的改动原样；不 stash/checkout/reset 别人的东西。

## 7. 完成标准

- 第 5 节 1–6 全部有证据（测试输出、边界验证结果、前后截图、审查结论）。
- 计划中每条验收点都能指出对应的代码或测试；找不到的要么补上，要么明确报告为缺口。
- 工作区只包含本任务改动 + 2 个前置本地提交；提交信息 Conventional Commits、作者身份正确、无 agent 署名 trailer。
- 明确报告：哪些做了、哪些是缺口、哪些检查未跑及原因。

## 8. 附录：诊断细节与未落盘结论（转移机器前由旧机器 agent 追加）

### 8.1 E2E 截图 04/13 修复方案（待办 #1 的具体做法）

- **04-saved-provider-list.png**（保存后仍显示空态）：根因是保存 ack 之后页面刷新读取的 `config.get` mock 仍返回 `baseConfig`（无 `models.providers`）。修法：`savedConfigAck()` 与保存后的 `config.get` 响应都携带已保存 provider 的配置——`structuredClone(baseConfig)` 加 `models.providers.openai = { name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses", models: [<合并后的 24 行>] }`（行至少含 `id`/`name`，被改名的 "Renamed model" 和手动 "manual-model" 要在）。保存流程会触发 `onRefresh("replacement")` 重新拉 config，等 `[data-provider-id="openai"]` 卡片出现、manager 宿主卸载（`.provider-manager` 计数为 0）后再截全页图。注意用 mock gateway 的 `setMethodResponse` 覆盖 `config.get`，让保存后的 config 读取拿到新快照。
- **13-\*-dense-models.png**（24 行只露出 1 行）：截图前 `await manager.locator(".provider-manager__model").nth(12).scrollIntoViewIfNeeded()` 再截 manager 对话框，让中段多行入镜证明密集渲染。窄屏 390px 同样处理。

### 8.2 扩展运行时失败 lane 的逐条诊断与建议处置

| lane                      | 现象                                       | 诊断                                                                                                               | 建议处置                                                                                               |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| github-copilot index.test | ~40 例失败                                 | `provider.auth` 现为空；`providerAuthChoices` 已清空，manifest 驱动的 onboarding 测试已删（`choice` 类型为 never） | 若 choice 清空是永久决策→按新契约重写/删除这批用例；若临时→需先恢复 choices 列表（产品决策，问所有者） |
| anthropic index.test      | setup-token / Claude CLI native auth 10 例 | 源码已删这些接入路径                                                                                               | 删除用例（不要"修复"成已不存在的行为）                                                                 |
| telegram /login 流        | 流程测试失败                               | 源码不再调用 `runModelsAuthLoginFlow`                                                                              | 改写为 API-key 粘贴路径或删除                                                                          |
| xai OAuth 发现类          | 用例失败                                   | OAuth 路径已删（`applyXaiOAuthConfig`/`buildLiveXaiOAuthProvider` 测试已删）                                       | 剩余 OAuth 场景用例删除                                                                                |
| lmstudio                  | 1 例                                       | `/api/v1` 端点规范化断言与现状不符                                                                                 | 核对当前规范化行为后改断言                                                                             |
| google 静态目录           | 不再发布 google-vertex                     | `buildGoogleVertexStaticCatalogProvider` 已整体删除（宽 API 收窄）；google-vertex 仍为 hook alias                  | 若产品仍要 Vertex API-key 接入，需要新的合法 `api` 值或运行时专属通道——产品决策，记缺口                |

**需要所有者决策的真问题**：`resolveConnectionModels`（`src/plugin-sdk/provider-onboard.ts:59`）现在忽略 `cfg` 一律内联种入目录，但注释仍写 "seeding only in explicit replace mode"——注释与行为背离。venice "preserves existing zero pricing"、deepseek "keeps discovery-owned rows out of default config"、cohere/fireworks/xai "leaves ordinary catalogs runtime-owned" 等旧 merge 断言测试因此运行时失败。二选一：把实现修回「显式 replace 才种入」（尊重注释语义），或按「总是种入」更新注释与这批测试。这是合并语义问题，不是夹具问题。

### 8.3 codex 批 shared-client 挂起排查线索

1. **先复跑**（已修未验证）：`extensions/codex/src/app-server/shared-client.test.ts` 的 websocket 启动组 6 例——`shared-client-websocket-startup.test-support.ts` 已把 `authProfileId: null` 改为 api-key `preparedAuth`，改动在检查点里但没跑过。
2. **挂起组**："reports the real shared acquisition boundary *" 7 例每个 120s 超时。诊断点在 `shared-client-acquisition-diagnostics.test-support.ts:46`。工作假设：`withCodexAppServerJsonClient` 的 options 需要传 `preparedAuth`，否则客户端等一个永远不完成的 app-server 启动/授权。全部 7 例一起挂而不是个别用例，指向共享 setup 而非单例缺陷。
3. **保留上报**：command-rpc.test.ts "resumes with the prepared environment API key"——src 侧路由规划对「空 auth 存储 + 环境 `OPENAI_API_KEY`」不形成路由。这是 src 路由规划所有者的问题，不是 codex 扩展夹具能修的。

### 8.4 E2E/单测额外坑位（补充 §0 未列的）

- mock `models.providerTemplates` **不要**包含 `custom` 模板——服务端渲染时固定在首位，夹具再给一份就成了 strict-mode 重复元素。
- 配置表单字段用 aria-label 定位：`getByLabel(/base url/iu)`、`getByLabel("Name"|"Id", { exact: true })`；`input[name=baseUrl]` 选择器找不到。
- 模型行保存按钮文案是 **"Apply to draft"**（`t applyModel`），不是 "save model"。
- 保存时 config.set/patch **只有一个会真正发出**：先 `waitForRequest` 哪个到了用哪个，两个 deferred 都要 resolve，各挂 `.catch(() => undefined)`。
- config ack 必须回完整 snapshot 形状（config/hash/appliedConfigHash/configRevisionHash/issues/raw/valid）——只回 `{ok:true}` 会被当无效 ack。
- 断言对话框关闭：宿主元素常驻，poll `.provider-manager` 内容计数 → 0，不要查宿主本身。
- `models.test.ts` 给 provider 夹具加 `api` 字段会改变 thinking 阶梯投影路径（多出 adaptive/xhigh/max）——§0 已提，这里强调它同样适用于其他 anthropic-messages 夹具。

### 8.5 原始材料在旧机器上的位置（仅当附录不够时）

- ZCode 子代理最终报告全文：`/Users/raymond/.zcode/cli/agents/sess_7e48e0ec-955d-408d-abdc-1c5e177a0064/agent_b2f46f1e-d86a-4965-8a84-57dcc4b14b0f/output.txt`（codex 批）与 `.../agent_1a260f63-b45d-4a53-8263-a15524d4e1a0/output.txt`（其余扩展批）。
- E2E 证据包：旧机器 `/tmp/e2e-evidence.tgz`（5.2MB、130 个文件，含 before/after 成对截图 `provider-refactor-7qhhUn/before-*` 与 `after-*`，及 12 张 after 证据）。
- 前序 Codex 会话 JSONL（取证用、低优先级，勿改 `~/.codex` 其他内容）：`~/.codex/sessions/2026/10/05/rollout-2026-10-05T14-42-48-01a10acc-fd62-7a61-8fa3-c79240906ab4.jsonl`。

---

## 9. 决策回退（2026-10-06，本分支就此封存）

**本分支标记为：决策失误（decision reverted）。**

产品决策：一次性「API-key-only + 统一供应商配置」重构的范围/代价判断失误。
主线已恢复到重构开始前的基线 **31b397984**（含其前全部正常提交）；
本分支保留全部实现与验证工作，不再继续收尾。

### 若将来重启该方向，可 salvage 的部分

- 主体实现完整可用：模板库（`models.providerTemplates`，自定义首位）、
  无副作用 `models.discover`、统一供应商编辑器、保存即普通配置。
- 已验证：typecheck 全 legs 清零；copilot lane 182/182；codex websocket
  启动组与 7 例挂起全绿；UI 单测 229 例；E2E 主流程 2 用例；证据截图
  在 `.artifacts/control-ui-e2e/`（不入库，随机器保存）。
- 遗留未完成：anthropic/telegram/xai lane（部分改动已含在本分支）、
  codex shared-client 全量复跑、E2E 04/13 截图、执行通道验证、
  docs `models.mode` 话术清理（~25 页）、最终审查。

### 教训

- 删除 OAuth/订阅接入的连带面（65k 行、数百测试、25+ 页文档）远超预期，
  且原始用户需求并未要求删除 OAuth——范围是被实施计划放大的。
- 大型删除型重构应先量化测试/文档连带面，并把「删除鉴权方式」与
  「理顺配置流程」拆成独立可回退的决策。
