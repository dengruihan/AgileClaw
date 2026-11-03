# Live skill visibility simplification（M20，2026-11-03）

状态：**M20 已合并；首次 live 部署被 `status.sh` 正确中止后，M21 修复了 owner 识别缺陷**。live 仍 79，六个目标文件未改；本包现在把 M19 的 `collector-source-triage` 正文识别为合法当前内容，合并后按 §5 部署并验证 79→73。

目标：把 6 个不需要模型目录路由的 skill 从模型可见目录中隐藏，让 live modelVisible 从 **79 降到 73**，不删除任何 skill、不改 18,000 字目录预算、不改 allowlist、不改 collector 的绝对路径读取。

## 1. 为什么

M17 的 live 实测（`node dist/index.js skills check`）：

- 已发现 119 个 skill；
- modelVisible + eligible **79 个**；
- 已 disabled 40 个；
- 79 个可见条目把 18,000 字目录挤成 compact 格式，每条描述只剩约 40–44 字。

去掉下面 6 个“本来就不靠目录路由”的条目后：

| 指标             | 现在   | 本包后    |
| ---------------- | ------ | --------- |
| modelVisible     | 79     | **73**    |
| 每条描述可用预算 | ~44 字 | 约 125 字 |

收益是恢复路由描述，不是省 token；不涉及删除、合并或 Tier B 低频能力。

## 2. 机制：只加一行 loader 支持的 frontmatter

加载器真实支持的字段是 `disable-model-invocation`：

- `src/skills/loading/frontmatter.ts:171-179` 把它解析为布尔值；
- `src/skills/discovery/skill-index.ts:13-19` 据此把它移出 available-skills prompt；
- `src/skills/loading/skill-entry-metadata.ts:72` 把它映射为 `includeInAvailableSkillsPrompt=false`。

本包在每个目标 frontmatter 的 `name:` 行后插入且只插入一行：

```yaml
disable-model-invocation: true
```

文件仍完整保留在磁盘，`eligible=true`、`userInvocable=true`；显式 `/skill` 或 `$skill` 仍可使用。**不是** `alwaysActive`，也**不是** `always: true`；这两个写法本包既不改也不使用。

collector dispatcher 用 `read` + 绝对路径加载 5 个专项 skill，不依赖模型目录。本包不复制、不重写 skill 正文，因此：

- collector 的绝对路径引用逐字保留；
- 正文除插入的那一行外 byte-identical；
- 不覆盖 M15/M19 对 collector skill 的更新。

## 3. 六个目标与内容归属

| skill                     | live 路径                                                             | 来源      | 正文 owner                                                                  | 为什么可以隐藏                                                             |
| ------------------------- | --------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| collector-dingtalk-triage | `~/.openclaw/workspace/skills/collector-dingtalk-triage/SKILL.md`     | workspace | `ops/collector-skill-dispatcher`                                            | dispatcher 绝对路径 read                                                   |
| collector-mail-triage     | `~/.openclaw/workspace/skills/collector-mail-triage/SKILL.md`         | workspace | `ops/collector-mail-agent-triage`                                           | dispatcher 绝对路径 read                                                   |
| collector-source-triage   | `~/.openclaw/workspace/skills/collector-source-triage/SKILL.md`       | workspace | `ops/collector-course-sync`（M19；M10/M12/M15 为历史副本）                  | dispatcher 绝对路径 read                                                   |
| collector-health-repair   | `~/.openclaw/workspace/skills/collector-health-repair/SKILL.md`       | workspace | `ops/light-effect-cleanup`（M11；无快照副本，dispatcher 内是 pre-M11 副本） | dispatcher 绝对路径 read                                                   |
| collector-notify          | `~/.openclaw/workspace/skills/collector-notify/SKILL.md`              | workspace | `ops/collector-agenda-wording-fix`（M15；M10/M13 为历史副本）               | dispatcher 与分诊 skill 绝对路径 read                                      |
| biandan-todo              | `~/.openclaw/agents/main/agent/workshop-skills/biandan-todo/SKILL.md` | workshop  | live workshop（无仓库 ops 包）                                              | 用户已停用便单，AGENTS.md 与 schedule-sweep 已接管待办；文件保留供显式请求 |

## 4. 包归属与旧包防护

**一个责任一个 owner**：

- 本包只拥有“可见性”这一行，不拥有 skill 正文；
- collector skill 正文仍由各自的 ops 包维护；M19 之后 `collector-source-triage` 的正文 owner 是 `ops/collector-course-sync`，`ops/collector-agenda-wording-fix`（M15）与 M10/M12 副本是历史；
- `biandan-todo` 正文由 live workshop 维护。

manifest 为每个目标声明两份清单，而不是全局扫描 `ops/**/files/**`：

- `currentOwnerCopies`：当前正文 owner 包里的副本（`collector-source-triage` 指向 `ops/collector-course-sync`，`collector-notify` 指向 `ops/collector-agenda-wording-fix`，其余分诊 skill 指向各自 dispatcher/邮件包）；
- `legacyCopies`：更早包的副本，重新部署会把 live 换回旧正文。

`scripts/status.sh` 的分类顺序是 baseline → current owner → legacy：

1. 与 authoring baseline 相同：`visible (authoring baseline; current owner <包>; ready to hide)`；
2. 与 baseline 不同、但等于 `currentOwnerCopies` 中的副本：`visible (current owner body <包>; flag absent)`，是合法正文，不是回退；
3. 等于 `legacyCopies`（或任何未声明包副本）：`VISIBILITY-RESTORED by <包路径>` 并以非零退出；
4. 其余：`content differs from authoring baseline`。

`currentOwnerCopies` 永远优先于 `legacyCopies`，所以 M19 合并后 `ops/collector-course-sync` 的现行正文不会再被误判为回退（M20 首轮部署中止的原因）。`scripts/deploy.sh` 同样拒绝把 `legacyCopies` 恢复出来的旧正文隐藏起来。

旧包（M10 `collector-skill-dispatcher`、M12 `collector-mail-agent-triage`、M13 `collector-mail-notify-example`、M15 `collector-agenda-wording-fix`）保留各自的 pre-M20 副本作为历史证据：

1. 旧包自己的部署脚本默认拒绝 live hash 漂移，需要人工 `--force-skills` / `--allow-drift`；
2. `scripts/status.sh` 一旦匹配旧包副本，输出 `VISIBILITY-RESTORED by <旧包路径>` 并以非零退出；
3. 部署后使用 `scripts/status.sh --expect-hidden`，任何旧包回退都会显式失败，不会静默恢复模型可见性；
4. `verify/check-package.mjs` 扫描 `ops/**/files/**`，要求每个六目标副本都出现在 owner 或 legacy 清单里；未 reconcile 的新包副本、owner 副本与 baseline 不一致、或 legacy 副本其实是当前正文，都会判失败。

本 mission 的写入范围只允许 `ops/live-skill-visibility-simplification/**`，所以没有修改旧包内副本；这是有意的历史证据保留，不是遗漏。

## 5. 部署

前置：**M15 和 M19 均已合并（2026-11-03）**，且它们的 live collector 更新已稳定。部署脚本只写 6 个 SKILL.md；不改 cron、不跑 cron、不发钉钉/邮件、不重启 Gateway。

```bash
cd /home/raymond/repos/AgileClaw/ops/live-skill-visibility-simplification

./scripts/status.sh          # 只读：6 个目标应为 visible（authoring baseline），live count 79
./scripts/deploy.sh          # 只打印计划：planned inserts: 6
./scripts/deploy.sh --yes    # 备份 -> 原子插入 -> 全量复核；失败自动恢复
```

`deploy.sh --yes` 的顺序：

1. 预检：6 个文件存在、frontmatter 可解析、`name:` 唯一、没有 `disable-model-invocation: false` 等非 true 值、目标正文不是 `legacyCopies` 恢复出来的旧包正文；任何一项不符都在写 live 前退出。
2. 备份到 `~/.openclaw/backups/live-skill-visibility-simplification/<UTC 时间戳>/`：6 份 before 副本、`deploy.json`、`skills-before.json`、每个目标的 `skills info` 快照。
3. 用 `scripts/apply-flag.mjs` 在 `name:` 后插入一行；原子替换。
4. 复核：
   - 每个文件 = before + 恰好一行，正文 hash 不变；
   - `skills info`：`eligible=true`、`modelVisible=false`、`userInvocable`/`commandVisible`/`source` 不变；
   - `skills list --json`：只有这 6 个从 visible→hidden，其他 skill 的 `eligible/disabled/blockedByAllowlist/blockedByAgentFilter/modelVisible/userInvocable/commandVisible/source` 全部不变；
   - live 79 时同时断言 79→73；
   - `openclaw gateway health` 为 `OK`。
5. 任一项失败：恢复 6 份 before，`deploy.json` 标记 `restored-after-failure`，退出 1。

部署后只读复核：

```bash
./scripts/status.sh --expect-hidden
openclaw skills list --json
openclaw gateway health
```

预期：`status.sh --expect-hidden` 全部 PASS；6 个目标 `modelVisible=false`、`eligible=true`；其他 skill 状态不变；Gateway health OK。

## 6. 回滚

```bash
./scripts/rollback.sh                         # 只打印计划（默认最新备份）
./scripts/rollback.sh --yes                   # 恢复该备份的 before 状态
./scripts/rollback.sh --yes --backup DIR      # 指定历史备份
./scripts/rollback.sh --yes --force           # 部署后正文又改过时，显式覆盖
```

默认拒绝覆盖部署后被别人改过的文件；只有内容仍等于本次部署结果时才恢复。恢复前会把当前文件另存到 `rollback-<时间戳>/`，恢复后核对 hash、`skills list` 全量快照和目标 `skills info`。

注意：对“已经 hidden 的备份”回滚会回到 hidden 状态，而不是强行 visible；这是 backup 的 before 状态语义。

## 7. 验证结果

```bash
node verify/check-package.mjs   # 静态契约 + transformer + 旧包副本扫描
./verify/deploy-sim.sh          # 临时 OpenClaw home + 假 CLI：部署/幂等/回滚/失败恢复
./verify/check-catalog.sh       # 真实 loader：临时 workspace 中验证目录隐藏与文件可读
```

2026-11-03 实测：

| 命令                            | 结果                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node verify/check-package.mjs` | **169 passed, 0 failed**：6 个 baseline/target hash、正文逐字不变、绝对路径保留、owner/legacy 副本归属与 staleness、unreconciled 副本、README 契约、脚本禁用操作                           |
| `./verify/deploy-sim.sh`        | **100 passed, 0 failed**：6 行插入、唯一改动、备份、幂等、两种 rollback、旧包回退检测、drift 拒绝、非法 frontmatter/flag 拒绝、info 失败与无关 skill 变化的自动恢复，以及 M19 正文归属回归 |
| `./verify/check-catalog.sh`     | **68 passed, 0 failed**：真实 loader 下 6 个 `modelVisible true→false`、`eligible=true`、文件可读、正文只多一行；可见 control 不变、disabled control 仍 disabled；无关 skill 状态不变      |

M21 新增的回归覆盖（`deploy-sim.sh`）：

- `source-triage baseline tracks the M19 owner body`：fixture、manifest、`ops/collector-course-sync` 副本三处 hash 一致；
- `status accepts the M19 owner body` / `status names ops/collector-course-sync as the current owner` / `current owner body is not reported as restored`：M19 正文不再触发 `VISIBILITY-RESTORED`；
- `status rejects the legacy M15 source-triage body` / `deploy refuses a legacy-restored body` / `refused deploy wrote nothing`：真正历史的 M15 副本仍被拦截，且部署不写任何字节；
- `source-triage: one line inserted onto the M19 body`：部署只在 M19 正文插入一行。

隔离测试使用临时目录和假 CLI，不读也不写 live skill 文件；`check-catalog.sh` 使用临时 workspace/state，仅读取包内 baseline 副本。

## 8. 不改动的部分

- 不删除、不合并、不移动任何 skill；
- 不改 `DEFAULT_MAX_SKILLS_PROMPT_CHARS=18_000` 或 `agents.main.skillsLimits.*`；
- 不改全局或 main 的 allowlist；
- 不改 cron payload、trigger、schedule、toolsAllow、lightContext、sessionTarget、wakeMode、delivery；
- 不改 `openclaw.json`、Gateway 进程/服务；
- 不改 `gateway-restart-recovery`、`skill-install-audit`、`dingtalk-troubleshoot`、`cron-creation` 或 Tier B 低频 skill；
- 不发钉钉/邮件，不 force run cron，不发送测试消息。

## 9. 依赖与 live 状态

- 依赖 **M15**（collector Agenda 措辞）和 **M19**（collector 课表同步）合并后再部署，避免打乱它们的 collector 更新顺序；两者已于 2026-11-03 合并。
- 本包 baseline 快照取自 2026-11-03 的 live。`collector-notify` 的 fixture 是 M15 后的正文，owner 为 `ops/collector-agenda-wording-fix`。
- **M21** 把 `collector-source-triage` 的 fixture/manifest baseline/target 刷新为 M19 的正文（`ops/collector-course-sync` 副本，sha256 `b5193893…`，1961 bytes），因此 live 当前字节就是 authoring baseline；目标 hash 是同一正文加一行（`9da7e1ea…`，1992 bytes）。M15 及更早的 source-triage 副本仍是 `legacyCopies`，重部署会被 `VISIBILITY-RESTORED` 拦下。
- 本包“只插入一行”的设计不复制正文，因此 owner 包后续改动 source-triage/notify 时仍可直接部署；`status.sh` 会把等于 `currentOwnerCopies` 的正文标为 `visible (current owner body ...)`，只有旧包副本才是回退。
- `biandan-todo` 的已提交 fixture 经仓库 pre-commit 的 YAML 格式化（description 的双引号转单引号，语义不变，少 4 bytes），manifest 的 baseline/target 哈希以这份已提交 fixture 为准。live 文件仍保留原双引号写法，因此部署前 `status.sh` 对 `biandan-todo` 显示 `content differs from authoring baseline; flag absent` 是预期状态；deploy 仍按 live 文件锚定插入，不依赖该哈希。
- 截至 M21 交付：M20 已合并，但首轮 live 部署在写文件前被 `status.sh` 正确中止，live 仍 79、六个目标未改；**live 部署与 79→73、73 个可见、六个目标 hidden/eligible/可读、Gateway healthy 的最终验证留给合并后的部署步骤**。

## 10. 风险与边界

1. **模型目录快照可能滞后**：持久 cron session 可能继续使用旧目录快照；dispatcher 的绝对路径 `read` 不依赖快照，无需重启 Gateway。
2. **显式调用仍可用**：隐藏只阻止模型主动选择；用户显式 `$collector-notify` 仍能读到全文，符合“非破坏性隐藏”。
3. **旧包回退**：`status.sh` 会在部署前后检测并显式失败，`deploy.sh` 会拒绝把旧正文隐藏；但仍不能阻止旧包脚本被 `--force` 运行后覆盖 live。
4. **biandan-todo 文件仍在**：用户已停用便单，文件保留供明确请求；本包只隐藏目录项。
5. **未做自然周期观察**：不 force run cron、不发测试消息；部署后需等下一次自然唤醒确认 collector 行为不变。

## 11. 隐私

- 包内只包含 6 个 skill 的运维文本、manifest、哈希、短路径和合成 control fixture；
- 不包含邮件正文、地址、消息 ID、staffId、手机号或凭据；
- 隔离测试全部在 `mktemp` 目录，退出即删除；
- 备份在 `~/.openclaw/backups/` 本地，`deploy.json` 只记录路径、哈希和可见性计数。

## 12. 包结构

```text
ops/live-skill-visibility-simplification/
├── README.md
├── manifest.json                         # 6 个目标、baseline/target hash、owner、guard、79→73
├── scripts/
│   ├── apply-flag.mjs                    # 唯一 frontmatter 编辑器：插入/检查/移除/验证
│   ├── lib.sh                            # 路径、manifest、owner/legacy 内容归属、备份
│   ├── deploy.sh                         # 计划 / 备份 / 原子写 / 全量复核 / 失败恢复
│   ├── rollback.sh                       # 按备份恢复 before 状态
│   └── status.sh                         # 只读分类 + owner 归属 + VISIBILITY-RESTORED 检测
└── verify/
    ├── check-package.mjs                 # 静态契约与 transformer 检查
    ├── check-catalog.sh                  # 真实 loader 隔离验证
    ├── deploy-sim.sh                     # 临时 home + 假 CLI 端到端模拟
    ├── compare-catalog.mjs               # skills list 前后快照比较
    ├── check-info.mjs                    # skills info 前后契约
    ├── fake-openclaw                     # 模拟 CLI 入口
    ├── fake-openclaw.mjs
    └── fixtures/
        ├── baseline/                     # 6 个目标在 authoring 时的 live 副本
        ├── control-visible/SKILL.md      # 合成 control：保持可见
        └── control-disabled/SKILL.md     # 合成 control：保持 disabled
```

## 13. M21 修复记录：owner 识别

**现象**：M20 合并后的首次 live 部署被 `scripts/status.sh` 正确中止，退出前没有写任何文件。它把 live 当前的 `collector-source-triage` 正文（M19 `ops/collector-course-sync` 副本，sha256 `b5193893…`）判为 `VISIBILITY-RESTORED by ops/collector-course-sync/...`，而 live 79、六文件未改。

**根因**：`scripts/lib.sh` 的旧 `legacy_lookup` 扫描 `ops/**/files/*/<name>/SKILL.md` 的全部副本，只按字节相等判定“旧包回退”。M19 之后 `ops/collector-course-sync` 是 source-triage 的当前正文 owner，它自己的副本也被当成旧包，于是合法当前内容被误报为回退。

**修复**：

1. manifest 为每个目标新增 `currentOwnerCopies`，只列当前正文 owner 的副本；`legacyCopies` 只保留真正更早的副本。M19 的 course-sync 副本移到 owner，M15 与 M10/M12 的 source-triage 副本留在 legacy；`collector-health-repair` 的 dispatcher 副本实际是 pre-M11 正文，因此归为 legacy 而不是 owner。
2. `lib.sh` 用 `copy_match` / `classify_visible_content` 取代 blanket scan：先认 owner 副本，再认 legacy 副本；owner 正文是合法内容，未声明的包副本仍按回退处理，旧保护不放松。
3. `scripts/status.sh` 输出 `authoring baseline; current owner <包>` 或 `current owner body <包>`，只有 legacy 副本才输出 `VISIBILITY-RESTORED`。
4. `scripts/deploy.sh` 预检拒绝隐藏 `legacyCopies` 恢复出来的旧正文（写 live 前退出）。
5. 只刷新 `collector-source-triage` 的 fixture baseline 与 manifest 的 baseline/target hash（M19 正文 1961 bytes，插入一行后 1992 bytes），其余五个目标哈希不变；M15 正文不再作为 baseline，避免它被重部署时被误认为当前内容。
6. `verify/check-package.mjs` 断言 owner 副本与 baseline 一致、owner/legacy 清单不相交、legacy 副本确实是旧正文，并要求所有仓库副本都在清单里；`verify/deploy-sim.sh` 新增 M19 正文归属、legacy M15 拦截和单行插入回归。

**边界**：本轮只实现、隔离测试、提交；live 部署仍须合并后按 §5 执行，并验证 79→73、六个目标 hidden/eligible/可读、M19 正文不变、Gateway health OK。
