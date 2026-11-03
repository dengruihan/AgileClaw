# collector skill 调度器切换（M10，2026-11-03）

状态：**已就绪，未部署**。本包未修改 live cron、`~/.openclaw` 工作区、Gateway 或任何消息；部署由 tower 在独立复审后执行。

覆盖对象：线上自动化 `collector`（id `6a45be21-ce0b-4b8b-8986-4c885d1ea659`，`displayName=统一事项收集`，每 10 分钟评估，`sessionTarget=isolated`，`lightContext=true`，`timeoutSeconds=600`）。

## 1. 为什么改

线上 `payload.message` 是 3276 chars 的完整操作手册：唤醒原因判断、钉钉补查步骤、其他来源分诊、通知语言、故障修复全部硬编码在每一轮提示词里。每次唤醒都注入全文，新增一类处置只能继续加长。

本次改为**轻量调度器**：payload 只按唤醒原因选择并读取对应 skill（697 chars），需要执行某类任务时才加载该类 skill。规则各归一个 owner，`schedule-sweep` 继续独占 Agenda 登记/排程规则，不复制第二套。

保留不变：无需行动静默、本人已回复不提醒、补查失败不发无正文提醒、每轮补查上限、故障边界、通知语言与钉钉 Markdown 单聊及灯效回退。不新增邮件详情、固定巡检等能力，不清理灯效入口。

## 2. 路由结构

| 唤醒原因（trigger 追加的消息） | 读取的 skill                       | 拥有的行为                                                        |
| ------------------------------ | ---------------------------------- | ----------------------------------------------------------------- |
| 事项变化里的钉钉会话           | `collector-dingtalk-triage`        | 身份映射、正文补查、本人已回复跳过、未读、10 个会话上限、失败降级 |
| 事项变化里的邮件/云谷/课表/OSH | `collector-source-triage`          | 邮件无正文边界、完整条目分诊、skipped 忽略、无需行动静默          |
| 收集层故障（源/collect.mjs）   | `collector-health-repair`          | 定位、登录自愈、streak 验证、故障通知、不动 agenda                |
| 需要发通知时（由前两类触发）   | `collector-notify`                 | 玲珑口吻与示例、钉钉单聊命令、灯效回退                            |
| 需要登记便单/排程时            | `schedule-sweep`（线上既有，未改） | Agenda 字段、查重、去重、优先级、排程                             |

skill 部署位置：`/home/raymond/.openclaw/workspace/skills/<name>/SKILL.md`（workspace skills，优先级最高的文件来源，与 `yungu-tasks` 等运营者维护的 skill 同源；workshop 目录留给 agent 自己捕获的提案）。`schedule-sweep` 仍在 `/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`，本包只读、不写。

## 3. 关键证据：按需读取 skill 的可靠方式

没有假设 `$skill` 在 cron 中生效。以下结论来自本仓库同一套运行代码与 live 只读观察（2026-11-03）：

1. **`lightContext` 只跳过 workspace bootstrap 注入，不跳过 skills。** `src/cron/isolated-agent/run-executor.ts` 把 `payload.lightContext=true` 映射为 `bootstrapContextMode="lightweight"`；[Automation payloads](../../docs/automation/cron-jobs/payloads.md) 对 `--light-context` 的定义是 “Skip workspace bootstrap file injection”。skills snapshot 是独立解析的（`src/cron/isolated-agent/run-prepare.ts:499` 调用 `resolveCronSkillsSnapshot`）。
2. **live 证据：collector 轻上下文轮确实注入了 skill 目录。** 只读查询 `~/.openclaw/agents/main/agent/openclaw-agent.sqlite` 的 `session_entry_snapshots`，`agent:main:cron:6a45be21-…` 的 `skillsSnapshot` 有 73 个 skill（含 `schedule-sweep` 与 workspace 的 `yungu-tasks` 等），prompt 17964 chars。因此本轮新 skill 也会进入同一目录；SOUL.md 仍不注入（所以通知口吻必须自包含在 `collector-notify`）。
3. **live 目录是紧凑格式，`<location>` 是 `~/...`。** 同一 snapshot 显示 “compact format (descriptions shortened)”，`schedule-sweep` 的 location 为 `~/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`。目录行会截断描述，不能把路由正确性押在目录文本上；dispatcher 因此写绝对路径。
4. **`read` 工具能读绝对路径和 `~` 路径。** `src/agents/sessions/tools/path-utils.ts:35-58`：`expandPath` 展开 `~`，`resolveToCwd` 对绝对路径原样返回，没有 workspace 根限制；`read` 已在 9 项 `toolsAllow` 中。
5. **不能依赖 `$skill`。** 显式 `$skill` 展开只在 agent/command 准备路径（`src/agents/command/prepare.ts:376-407`），cron payload 不经过它；`skills_read`/`skills_search` 也不在 `toolsAllow` 里。因此 dispatcher 明确要求用 `read` + 绝对路径。
6. **持久 cron session 的 snapshot 可能滞后，但路由不依赖它。** cron job 的 session key 是 `agent:main:cron:<jobId>`（live 可见），`resolveCronSkillsSnapshot` 会优先复用已有 snapshot，workspace 版本变化时才刷新（`src/skills/runtime/refresh-state.ts`）。dispatcher 的绝对路径 `read` 直接读当前磁盘，不依赖目录缓存；`openclaw skills info <name> --agent main --json` 用当前磁盘证明发现、`eligible` 与 `modelVisible`。

复现只读证据：

```bash
openclaw skills info schedule-sweep --json   # eligible=true, modelVisible=true, 线上 workshop 路径
./verify/discover-skills.sh                  # 用临时 state/config/workspace + 真实 skills CLI 验证 4 个新 skill
```

## 4. 行为保真对照

| 线上 payload 行为                                         | 新 owner                                                  |
| --------------------------------------------------------- | --------------------------------------------------------- |
| 先看唤醒原因，只处置点明内容                              | `payload-message.txt`（调度器）                           |
| 通知语言、5 类示例、1–3 句、紧急先行动、幽默边界          | `collector-notify/SKILL.md`（逐字保留）                   |
| 钉钉身份映射、补查正文、本人已回复跳过、未读交叉判断      | `collector-dingtalk-triage/SKILL.md` 步骤 1–4             |
| 钉钉 10 个会话上限、超限只跳过、失败不发无正文提醒        | `collector-dingtalk-triage/SKILL.md` 步骤 7–8             |
| 邮件只有净计数、不得总结正文                              | `collector-source-triage/SKILL.md`                        |
| 云谷/课表/OSH 完整条目、skipped 忽略、无需行动静默        | `collector-source-triage/SKILL.md`                        |
| 钉钉单聊命令、退出码 1 与灯效回退                         | `collector-notify/SKILL.md`                               |
| 收集故障定位、`collect.mjs <源> --force`、streak 归零     | `collector-health-repair/SKILL.md`                        |
| 故障通知每源每日一次、不动 agenda、不排程、不改其他自动化 | `collector-health-repair/SKILL.md`                        |
| 登记/排程/查重/去重/优先级                                | `schedule-sweep/SKILL.md`（既有 owner，本包不改、不复述） |

## 5. 部署（复审通过后由 tower 执行）

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-skill-dispatcher

./scripts/status.sh          # 只读：应显示 state=not deployed、message/trigger sha 与基线
./scripts/deploy.sh          # 只打印计划
./scripts/deploy.sh --yes    # 写 4 个 SKILL.md + cron edit --message
./verify/discover-skills.sh --live
./scripts/status.sh          # 应显示 state=deployed
```

`deploy.sh` 只做两件事：复制 4 个新 skill 文件，`openclaw cron edit <id> --message ...`。它不会传 `--trigger-script`/`--tools`/`--light-context`/`--description`/`--every`，不写 `schedule-sweep`，不发消息、不重启 Gateway。编辑前把完整 job JSON、旧 message、被替换的 skill 备份到 `~/.openclaw/backups/collector-skill-dispatcher/<UTC 时间戳>/`；编辑后核验：

- `payload.message` 与 `payload-message.txt` 一致（按 `$(cat)` 归一化，无尾换行）；
- `trigger.script`、`schedule`、`timeoutSeconds`、`toolsAllow`、`lightContext`、`sessionTarget`、`wakeMode`、`enabled`、`description`、`delivery` 全部未变；
- 4 个 skill 文件逐字节一致，且真实 `openclaw skills info` 显示 `eligible=true`、`modelVisible=true`。

任一项不符或读取失败会自动写回旧 message 并撤销本次新建/替换的 skill 文件。live message 不是基线时脚本拒绝，需先看 `openclaw cron get <id> --json`，再决定是否 `--allow-drift`；目标 skill 已存在且内容不同则拒绝，`--force-skills` 会先备份再替换。

## 6. 回滚

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-skill-dispatcher

./scripts/rollback.sh            # 只打印计划（默认最新备份）
./scripts/rollback.sh --yes      # 写回旧 message + 撤销 4 个 skill
./scripts/status.sh              # 应显示 state=not deployed
```

只删除内容仍等于本包部署值的 skill 文件；部署后被手工改过的文件默认保留并警告。live message 在部署后又被其他变更改过时默认拒绝，`--allow-drift` 可覆盖。回滚同样核验 trigger 与其余字段未变。

## 7. 验证结果（2026-11-03，全部不触碰 live）

| 命令                                  | 结果                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-package.mjs`       | **200/200 PASS**：调度器路由与 697 chars 预算、4 个 skill 的 owner 边界、schedule-sweep 不被复制、5 个通知示例逐字保留、隐私/凭据扫描、部署脚本不碰 trigger/tools/lightContext         |
| `./verify/discover-skills.sh`         | **4/4 PASS**：真实 `openclaw skills info` 在临时 workspace 中判定 4 个 skill `eligible=true`、`modelVisible=true`，路径正确                                                            |
| `./verify/deploy-sim.sh`              | **67/67 PASS**：假 CLI + 临时目标树，覆盖 dry run、apply、幂等、字段不变、drift 拒绝、skill 冲突拒绝、edit 失败撤销、校验失败自动回滚、rollback、rollback drift 拒绝与 `--allow-drift` |
| `./scripts/status.sh`（无 `--yes`）   | 只读 live：`state: not deployed`，message sha 与 trigger sha 均等于基线，4 个 skill 显示 absent/not-found                                                                              |
| `./scripts/deploy.sh`（无 `--yes`）   | 只打印计划，未改动 live；确认将创建 4 个 skill 且只编辑 message                                                                                                                        |
| `./scripts/rollback.sh`（无 `--yes`） | 当前无备份，按预期报错退出；有备份路径由 deploy-sim 覆盖                                                                                                                               |

live 只读基线（`openclaw cron get`，2026-11-03）：

| 项              | 值                                                                                    |
| --------------- | ------------------------------------------------------------------------------------- |
| payload.message | 3276 chars，sha256 `fa8537795b3b7bcda4b1feb2dcf7b9a5edbb24ed80401c295a7812e11e7ca25c` |
| trigger.script  | sha256 `2fefcf25abc694c645c1e856ec85433f2b5bff25ce72d938e2be92b8f53e3a91`             |
| schedule        | every 600000ms                                                                        |
| toolsAllow      | ls, read, edit, write, apply_patch, exec, process, light_control, agenda              |
| lightContext    | true                                                                                  |
| delivery        | none                                                                                  |

## 8. 部署后需要自然周期观察的部分（如实声明）

离线无法执行真实 isolated Agent 的模型判断，因此以下只能部署后观察，不 force run、不发测试消息：

1. 下一个自然周期 `triggerEvalCount` 递增、无异常。
2. 真实钉钉 delta 的一轮：模型先 `read` `collector-dingtalk-triage/SKILL.md`，本人已回复的会话静默，他人未回复且值得行动时提醒能概括要点。
3. 真实其他来源 delta 的一轮：邮件不声称读正文；需要行动时才读 `schedule-sweep` 并登记。
4. 故障轮：按 `collector-health-repair` 定位，通知走钉钉单聊、失败时灯效回退。
5. `openclaw skills info <name> --agent main --json` 对 main 仍为 eligible/modelVisible；`openclaw cron get` 复核 message/trigger sha。
6. 持久 cron session 的 skill 目录快照可能晚于磁盘刷新；dispatcher 的绝对路径 `read` 不依赖它，因此无需重启 Gateway。若要确认目录也刷新，可在下一轮观察模型是否直接 `read` 指定路径。

## 9. 风险与边界

- 4 个新 skill 会进入 main 的 skill 目录，每个会话多约 4 条目录项（每条约 97 chars + 描述）。描述均标注「仅供 collector 自动化使用」，减少主对话误用。
- 通知口吻从 payload 移到 skill：dispatcher 以「发通知前读 collector-notify」硬门控；未读到时按调度器规则不发通知，避免口吻回退成公文式。
- skill 读取失败时该类处置停止并在本轮结果说明，不凭记忆操作，也不发猜测性提醒。
- 持久 cron session 可能继续使用旧的 skill 目录快照（目录里暂时看不到 4 个新 skill）。dispatcher 用绝对路径 `read` 当前磁盘，不依赖该快照；目录刷新只是额外的发现路径，不需要重启 Gateway。
- 未验证：模型是否按调度器选对 skill、判断是否值得提醒。需部署后自然周期观察。
- 本包不包含真实私人消息正文、cid、messageId、手机号或个人 userId；示例文案沿用用户已批准的线上示例。
