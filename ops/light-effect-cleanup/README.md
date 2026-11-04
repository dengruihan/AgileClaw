# 灯效入口清理（M11，2026-11-03）

状态：**已就绪，未部署**。本包没有修改 live 工作区、cron、`~/.openclaw/openclaw.json`、Gateway 或任何消息；部署由 tower 在独立复审后执行。

依赖：M10 `collector-skill-dispatcher` 已合并并部署。线上 collector 的 `payload.message` 已是 697 字符调度器（sha256 `7315a8a3…`），4 个 skill 已在 workspace。本包只清理灯效入口，不改调度器路由。

## 1. 清理范围（live 入口与 owner）

| 入口                                                 | owner                | 现状                                     | 本包动作                                                              |
| ---------------------------------------------------- | -------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| collector `payload.toolsAllow`                       | cron job             | 含 `light_control`                       | 移除，保留 `ls,read,edit,write,apply_patch,exec,process,agenda`       |
| collector `trigger.script` 两处修障文案              | cron job（内嵌副本） | “失败退回灯效，每源每日一次”             | 改为“发送失败就在本轮结果写明失败与原因，不换通道重发”                |
| `workspace/collection/trigger-collector.mjs`         | collection 源文件    | 与内嵌 trigger 同文，供重新同步          | 同上，保持两边一致                                                    |
| `workspace/AGENTS.md` 手机推送规则                   | workspace AGENTS     | 要求走 `ntf.cjs light send`              | 改为私人钉钉机器人 Markdown 单聊（`collection/dingtalk-notify.mjs`）  |
| `workspace/scripts/sentinel.md` 通知段               | sentinel 规则        | “沿用现有手机灯效通知渠道”               | 改为私人钉钉机器人渠道                                                |
| `skills/collector-notify/SKILL.md`                   | collector 通知 skill | description 与失败分支含灯效回退命令     | 移除回退，失败时如实报告、不换通道重发                                |
| `skills/collector-health-repair/SKILL.md`            | collector 修障 skill | 失败退回灯效                             | 同上                                                                  |
| `workshop-skills/dingtalk-busy-reply/SKILL.md`       | 代复 skill           | 代复后用灯效提醒                         | 改为私人钉钉通知，保留 24 小时去重                                    |
| `workshop-skills/openclaw-automations-jobs/SKILL.md` | 自动化任务 skill     | cron 自推送示例写 `ntf light`            | 改为“通过自己的通道推送”，不再示例灯效                                |
| `workshop-skills/yoooclaw-plugin-status/SKILL.md`    | 插件状态 skill       | 大段 `ntf light send` 说明与历史审计流程 | 删除灯效推送、审计段落；保留插件状态、通知/录音/图片/网页数据查询     |
| `collection/README.md`                               | collection 文档      | “失败退回灯效推送”                       | 改为“发送失败如实记录，不换通道重发”                                  |
| `collection/dingtalk-notify.mjs`                     | 通知出口             | 失败 stderr 打印灯效回退命令；头注释同   | 失败只报告进度与原因，不再给出灯效命令                                |
| `openclaw.json` `tools.alsoAllow`（全局 + main）     | 工具策略             | 显式列出 5 个灯效工具                    | 移除 5 项，保留 `notifications_summary`、`ai_todo_*`、`plugin-update` |
| `openclaw.json` `tools.deny`                         | 工具策略             | 未设置                                   | 新增 5 个灯效工具的 deny                                              |

未动：collector `payload.message`、schedule、timeout、`lightContext`、`delivery`、session/wake 设置；所有历史备份、memory、`daily-report/schedule-2026-10-20.md`、`sentinel-state.json` 中的灯效记录；plugin 安装与启用状态。

## 2. 为什么用 `tools.deny` 而不是只删 `alsoAllow`

只从 `alsoAllow` 删除条目**不能**真正移除插件工具。当前配置没有 `tools.allow`，`alsoAllow` 会被 `pickSandboxToolPolicy` 当作 “allow-all + 附加项”（`src/agents/sandbox-tool-policy.ts`），进入插件 allowlist 后 `includesDefaults=true`；`src/plugins/tools.ts` 对非 optional 插件工具默认放行。phone-notifications 的 manifest 没有把灯效工具标成 optional，所以它们仍会暴露。

因此本包同时：

1. 从两处 `alsoAllow` 删除 5 个灯效工具（清理显式授权与文档噪音）；
2. 新增 `tools.deny`（`src/plugins/tools.ts` 的 denylist 匹配先于默认放行）作为实际关闭手段。

deny 是全局的：其他 agent 也会失去灯效工具。当前只有 main 在使用这些工具；若将来需要恢复，删掉对应 deny 项即可（回滚脚本会恢复部署前状态）。

## 3. 插件共享功能：不卸载

`phone-notifications` 插件同时承载**仍在使用的**通知、录音、图片、网页、ASR、`ai_todo_*`、`plugin-update`、`result_deliver` 等能力。整体停用会一并破坏这些功能，因此本包：

- 不修改 `openclaw.plugin.json` / `dist/` / 插件版本；
- 不设置 `plugins.entries.phone-notifications.enabled=false`；
- 只通过工具策略关闭 5 个灯效工具，部署后校验插件仍为 `loaded` 且 `notifications_summary`、`ai_todo_list` 仍在。

## 4. 部署

```bash
cd /home/raymond/repos/AgileClaw/ops/light-effect-cleanup

./scripts/status.sh                 # 只读：逐项显示现状与残留灯效 token
./scripts/deploy.sh                 # 只打印计划，不写任何东西
./scripts/deploy.sh --yes           # 应用（文件 + trigger/tools + config）
```

部署脚本没有 `--yes` 时只读。应用时：

1. 校验 job id/name、`payload.message` 不含灯效 token、每个文件补丁目标存在且次数正确、config 两处 `alsoAllow` 与 `deny` 可计算；
2. 若文件 sha 与作者基线不同，需要 `--allow-drift`（先人工 diff）；
3. 备份到 `~/.openclaw/backups/light-effect-cleanup/<UTC 时间戳>/`：每个被改文件、完整 collector job、trigger、config 子集；
4. 按“文件 → collector trigger/tools → config patch”顺序应用；
5. 复核所有目标文件、job 的 message 与未改字段、trigger/tools、config alsoAllow/deny；
6. 调用 `openclaw skills info collector-notify --agent main --json` 与 `openclaw plugins list --json` 确认 skill 可见、插件仍加载且保留非灯效工具；
7. 对部署后的 `dingtalk-notify.mjs` 跑一次 `--dry-run`（**不发送**），确认目标解析与分块计划仍正常；
8. 任一复核失败会自动回滚本次变更并退出 1。

`--skip-discovery` / `--skip-notify-check` 只用于离线模拟或明确知道 Gateway/连接器不可用的排障场景；正常部署不要跳过。`--backup DIR` 可指定备份目录。

部署脚本不发送消息、不重启 Gateway、不修改插件安装。

## 5. 回滚

```bash
cd /home/raymond/repos/AgileClaw/ops/light-effect-cleanup

./scripts/rollback.sh               # 只打印计划（默认最新备份）
./scripts/rollback.sh --yes         # 恢复文件、trigger/tools、config
```

只恢复当前内容仍等于“部署后值”的表面；部署后被别人改过的表面会跳过并要求 `--force`。回滚同样校验 `payload.message` 未变。

## 6. 验证结果（2026-11-03，全部未触碰 live 写入）

| 命令                                                                | 结果                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-package.mjs`                                     | **63/63 PASS**：10 个文件入口、5 个灯效工具、补丁 new 文本无灯效命令（含裸 `ntf light`）、无凭据/私人 ID、JS 语法           |
| `node verify/deploy-sim.mjs`                                        | **59/59 PASS**：临时 root + fake CLI，覆盖只读计划、drift 拒绝、config 失败自动恢复、成功部署、status、幂等、回滚、二次回滚 |
| `./scripts/status.sh`（只读 live）                                  | 10 个文件均 `needs cleanup`，trigger/alsoAllow/deny 与计划一致，无 precondition error                                       |
| `./scripts/deploy.sh`（只读 live）                                  | 只打印计划：trigger `2fefcf… -> a34f72…`，tools 去掉 `light_control`，deny 新增 5 项                                        |
| `openclaw config patch --file /tmp/lec-config-patch.json --dry-run` | `Dry run successful: 3 update(s) validated`                                                                                 |
| `node collection/dingtalk-notify.mjs ... --dry-run`（清理前）       | exit 0，`dryRun:true`，1 个分块计划；未发送                                                                                 |

live 只读基线（2026-11-03）：

| 项                                                        | 值                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| collector `payload.message`                               | 697 chars，sha256 `7315a8a3b51385bbbfb808ed52062ac966aa6bd181af3217bd82d336f22c44ea` |
| collector `trigger.script`                                | sha256 `2fefcf25abc694c645c1e856ec85433f2b5bff25ce72d938e2be92b8f53e3a91`            |
| collector `toolsAllow`                                    | `ls,read,edit,write,apply_patch,exec,process,light_control,agenda`                   |
| `tools.alsoAllow` / `agents.entries.main.tools.alsoAllow` | 各 12 项，含 5 个灯效工具                                                            |
| `tools.deny`                                              | 未设置                                                                               |

## 7. 部署后需要自然验证的部分（如实声明）

离线无法执行真实 isolated Agent 轮，以下只能部署后观察，不 force run、不发测试消息：

1. 下一个自然周期 `triggerEvalCount` 递增，`lastRunStatus=ok`。
2. 真实钉钉 delta 轮：`collector-notify` 仍可被 `read` 到，通知走钉钉单聊。
3. 一次真实通知失败时（如连接器不可用）：`dingtalk-notify.mjs` 只输出已送达块数与失败原因，不再出现灯效命令；collector 在本轮结果里记录失败，不换通道重发。
4. 真实故障轮：trigger 文案不再提灯效，修障 skill 只发钉钉通知并如实记录失败。
5. `openclaw cron get <id>` 复核 `payload.message` sha 未变、`toolsAllow` 无 `light_control`、trigger 无“灯效”。
6. `openclaw plugins list` 复核 phone-notifications 仍 `loaded`，通知/录音/网页/图片能力可用。
7. 主会话不再因 AGENTS/sentinel 规则主动要求灯效推送；需要提醒时走钉钉。

## 8. 明确报告的残留（无法安全关闭的部分）

1. **插件仍注册灯效工具**：`openclaw.plugin.json` 的 `contracts.tools` 与 dist 仍包含 `light_control`、`lightrules_*`，`ntf light send` CLI 也仍在。工具策略已 deny，agent 不能再通过工具调用；但 `exec` 仍能执行该 CLI。彻底移除需要插件上游提供开关或修改 vendor dist，本包不做（会被自动更新覆盖，且超出可审查范围）。
2. **插件仍无条件注入灯效提示词**：`dist/index.cjs` 的 `before_prompt_build` 每次都会追加 `buildLightRulePromptGuidance()`（约 80958 行），内容要求模型“必须调用 light_control / lightrules_*”。该提示不检查工具是否被 deny，也没有配置开关。结果是主会话提示词里仍可能出现灯效路由提示，但对应工具不可调用；模型可能回答“当前不能控制灯效”。这是本包无法通过配置消除的 vendor 行为，已作为残留报告；建议后续向上游提 feature flag，而不是手改 dist。
3. **云端灯效规则仍可能存在**：`lightrules_*` 工具被 deny 后无法查询/删除；服务器侧已存在的规则可能继续按触发条件亮灯。本包不删除任何云端规则（破坏性且无授权证据），需用户/上游另行处理。
4. **历史 ops 包仍编码灯效回退**：`ops/collector-skill-dispatcher`、`ops/collector-language-style`、`ops/dingtalk-private-notifications` 的 README/skill 快照/校验仍包含灯效回退文案。它们是已部署历史记录，本包按“保留历史审计”未改；但**重新部署这些旧包会覆盖本清理结果**。已作为 scope 外 finding 上报，后续应由各包 owner 更新或标注废弃。
5. **workshop skills 是 agent 自有文件**：`dingtalk-busy-reply`、`yoooclaw-plugin-status`、`openclaw-automations-jobs` 位于 `agents/main/agent/workshop-skills/`。本包部署时备份并直接替换指定段落；若之后 skill workshop 重新生成同名 skill，需要重新检查灯效段落。

## 9. 隐私与凭据

- 交付物只包含能力规则、路径与补丁文本；不包含真实消息正文、cid、messageId、手机号、staffId、通知内容或任何凭据。
- 备份在 `~/.openclaw/backups/` 本地，权限随原文件；`config.before.json` 只记录 `alsoAllow`/`deny` 子集，不复制整份 `openclaw.json`。
- 验证脚本不打印 target staffId；`dingtalk-notify --dry-run` 的输出只解析字段，不转发原文。

## 10. 包结构

```text
ops/light-effect-cleanup/
├── manifest.json              # 目标文件、基线 sha、精确补丁、cron/config 变更
├── README.md
├── scripts/
│   ├── lib.mjs                # CLI/JSON/补丁/原子写/备份helper
│   ├── plan.mjs               # 只读对照，deploy/status/rollback 共用
│   ├── deploy.mjs             # 计划/应用/失败自动回滚
│   ├── rollback.mjs           # 从最新备份恢复
│   ├── status.mjs             # 只读现状与残留
│   └── {deploy,rollback,status}.sh
└── verify/
    ├── check-package.mjs      # 离线结构/隐私/语法检查
    ├── deploy-sim.mjs         # 临时 root + fake CLI 端到端模拟
    └── fake-openclaw.mjs      # 模拟 cron/config/skills/plugins CLI
```
