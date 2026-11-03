# Collector Agenda 措辞修正（M15，2026-11-03）

状态：**已就绪，待部署**。本包是 M15 的唯一可重放入口：五个 live 面一次切换，先备份后写入，失败自动恢复；不发送钉钉/邮件测试消息，不 force run cron，不重启 Gateway。

覆盖对象：线上自动化 `collector`（id `6a45be21-ce0b-4b8b-8986-4c885d1ea659`，`displayName=统一事项收集`，每 10 分钟评估，`sessionTarget=isolated`，`lightContext=true`）。

## 1. 为什么改

M14 已用只读证据定位到：2026-11-03 10:23 的「新作业 Numpy Advanced」通知声称「已登记进便单」并照抄了 `collector-notify` 的示例，但该轮真实写入只有 Agenda（revision 177→178），整轮 transcript 没有任何便单写入调用。根因是通知措辞 owner 与新的主清单 owner 脱节：

- `collector-notify/SKILL.md:15,18` 把「便单」写成登记目的地（第 18 行还是 M13 当天 10:00 新加的邮件示例）；
- live cron payload 与 `collector-source-triage/SKILL.md:8` 仍写「登记便单或排程」；
- `~/.openclaw/workspace/AGENTS.md:486` 写「便单是行动主清单」，与 `schedule-sweep/SKILL.md:9`「Agenda 是事项和执行计划的唯一主清单」冲突；
- `collection/dingtalk-notify.mjs:21` 的职责注释仍把「便单/日程」当查重对象。

用户授权原话：『可以，调研一下，然后修改』。目标不是删除独立 biandan skill，而是让 collector 不再把便单当目的地，并禁止通知虚构本轮未发生的动作；其余通知内容与分诊行为保持不变。

## 2. 改动的五个面

| 面                                        | 基线（部署前 live）      | 本包结果                                                                                                            |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `~/.openclaw/workspace/AGENTS.md`         | `878c56aa…`，35227 bytes | `30f66a9c…`，35297 bytes：两处锚点替换——Agenda 是行动主清单、便单已停用；浏览器登录段落标注「旧便单脚本（已停用）」 |
| cron `payload.message`                    | `2fe4d3e6…`，1243 bytes  | `45832094…`，1251 bytes / 785 chars：路由改为「需要登记 agenda 待办或排程」                                         |
| `skills/collector-notify/SKILL.md`        | `f62eeab1…`，2303 bytes  | `bac70a7e…`，2742 bytes：示例改 Agenda、新增「只说本轮做过的动作」规则、显式停用便单                                |
| `skills/collector-source-triage/SKILL.md` | `10f20ed1…`，868 bytes   | `68c89b98…`，870 bytes：「登记 agenda 或跟进」                                                                      |
| `collection/dingtalk-notify.mjs`          | `e063f099…`，14215 bytes | `67a09472…`，14215 bytes：仅第 21 行注释，去重对象改为「agenda 事项查重」                                           |

### collector-notify 的措辞规则

- Agenda 是 collector 记录待办的唯一去处；便单已停用，不登记、不在通知里提。
- 通知里的每个动作必须是本轮真实完成的结果：登记要有成功的 `agenda` 回执，排程或提醒要有实际写下的执行块；没做到、失败或不确定就不写，只陈述来源事实和下一步。
- 示例只示范口吻和长度，不照抄示例里的动作。
- 保留不变：玲珑口吻与 1–3 句长度、五类示例的位置、钉钉私人机器人 Markdown 单聊命令、失败时如实报告且不换通道、去重职责归属。

## 3. 为什么两处用锚点补丁

`AGENTS.md` 是操作者私有工作区配置（35 KB），`dingtalk-notify.mjs` 是 14 KB 的发送脚本。把它们整文件复制进仓库会带入与本次修正无关的私有内容，也会让后续无关编辑不断制造 drift。因此这两处只记录窄锚点：

- 部署前：锚点的旧文本必须恰好出现 1 次、新文本不存在；
- 部署后：旧文本消失、新文本恰好出现 1 次，且必需锚点存在；
- 其他位置的并行编辑不阻止部署；锚点本身被改坏则默认拒绝，需人工复核后 `--allow-drift`。

两个 SKILL.md 与 cron message 用完整副本 + manifest 哈希锁定：review 后改动包内文件会让 `status.sh`/`deploy.sh` 在写任何目标或备份之前退出。

## 4. 部署

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-agenda-wording-fix

./scripts/status.sh        # 只读：五个面应为 baseline / baseline / replace 计划
./scripts/deploy.sh        # 只打印计划
./scripts/deploy.sh --yes  # 备份后写入五个面
```

应用顺序：

1. 校验包内副本与 payload 的 sha256 必须等于 manifest 记录值；两个 skill 的禁用词/必需锚点自检。
2. 读取 live job，打印五个面的分类（unchanged / replace / drift）。
3. 基线不符默认拒绝；人工 diff 后可用 `--allow-drift`。
4. 备份到 `~/.openclaw/backups/collector-agenda-wording-fix/<UTC 时间戳>/`：完整 job JSON、旧 message、两个 SKILL.md 的 before 副本、两个补丁文件的 before 副本、`deploy.json`。
5. 原子写入两个 SKILL.md 与两个补丁；`openclaw cron edit <id> --message "$(cat payload-message.txt)"`。
6. 复核：message sha、五个面内容、必需锚点、无正向便单措辞、`openclaw skills info` 的 `eligible/modelVisible/filePath`，以及 trigger/schedule/timeout/toolsAllow/lightContext/sessionTarget/wakeMode/enabled/description/displayName/delivery 逐字未变。
7. 任一项失败：写回旧 message、恢复四个文件副本，退出 1。

部署后只读核验（本包已按此执行）：

```bash
./scripts/status.sh                         # 五个面应全部 deployed / applied
openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659 --json
openclaw skills info collector-notify --agent main --json
openclaw skills info collector-source-triage --agent main --json
openclaw gateway health
```

不发钉钉消息、不发邮件、不 force run cron、不重启 Gateway。

## 5. 回滚

```bash
./scripts/rollback.sh                     # 只打印计划（默认最新备份）
./scripts/rollback.sh --yes               # 写回五个面的 before 状态
./scripts/rollback.sh --yes --backup DIR  # 指定历史备份
```

只恢复当前内容仍等于本包部署值的面；部署后被别人改过时默认拒绝，确认后用 `--force`。message 与四个文件副本一起恢复，并复核未触碰的 job 字段未变。

## 6. 验证

```bash
node verify/check-package.mjs  # 静态契约：哈希、基线重建、正向便单拒绝、部署安全、隐私
./verify/deploy-sim.sh         # 临时根 + 假 CLI：计划、备份、幂等、drift、恢复、回滚
```

| 命令                                                               | 结果                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-package.mjs`                                    | **PASS 161 checks**：review 哈希锁定、两个基线逐字重建、正向便单拒绝/禁令放行、五个面锚点、部署/回滚安全、隐私            |
| `./verify/deploy-sim.sh`                                           | **PASS 73 checks**：基线重建、只读计划、备份内容、幂等、skill/锚点 drift 拒绝、包审查后改动拒绝、字段不变、回滚、失败恢复 |
| `./scripts/status.sh`（部署前，只读）                              | 五面 `baseline`；message `2fe4d3e6…`；trigger `a34f72e4…`；`toolsAllow` 8 项、`lightContext=true`                         |
| `./scripts/deploy.sh`（无 `--yes`）                                | 只打印计划：2 个 replace、2 个 patch、message replace；未写 live                                                          |
| `./scripts/deploy.sh --yes`                                        | 备份到 `~/.openclaw/backups/collector-agenda-wording-fix/20261103T024424Z`，五面写入并自检通过                            |
| `./scripts/status.sh`（部署后，只读）                              | 五面 `deployed`/`applied`；message `45832094…`；trigger `a34f72e4…` 未变                                                  |
| `openclaw skills info collector-notify --agent main --json`        | `eligible=true`、`modelVisible=true`、`filePath` 指向 live SKILL.md                                                       |
| `openclaw skills info collector-source-triage --agent main --json` | `eligible=true`、`modelVisible=true`、`filePath` 指向 live SKILL.md                                                       |
| `openclaw gateway health`                                          | `OK (6ms)`，DingTalk configured                                                                                           |

第一次 `--yes` 尝试暴露了一个真实问题：验证器把 AGENTS.md 里「旧便单脚本的独立 state.json」也算作正向便单措辞，部署因此自动回滚到五面基线；随后给该历史说明补上「（已停用）」并把校验改为允许显式禁令，第二次部署通过。该失败尝试的备份保留在 `~/.openclaw/backups/collector-agenda-wording-fix/20261103T024317Z`。

`deploy-sim.sh` 不读 live：它用包内 `baselines/` 作为部署前状态，用 `verify/fake-openclaw.sh` 模拟 `cron get/edit` 与 `skills info`，并断言只改 message 与四个文件、未触碰字段逐字保留。

## 7. 不改动的部分

- 不写 `schedule-sweep`、`biandan-todo` 或任何独立便单 skill；便单仍只在用户明确要求时使用。
- 不写 `collector-mail-triage`、`collector-dingtalk-triage`、`collector-health-repair`。
- 不改 cron 的 `trigger.script`、`schedule`、`timeoutSeconds`、`toolsAllow`、`lightContext`、`sessionTarget`、`wakeMode`、`enabled`、`description`、`displayName`、`delivery`。
- 不改 `~/.openclaw/openclaw.json`、工具策略、Gateway 进程或服务。
- 不发钉钉消息、不发邮件、不同步邮件索引、不 force run cron。
- 不改 `collection/*.bak.*`、`~/.openclaw/backups/` 或其他历史备份。

## 8. 旧 ops 包的处理

`ops/collector-mail-notify-example`（M13）、`ops/collector-mail-agent-triage`（M12）、`ops/collector-skill-dispatcher`（M10）的包内副本**保留为各自基线/历史切片的证据**，不在这里重写：

- 它们的校验把包内副本钉在各自授权时的 live 哈希上（例如 M13 的「单行替换重建基线」、M10 的「五个通知示例逐字保留」），重写副本会伪造历史证据并让这些校验失真；
- M15 已把「当前维护的副本」转移到本包：两个 SKILL.md 的完整副本、payload 副本、manifest 哈希与禁用词都在这里；
- 本包 `baselines/` 记录的正是在线被替换的旧内容，并通过 `check-package.mjs` 断言它与 M13/M12 的 owner 副本逐字一致；
- 重新部署旧包不会静默回退：它们的 live 基线已不再匹配，默认拒绝，需要人工 `--allow-drift`/`--force-skills`。

## 9. 残留风险

1. **模型是否照抄示例无法离线证明**：本包只能保证模型可见的措辞与规则不再指向便单，并要求只写本轮真实动作；部署后需自然周期观察下一轮真实通知。
2. **持久 cron session 的 skill 目录快照可能滞后**：dispatcher 用绝对路径 `read` 当前磁盘，不依赖快照；无需重启 Gateway。
3. **范围外的旧副本仍含便单字样**：`ops/collector-language-style`、`ops/collector-phase2`、`ops/collector-dingtalk-detail-triage`、`ops/dingtalk-private-notifications` 不在本 mission 的写入范围；已用 TowerFinding 报告，未在本包内重写。
4. **AGENTS.md 的浏览器段落**仍提到旧便单脚本的独立 `state.json`，这是历史登录边界说明、不是待办目的地指引；本次已标注「（已停用）」，保留原意。
5. **未 force run**：部署后第一轮真实唤醒依赖自然 cron 周期，本包不制造测试消息。

## 10. 隐私

- 交付物只含 skill/payload 文本、短路径、哈希与补丁；示例是合成内容。
- `AGENTS.md` 与 `dingtalk-notify.mjs` 不整文件入库，包内只保存被替换的窄锚点。
- 备份在 `~/.openclaw/backups/` 本地，权限随原文件；`deploy.json` 只记录路径与 sha256。
- 验证脚本不打印真实邮件内容、地址、消息 ID、staffId 或凭据。

## 11. 包结构

```text
ops/collector-agenda-wording-fix/
├── manifest.json                                  # 五个面的基线/目标哈希、锚点、禁用与必需 token
├── README.md
├── payload-message.txt                            # 目标 cron message
├── baselines/                                     # 部署前状态，供离线模拟与逐字重建
│   ├── collector-notify.pre-m15.md
│   ├── collector-source-triage.pre-m15.md
│   └── payload-message.pre-m15.txt
├── files/home/raymond/.openclaw/workspace/skills/
│   ├── collector-notify/SKILL.md
│   └── collector-source-triage/SKILL.md
├── scripts/
│   ├── lib.sh                                     # 哈希锁定、锚点状态、job 字段快照
│   ├── deploy.sh                                  # 计划 / 备份 / 原子写 / 失败恢复
│   ├── rollback.sh                                # 从备份恢复五个面
│   └── status.sh                                  # 只读分类
└── verify/
    ├── check-package.mjs                          # 静态契约检查
    ├── deploy-sim.sh                              # 临时根目录端到端模拟
    └── fake-openclaw.sh                           # 模拟 cron get/edit 与 skills info
```
