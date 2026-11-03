# Live skill visibility simplification（M20，2026-11-03）

状态：**包已完成、隔离验证通过，live 未部署**。M15 和 M19 仍在 active，按 mission 顺序，本包不抢先写 live collector skill；合并后执行文末部署步骤即可。

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

| skill                     | live 路径                                                             | 来源      | 正文 owner                                                    | 为什么可以隐藏                                                             |
| ------------------------- | --------------------------------------------------------------------- | --------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| collector-dingtalk-triage | `~/.openclaw/workspace/skills/collector-dingtalk-triage/SKILL.md`     | workspace | `ops/collector-skill-dispatcher`                              | dispatcher 绝对路径 read                                                   |
| collector-mail-triage     | `~/.openclaw/workspace/skills/collector-mail-triage/SKILL.md`         | workspace | `ops/collector-mail-agent-triage`                             | dispatcher 绝对路径 read                                                   |
| collector-source-triage   | `~/.openclaw/workspace/skills/collector-source-triage/SKILL.md`       | workspace | `ops/collector-agenda-wording-fix`（M15；M10/M12 为历史副本） | dispatcher 绝对路径 read                                                   |
| collector-health-repair   | `~/.openclaw/workspace/skills/collector-health-repair/SKILL.md`       | workspace | `ops/collector-skill-dispatcher`                              | dispatcher 绝对路径 read                                                   |
| collector-notify          | `~/.openclaw/workspace/skills/collector-notify/SKILL.md`              | workspace | `ops/collector-agenda-wording-fix`（M15；M10/M13 为历史副本） | dispatcher 与分诊 skill 绝对路径 read                                      |
| biandan-todo              | `~/.openclaw/agents/main/agent/workshop-skills/biandan-todo/SKILL.md` | workshop  | live workshop（无仓库 ops 包）                                | 用户已停用便单，AGENTS.md 与 schedule-sweep 已接管待办；文件保留供显式请求 |

## 4. 包归属与旧包防护

**一个责任一个 owner**：

- 本包只拥有“可见性”这一行，不拥有 skill 正文；
- collector skill 正文仍由各自的 ops 包维护；
- `biandan-todo` 正文由 live workshop 维护。

旧包（M10 `collector-skill-dispatcher`、M12 `collector-mail-agent-triage`、M13 `collector-mail-notify-example`，以及 M15/M19 的 collector 包）保留各自的 pre-M20 副本作为历史证据。重新部署旧包可能把 live 文件换回没有 flag 的版本，因此：

1. 旧包自己的部署脚本默认拒绝 live hash 漂移，需要人工 `--force-skills` / `--allow-drift`；
2. `scripts/status.sh` 会把 live hash 与仓库里旧包副本比对；一旦匹配，输出 `VISIBILITY-RESTORED by <旧包路径>` 并以非零退出；
3. 部署后使用 `scripts/status.sh --expect-hidden`，任何旧包回退都会显式失败，不会静默恢复模型可见性；
4. `verify/check-package.mjs` 扫描 `ops/**/files/**`，未知的新包副本会被判为未 reconcile。

本 mission 的写入范围只允许 `ops/live-skill-visibility-simplification/**`，所以没有修改旧包内副本；这是有意的历史证据保留，不是遗漏。

## 5. 部署

前置：**M15 和 M19 都已合并**，且它们的 live collector 更新已稳定。部署脚本只写 6 个 SKILL.md；不改 cron、不跑 cron、不发钉钉/邮件、不重启 Gateway。

```bash
cd /home/raymond/repos/AgileClaw/ops/live-skill-visibility-simplification

./scripts/status.sh          # 只读：6 个目标应为 visible（authoring baseline），live count 79
./scripts/deploy.sh          # 只打印计划：planned inserts: 6
./scripts/deploy.sh --yes    # 备份 -> 原子插入 -> 全量复核；失败自动恢复
```

`deploy.sh --yes` 的顺序：

1. 预检：6 个文件存在、frontmatter 可解析、`name:` 唯一、没有 `disable-model-invocation: false` 等非 true 值；任何一项不符都在写 live 前退出。
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

| 命令                            | 结果                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-package.mjs` | **133 passed, 0 failed**：6 个 baseline/target hash、正文逐字不变、绝对路径保留、旧包副本、README 契约、脚本禁用操作                                                                  |
| `./verify/deploy-sim.sh`        | **89 passed, 0 failed**：6 行插入、唯一改动、备份、幂等、两种 rollback、旧包回退检测、drift 拒绝、非法 frontmatter/flag 拒绝、info 失败与无关 skill 变化的自动恢复                    |
| `./verify/check-catalog.sh`     | **68 passed, 0 failed**：真实 loader 下 6 个 `modelVisible true→false`、`eligible=true`、文件可读、正文只多一行；可见 control 不变、disabled control 仍 disabled；无关 skill 状态不变 |

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

- 依赖 **M15**（collector Agenda 措辞）和 **M19**（collector 课表同步）合并后再部署，避免打乱它们的 collector 更新顺序。
- 本包 baseline 快照取自 2026-11-03 的 live：M15 已于 02:44Z 完成 live 部署，因此 `collector-notify` / `collector-source-triage` 的 fixture 是 M15 后的正文，尽管 M15 分支当时仍在 rework、尚未合并。
- 本包“只插入一行”的设计不复制正文，因此 M15/M19 后续改动 source-triage/notify 时仍可直接部署；`status.sh` 会把正文与 authoring baseline 不同但 flag 缺失的状态标为 `visible (content differs ...)`，不是错误。
- 截至交付时 M15 仍在 rework、M19 仍在实现，**live 未部署**；因此 live 79→73 的最终验证留给合并后的部署步骤。

## 10. 风险与边界

1. **模型目录快照可能滞后**：持久 cron session 可能继续使用旧目录快照；dispatcher 的绝对路径 `read` 不依赖快照，无需重启 Gateway。
2. **显式调用仍可用**：隐藏只阻止模型主动选择；用户显式 `$collector-notify` 仍能读到全文，符合“非破坏性隐藏”。
3. **旧包回退**：只能检测、不能阻止旧包脚本被 `--force` 运行；`status.sh --expect-hidden` 会让回退显式失败。
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
│   ├── lib.sh                            # 路径、manifest、备份、旧包 hash 检测
│   ├── deploy.sh                         # 计划 / 备份 / 原子写 / 全量复核 / 失败恢复
│   ├── rollback.sh                       # 按备份恢复 before 状态
│   └── status.sh                         # 只读分类 + VISIBILITY-RESTORED 检测
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
