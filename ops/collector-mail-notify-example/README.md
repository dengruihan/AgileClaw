# collector-notify 邮件示例同步（M13，2026-11-03）

状态：**已就绪，未部署**。本包只替换 `collector-notify` 里一行过时的邮件示例，未修改 live 工作区、cron、`~/.openclaw/openclaw.json`、Gateway 或任何消息；部署由 tower 在独立复审后执行。

> **M15 取代（2026-11-03）**：本包的 `collector-notify` 副本是 M15 部署前的基线（sha256 `f62eeab1…`），其邮件示例含已被证实的「记进便单」错误措辞。M15（`ops/collector-agenda-wording-fix`）已把该文件更新为 Agenda-only 措辞和「只说本轮做过的动作」规则。本包保留为 M13 切片的逐字证据，**不要在 M15 之后重新部署**；它的 live 基线已不匹配，默认会拒绝。

依赖：M11（灯效入口清理）与 M12（Agent 邮件正文分诊）已上线。本包基线就是 M11/M12 之后的 live `collector-notify`：sha256 `6be95ab3…`，2216 bytes。

## 1. 为什么改

M12 之后邮件由 Agent 用本地 notmuch 只读定位并读正文，再结合上下文决定静默、登记或提醒；只有确实读不到正文才跳过那一封。`collector-notify` 仍保留 M4 时代的示例：

> 无法读取内容：「邮箱净增 2 封。邮件正文不在收集范围，需要的话打开邮箱查看；有值得跟进的我会登记提醒。」

这句话与新行为相反：它把「用户自己去看邮箱」当成常规通知，模型可能照抄，造成误导。本包把它换成一条基于已读正文的简短邮件提醒，并写明读不到就跳过、不让用户去翻邮箱。

## 2. 唯一的改动

`skills/collector-notify/SKILL.md` 的「口吻」示例第 5 条：

```diff
-- 无法读取内容：「邮箱净增 2 封。邮件正文不在收集范围，需要的话打开邮箱查看；有值得跟进的我会登记提醒。」
+- 邮件提醒：「英语老师发来邮件：周五家长会改到 19:00，需要回复是否参加。我已记进便单，今晚提醒你回复。」正文确实读不到就跳过那封，不猜内容，也不提醒你自己去看邮箱。
```

| 项                         | 值                                                                             |
| -------------------------- | ------------------------------------------------------------------------------ |
| 基线（已上线，M11/M12 后） | `6be95ab380d8435300d5401e40639440814662849f623c778180fa3718d857dc`，2216 bytes |
| 本包内容                   | `f62eeab14129180fe3ade4ee9e8d20416dd31bba20dc19c5b43f2088b4ce9dae`，2303 bytes |

把新示例换回旧示例可逐字节重建基线（`verify/check-package.mjs` 会检查），因此除这一行外没有别的差异。

新示例沿用 M4 定下的贾维斯式语气：先把事情说清楚，再交代已经做的动作和下一步；简短、有边界，不自称或模仿角色。示例是合成的通用场景，不含真实邮件正文、发件地址、message id 或凭据。

保留不动：其余 4 条口吻示例、口吻规则、钉钉私人机器人发送命令、M11 的失败处理（如实记录、不换通道重发）、去重职责说明。`description` 已是 M11 清理后的版本，不再提灯效。

## 3. 部署

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-mail-notify-example

./scripts/status.sh        # 只读：应为 state: baseline
./scripts/deploy.sh        # 只打印计划
./scripts/deploy.sh --yes  # 备份后替换唯一一个 SKILL.md
```

`deploy.sh` 没有 `--yes` 时只读。应用时：

1. 校验包内文件的 sha256 **必须等于 `manifest.target.deployedSha256`**（审查后被改动立即拒绝，不写目标、不建备份）、必需锚点存在，并确认过时/灯效 token 不在；
2. 只有 live 文件等于记录的基线才替换；等于本包内容则报 `already deployed` 并退出；其他内容视为 drift，拒绝执行；
3. 备份到 `~/.openclaw/backups/collector-mail-notify-example/<UTC 时间戳>/`（`SKILL.md.before` + `deploy.json`，记录前后 sha）；
4. 用同目录临时文件 + `mv` 原子写入；
5. 复核 sha256、字节长度、锚点与禁用 token；失败自动恢复备份并退出 1。

包哈希与 `manifest.target.deployedSha256` 不一致时，`deploy.sh`（以及同为只读的 `status.sh`）会立即退出，不写目标、不创建备份。

`--allow-drift` 用于确认过人工 diff 后仍要替换（替换前同样备份）。

部署后建议在能正常运行 CLI 的环境执行一次（本机 `pnpm openclaw` 被运行中 Gateway 的 runtime-artifact 保护拦截，见第 7 节）：

```bash
openclaw skills info collector-notify --agent main --json
```

确认 `eligible=true`、`modelVisible=true`、`filePath` 指向 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md`。

## 4. 回滚

```bash
./scripts/rollback.sh            # 只打印计划（默认最新备份）
./scripts/rollback.sh --yes      # 写回备份内容
```

只恢复当前内容仍等于本包部署值的文件；部署后被别人改过时拒绝，确认后用 `--force`。`--backup DIR` 可指定历史备份。恢复后复核 sha256 等于备份记录的 before 值。

## 5. 验证

```bash
node verify/check-package.mjs   # 静态契约：单行 diff 重建基线、锚点、隐私、脚本语法
./verify/deploy-sim.sh          # 临时根目录端到端：计划、备份、幂等、drift、回滚
```

结果见下表（2026-11-03，作者本机；模拟不触碰 live）。

| 命令                               | 结果                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-package.mjs`    | **PASS 67 checks**：包 sha/字节与 manifest 固定哈希一致、单行替换重建基线、旧文案与灯效 token 缺席、其余示例/命令/失败处理保留、部署入口锁定 manifest 哈希、脚本语法与只读约束、隐私扫描                                        |
| `./verify/deploy-sim.sh`           | **PASS 42 checks**：临时根 + 临时备份目录；计划只读、应用与备份内容、幂等、drift 拒绝、`--allow-drift`、回滚、二次回滚，文件权限保持，其他 skill 与 `openclaw.json` 不变；审查后改动包时 deploy/status 拒绝且不写目标、不建备份 |
| `./scripts/status.sh`（只读 live） | `state: baseline`（`6be95ab3…`，2216 bytes）；stale token 为旧邮件示例 4 项；无备份                                                                                                                                             |
| `./scripts/deploy.sh`（只读 live） | 只打印计划：`replace`、`6be95ab3… -> f62eeab1…`；未写 live                                                                                                                                                                      |
| `./scripts/rollback.sh`（无备份）  | 按预期退出 1：`no backup with deploy.json under …`                                                                                                                                                                              |

## 6. 不改动的部分

- 不写 cron：`payload.message`、`trigger.script`、`schedule`、`timeoutSeconds`、`toolsAllow`、`lightContext`、`delivery` 全部保持原样；脚本不调用任何 `openclaw` 子命令。
- 不写 `~/.openclaw/openclaw.json`，不改工具策略。
- 不写 `collector-mail-triage`、`collector-source-triage`、`collector-dingtalk-triage`、`collector-health-repair`、`schedule-sweep` 或其他任何 skill。
- 不发钉钉消息、不读/发邮件、不同步邮件索引、不重启 Gateway。

## 7. 明确报告的残留

1. **历史 ops 包仍是旧文案**：`ops/collector-skill-dispatcher`、`ops/light-effect-cleanup` 的 skill 快照与校验仍编码旧的「打开邮箱查看」示例（以及 M11 前的灯效回退）。重新部署这些旧包会覆盖本包结果。本包用基线 sha 做 drift 检查：若 live 被旧包改回，`status.sh` 会显示 drift，`deploy.sh` 默认拒绝，需先人工复核。
2. **模型是否照抄示例未离线验证**：本包只同步措辞，不能离线证明模型下一轮一定按新示例表述；部署后需自然邮件轮观察。
3. **skill 发现未在本机复核**：`pnpm openclaw skills info` 在当前 checkout 被运行中 Gateway 的 runtime-artifact 保护拒绝，属于环境限制而非本包问题；部署后按第 3 节复核。

## 8. 隐私

- 交付物只含 skill 文本、短路径和补丁；示例是合成内容。
- 备份在 `~/.openclaw/backups/` 本地，权限随原文件；`deploy.json` 只记录路径与 sha256。
- 验证脚本不打印真实邮件内容、地址或凭据。

## 9. 包结构

```text
ops/collector-mail-notify-example/
├── manifest.json                                  # 目标、基线/部署 sha、替换行、禁用与必需 token
├── README.md
├── files/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md
├── scripts/
│   ├── lib.sh                                     # 路径、基线 sha、token 检查、备份查找
│   ├── deploy.sh                                  # 计划 / 备份 / 原子写 / 失败恢复
│   ├── rollback.sh                                # 从备份恢复，drift 默认拒绝
│   └── status.sh                                  # 只读现状分类
└── verify/
    ├── check-package.mjs                          # 静态契约检查
    └── deploy-sim.sh                              # 临时根目录端到端模拟
```
