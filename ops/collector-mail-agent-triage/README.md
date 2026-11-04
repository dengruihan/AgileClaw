# Collector 邮件 Agent 分诊（M12，2026-11-03）

状态：**已就绪，未部署**。本包未修改 live cron、`~/.openclaw` 工作区、Gateway、邮件索引或任何消息；部署由 tower 在独立复审后执行。真实 notmuch 只读验证已在本机执行（见第 7 节），未读取或输出真实邮件内容。

> **M15 口径更新（2026-11-03）**：本包的 `collector-source-triage` 与 `payload-message.txt` 副本是 M15 部署前的基线，仍含「登记便单或排程」措辞。M15（`ops/collector-agenda-wording-fix`）已把两处改为 Agenda，并新增通知只描述本轮真实动作的规则。本包保留为 M12 切片的逐字证据，**不要在 M15 之后重新部署**；live 基线已不匹配，默认会拒绝。

覆盖对象：线上自动化 `collector`（id `6a45be21-ce0b-4b8b-8986-4c885d1ea659`，`displayName=统一事项收集`，每 10 分钟评估，`sessionTarget=isolated`）。M10 已把 3276 chars 的操作手册换成 skill 调度器；本包只改邮件这一条职责。

r1 修订（2026-11-03）：初版的 `collection/state/mail-triage.json` 水位 sidecar 违反根 `AGENTS.md` 的 SQLite/state owner 规则，已完全移除；改为无状态、有界重读：每账号查最新 20 条并全部逐项判断，移除 8 封轮次截断；补 `>8`/`>10`/正文读取失败下轮仍可查的测试，以及 notmuch search/jq/show 的显式失败检测。

## 1. 为什么改

用户明确要求：『我不打算让脚本去读取内容，就像我不打算让脚本直接获取钉钉新消息一样。我需要的是 Agent 接收到有新的邮件，新消息以后，自己调用工具读一下内容，然后结合上下文判断需不需要下一步操作』。

改前：`collection/sources/mail.mjs` 只用 mbsync + notmuch 同步并计数，正文不进 report/workspace；但 `collector-source-triage` 把邮件写成「没有正文，不得声称读过，需要时请用户打开邮箱查看」。结果 Agent 被邮件计数唤醒后只能提醒用户自己去看，没有做分诊。

改后：收集层不变（只同步、只计数、只触发）；Agent 被唤醒后自己用现有 notmuch 本地索引**只读**定位本轮可能的新邮件，读发件人/主题/必要正文，再结合上下文决定静默、登记或提醒。类似钉钉会话的补查模式，但邮件走本地索引而不是连接器。

## 2. 路由结构

| 唤醒原因（trigger 追加的消息） | 读取的 skill                    | 拥有的行为                                           |
| ------------------------------ | ------------------------------- | ---------------------------------------------------- |
| 事项变化里的钉钉会话           | `collector-dingtalk-triage`     | 不变（M10 既有）                                     |
| 事项变化里的邮件净计数         | `collector-mail-triage`（新增） | notmuch 只读定位、无状态有界重读、正文有界、邮件分诊 |
| 事项变化里的云谷/课表/OSH      | `collector-source-triage`       | 只保留云谷/OSH；邮件职责移除，其余行为不变           |
| 收集层故障                     | `collector-health-repair`       | 不变                                                 |
| 需要登记便单/排程              | `schedule-sweep`（既有，未改）  | Agenda 字段、查重、去重、优先级（本包不复述）        |
| 需要发通知                     | `collector-notify`（M11 负责）  | 通知口吻、钉钉单聊、灯效回退（本包不写）             |

payload 只增加一行邮件路由，并把 source-triage 那行改成不含邮件；其余行、边界提示和「每类 skill 每轮只读一次」保持 M10 原文。

## 3. 邮件 skill 的查询设计

`collector-mail-triage/SKILL.md` 要求：

1. **只读**：只调用 `notmuch search`、`notmuch show`、`jq`；不运行 `mbsync`、`notmuch new`、`notmuch tag`，不标记已读、不移动邮件、不读附件、不回信。
2. **无持久进度**：不创建水位/进度/缓存文件，不写 `collection/state`，不新增数据库表；每轮从最新邮件重新定位，本轮没处理到的邮件在下一次唤醒时仍在候选里。
3. **定位**：对 `folder:yungu/INBOX`、`folder:qq/INBOX` 各取最新 20 条（查询上限），合并后按时间倒序逐项判断，不额外按排序截断；唤醒里的净新增数只用来判断大概有几封新邮件，不当作逐封已处理状态。
4. **读内容**：先看 search 返回的发件人/主题，明显营销/群发/自动通知直接静默；其余才读正文：先完整捕获 `notmuch show --format=text --body=true --include-html=true --entire-thread=false '<query>'`，成功后再 `head -c 4000`，每封一次、最多 4000 字节。附件不展开（text 格式只显示 `Non-text part`），HTML 只按原文文本取可读文字，不执行链接或脚本。
5. **失败可检测**：`notmuch search`/`jq`/`notmuch show` 分别用 `||` 显式检查，输出 `NOTMUCH_SEARCH_FAILED`/`JQ_FAILED`/`NOTMUCH_SHOW_FAILED` 并非零退出；search 管道加 `set -o pipefail`，不会把空结果误当成成功。
6. **判断**：营销/通知/自动回执静默；需行动（截止、缴费/注册、学校/老师要求回复、面试/预约、账号安全、本人决策）才读 `schedule-sweep` 登记/排程，需要提醒时读 `collector-notify`；拿不准且没有明确截止/请求就静默。不复制 Agenda 规则。
7. **重复读取**：同一封可能在相邻轮重复出现；登记前按 schedule-sweep 查重，提醒前确认 agenda/上下文没有同一事项，营销/通知重读仍静默。
8. **失败边界**：notmuch 不可用/报错重试一次，仍失败本轮跳过邮件分诊，不发「收集层无正文」「请自己打开邮箱查看」类提醒，不猜内容。

没有水位文件，因此不存在「推进水位越过未处理邮件」的问题；也没有 8 封轮次截断。每轮候选都从最新邮件重新取，单封正文失败或没读的邮件下次唤醒仍是候选；每账号查询上限 20 条，超过 20 条更旧的邮件不在本轮候选内，这是有界定位的已知限制。没有新的净新增就不会再次唤醒，这是既有 trigger 条件，本包不改。

## 4. 不变的部分

- `collection/sources/mail.mjs`、`collect.mjs`、`config.mjs`、`trigger-collector.mjs`：本包不含、不写、不部署。同步、计数、净新增 > 0 唤醒的条件完全不变。
- `report.json` 的邮件条目仍只有计数与覆盖信息（`counts`/`countsDelta`/`coverage`），`state/snapshot-mail.json` 仍只有 `at`/`counts`；两者都没有发件人/主题/正文（只读核对过键名）。
- 本包不新增任何持久状态、JSON sidecar、数据库或 schema；邮件 skill 不写 `collection/state`，也不写 OpenClaw 内部数据库。
- `collector-notify` 的措辞、钉钉单聊命令与灯效回退由 M11 负责，本包不写该文件；邮件 skill 明确说明 notify 里「无法读取内容」的邮件示例不适用于本轮。
- `schedule-sweep` 只读、不写。
- cron 的 `trigger.script`、`schedule`、`timeoutSeconds`、`toolsAllow`、`lightContext`、`sessionTarget`、`wakeMode`、`enabled`、`description`、`delivery` 全部保持原样；deploy/rollback 在改动前后对 live job 做完整字段对比，M11 并行改动的 `toolsAllow`/`lightContext` 会被逐字保留（离线模拟覆盖）。

## 5. 部署（复审通过后由 tower 执行）

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-mail-agent-triage

./scripts/status.sh          # 只读：应显示 state=not deployed、message/trigger sha 与 live 状态
./scripts/deploy.sh          # 只打印计划
./scripts/deploy.sh --yes    # 写 2 个 SKILL.md + cron edit --message
./verify/discover-skills.sh --live
./scripts/status.sh          # 应显示 state=deployed
```

`deploy.sh` 只做两件事：复制 `collector-mail-triage`（新建）与 `collector-source-triage`（替换 M10 版本）两个 SKILL.md，`openclaw cron edit <id> --message ...`。不传 `--trigger-script`/`--tools`/`--light-context`/`--description`/`--every`/`--timeout-seconds`，不写 `collector-notify` 或 `schedule-sweep`，不发消息、不同步邮件、不重启 Gateway。

编辑前把完整 job JSON、旧 message、被替换的 skill 备份到 `~/.openclaw/backups/collector-mail-agent-triage/<UTC 时间戳>/`；编辑后核验 message 与 `payload-message.txt` 一致、所有未触碰字段（含 `toolsAllow`/`lightContext`/trigger）逐字未变、两个 skill 逐字节一致且真实 `openclaw skills info` 显示 `eligible=true`、`modelVisible=true`。任一项不符或读取失败会自动写回旧 message 并撤销本次 skill 改动。

live message 不是 M10 调度器基线时脚本拒绝（避免覆盖别的变更），需先 `openclaw cron get <id> --json` 复核再决定 `--allow-drift`；source-triage 既不是 M10 基线也不是本包内容时拒绝，`--force-skills` 会先备份再替换。

## 6. 回滚

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-mail-agent-triage

./scripts/rollback.sh            # 只打印计划（默认最新备份）
./scripts/rollback.sh --yes      # 写回旧 message + 恢复/删除 skill
./scripts/status.sh              # 应显示 state=not deployed
```

恢复部署前的 `collector-source-triage` 内容，删除内容仍等于本包部署值的 `collector-mail-triage`；部署后被手工改过的文件默认保留并警告。live message 在部署后又被改过时默认拒绝，`--allow-drift` 可覆盖。回滚同样核验未触碰字段（含 M11 的 toolsAllow/lightContext）未变。

## 7. 验证结果（2026-11-03，作者本机）

| 命令                                  | 结果                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-package.mjs`       | **PASS 213 checks**：路由与 owner 边界、只读约束、采集脚本/trigger 不在包内、M10 基线哈希、隐私扫描、部署/回滚安全、README 完整性                                                                                                                        |
| `./verify/notmuch-isolated.sh`        | **54 passed**：临时 maildir + 真实 notmuch 0.38.3；无状态重读、20/账号查询上限、无 8 封轮次截断、>8/>10 候选全部返回且两次查询一致、正文失败后下轮仍可查、notmuch search/show 失败显式报错、4000 字节正文、HTML 文本、附件字节不出现、tag/文件/dump 不变 |
| `./verify/live-readonly-probe.sh`     | **20 passed**：真实本地索引只读探测；两个 INBOX 有界查询（≤20/账号）、头部/正文读取、`notmuch dump`/计数/最新文件 sha 前后不变；report.json 邮件条目无内容字段、snapshot 只有 at/counts、无进度 sidecar；只打印计数与长度                                |
| `./verify/discover-skills.sh`         | **2 passed**：临时 workspace + 真实 `openclaw skills info`；两个 skill `eligible=true`、`modelVisible=true`、路径正确                                                                                                                                    |
| `./verify/deploy-sim.sh`              | **67 passed**：假 CLI + 临时目标树；dry run、apply、幂等、字段不变、M11 toolsAllow/lightContext 保留、drift/冲突拒绝、edit 失败撤销、校验失败回滚、rollback（含 M11 字段变化后回滚）                                                                     |
| `./scripts/status.sh`（只读）         | `state: not deployed`；message sha = M10 基线 `7315a8…`，trigger sha = `2fefcf…`，`toolsAllow` 9 项、`lightContext=true`；mail skill absent，source-triage 等于 M10 基线                                                                                 |
| `./scripts/deploy.sh`（无 `--yes`）   | 只打印计划：将 create `collector-mail-triage`、replace `collector-source-triage`、只改 message；未改动 live                                                                                                                                              |
| `./scripts/rollback.sh`（无 `--yes`） | 当前无备份，按预期报错退出；有备份路径由 deploy-sim 覆盖                                                                                                                                                                                                 |

live 只读基线（`openclaw cron get`，2026-11-03）：payload.message 是 M10 调度器（sha256 `7315a8a3b51385bbbfb808ed52062ac966aa6bd181af3217bd82d336f22c44ea`，1156 bytes）；`toolsAllow` 仍为 9 项（含 `light_control`，M11 尚未改动）；`lightContext=true`；trigger 与 schedule 未变。notmuch 版本 0.38.3，索引包含两个 INBOX；`notmuch show` 为只读，探测前后 `notmuch dump`、计数与最新邮件文件 sha 均未变。

## 8. 部署后自然观察

离线无法执行真实 isolated Agent 的模型判断，因此以下只能部署后自然周期观察，不 force run、不发测试消息、不手工触发邮件：

1. 下一个自然周期 `triggerEvalCount` 递增、无异常。
2. 真实邮件计数增长的一轮：模型先 `read` `collector-mail-triage/SKILL.md`，按最新有界候选定位，正文读取不超过 4000 字节，不声称附件内容。
3. 营销/通知类邮件静默；需要行动的邮件先读 `schedule-sweep` 再登记，提醒能概括发件人、时间与要点，不出现「请自己打开邮箱查看」。
4. 不出现新的进度文件，`collection/state` 与数据库没有新增记录；相邻轮重复读到的邮件按 agenda 去重，不重复提醒。
5. 多封同时到达时按每账号 20 条查询窗口逐项判断，不因排序截断；超出窗口的更旧邮件不处理、不提醒、不登记。
6. notmuch 查询失败的一轮：静默跳过并在结果说明，不发无正文提醒。
7. `openclaw cron get` 复核 message/trigger/toolsAllow/lightContext 与部署时一致；M11 的改动没有被覆盖。

## 9. 风险与边界

- 未验证：模型是否按 skill 选对候选、判断是否值得行动。需部署后自然观察。
- 无持久进度意味着相邻轮次会重复读到查询窗口内的旧邮件（每账号最多 20 条）；依赖 agenda 查重和内容判断避免重复登记/提醒，营销/通知重读仍静默。宁可重复读，也不做无正文误报。
- 每账号候选上限 20 条；一次新增超过 20 封时，更旧的部分不在候选内，属于有界定位的已知限制。
- 邮件 Date 头异常早时可能不在「最新 20 条」里；不额外写状态去追踪，下轮有新邮件时仍可能进入候选。
- 没有新的净新增时 trigger 不再唤醒，本轮没处理到的邮件要等下一次唤醒；不新增固定巡检（任务明确不改唤醒条件）。
- `collector-notify` 仍保留「邮箱净增…打开邮箱查看」示例；本包不改它（M11 负责），由邮件 skill 明确覆盖该场景。建议后续由 notify owner 更新示例。
- M10 包（`ops/collector-skill-dispatcher`）的 `status.sh` 在本包部署后会显示 drifted，它的 `deploy.sh` 会因 message 不是 M10 基线而拒绝；不要再回滚到 M10 message，除非回滚本包。需要时以本包为当前 owner。
- 本包不包含真实邮件正文、发件人、地址、message id 或凭据；隔离验证只用 `.invalid` 保留域名。
