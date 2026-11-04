# collector 自动化阶段二（事项分诊）部署包

目标：线上 OpenClaw 自动化 `collector`（id `6a45be21-ce0b-4b8b-8986-4c885d1ea659`，每 10 分钟评估）
从「纯故障看门狗」改为「看门狗 + 事项 delta 分诊」：任一来源存在 added/changed/removed 事项变化时
唤醒同一自动化内的 Agent 分诊（需要行动则沿用 schedule-sweep 既有规则，无需行动静默结束）；
无变化且无故障不唤醒；连续源故障与收集器异常修障路径保持不变。不新建/删除 cron，不动旧 sentinel。

## 文件映射（files/ 下保留目标绝对路径，供对照线上原文件审查）

| 部署包内路径                                                              | 线上目标路径                                                         | 变更                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs` | `/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs` | 触发脚本新增事项 delta 唤醒分支（邮件仅净新增 > 0），故障分支逐字节保留 |
| `files/home/raymond/.openclaw/workspace/collection/README.md`             | `/home/raymond/.openclaw/workspace/collection/README.md`             | 「自动化 collector」章节从纯看门狗改为看门狗+分诊；首行分诊归属说明     |

另有两个任务级变更（不落盘文件）：

- **payload.message**（Agent 提示词）：`payload-message.txt`，经 `openclaw cron edit --message` 写入任务内嵌副本。
- **description**：`来源收集与故障看门狗：每10分钟跑 collection/collect.mjs，仅源连续故障≥2次时唤醒修障；delta 分诊归后续阶段`
  → `来源收集看门狗+事项分诊：每10分钟跑 collection/collect.mjs；有事项delta唤醒Agent分诊（无需行动静默结束）；源连续故障>=2或收集器连续异常唤醒修障`。

## 部署步骤（审查通过后由 tower 执行）

```bash
# 0. 线上备份（trigger-collector.mjs.bak.20261102 已于制备阶段创建，如缺失则补：
#    cp /home/raymond/.openclaw/workspace/collection/trigger-collector.mjs{,.bak.20261102}）

# 1. 落盘触发脚本与 README
cp ops/collector-phase2/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs \
   /home/raymond/.openclaw/workspace/collection/trigger-collector.mjs
cp ops/collector-phase2/files/home/raymond/.openclaw/workspace/collection/README.md \
   /home/raymond/.openclaw/workspace/collection/README.md

# 2. 同步任务内嵌副本（payload.message、trigger.script、description、toolsAllow）
#    toolsAllow：保留既有 8 项 + 新增 agenda（审查 r1 P1：提示词要求 schedule-sweep 登记/排程，
#    线上 agenda skill 规定 agenda 工具是唯一计划编辑入口，缺它则"需要行动"路径不可执行）
openclaw cron edit 6a45be21-ce0b-4b8b-8986-4c885d1ea659 \
  --trigger-script ops/collector-phase2/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs \
  --message "$(cat ops/collector-phase2/payload-message.txt)" \
  --description '来源收集看门狗+事项分诊：每10分钟跑 collection/collect.mjs；有事项delta唤醒Agent分诊（无需行动静默结束）；源连续故障>=2或收集器连续异常唤醒修障' \
  --tools 'ls read edit write apply_patch exec process light_control agenda'

# 3. 核验（保留 enabled、every 10m、timeoutSeconds=600、lightContext）
openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659
# 期望：enabled=true；schedule.kind=every/everyMs=600000；payload.timeoutSeconds=600；
# payload.message 与 payload-message.txt 一致；trigger.script 与落盘 trigger-collector.mjs 一致；
# payload.toolsAllow = [ls, read, edit, write, apply_patch, exec, process, light_control, agenda]
# （既有 8 项不变，新增 agenda；无其他增删）。

# 4. 自然周期核验（不 force run）：等下一个 10 分钟评估点，确认 triggerEvalCount 递增、
#    triggerState.collectFails/alerted 正常，无事项变化时无唤醒（openclaw cron runs 查看）。
#    有真实 delta 的一轮观察 Agent 是否正确分诊（静默或按 schedule-sweep 处理）。
```

## 已验证（fixture 干跑，不触碰真实来源）

`node ops/collector-phase2/verify/harness.mjs` —— 14 项全过：

- 无变化 / 邮件净减 / 邮件首跑基线 / skipped 源 → 不唤醒
- yungu-tasks +1、changed+removed 非零、钉钉会话列表变化、邮件净增 → 唤醒且 message 归为「事项变化」
- 源故障 streak≥2 → 唤醒且归为「收集层故障」，同日同源复评去重不唤醒
- delta 与故障同轮 → 单次唤醒、双原因合并
- 输出行数不对 → 累计 collectFails；连续 2 次 → 唤醒

`node ops/collector-phase2/verify/agent-boundary.mjs` —— 28 项全过（审查 r2 按真实合同重写，不再是自实现 mock）：

**真实运行时组件（直接导入执行，非复刻）**：agenda 工具与严格 zod schema（线上扩展 `src/tool.ts` 的 `createAgendaTool`，含 `{action,query?,change?}`、apply 的 operationId/expectedRevision、main-agent 归属门控）；真实 agenda store（同扩展 `src/store.ts` 的 `openAgendaStore`，临时 SQLite，真实 revision / operationId 幂等 / revision_conflict 语义）；cron toolsAllow 门控（产品仓库 `src/agents/tool-policy-match.ts` 的 `createToolPolicyMatcher`）。fixture 条目形状取自线上真实来源输出（OSH `dueAt/submitted`、云谷 `deadlineMs/status:'To edit'`、钉钉 `cid/name/lastMsgAt` 无正文、邮件仅计数）。

- 无需行动（OSH 已提交 + 云谷远期 + 钉钉会话变化 + 邮件净增计数）：静默；真实 store revision 保持 0、零 apply 回执、零通知、零文件写入、零对外消息
- 需要行动（OSH 24h 内未提交 + 云谷 48h 内）：真实字段判定生效（修复 r2 指出的 `dueAt` 误读问题）→ agenda read 查重严格先于 apply（真实调用序）→ 两条合法 apply 回执 ok → 真实 store 按 sourceId/sourceKey 可查 → 至多一条通知、零对外消息、零文件写入
- 重复条目不重建：预置同 sourceKey 条目后，查重命中 → 静默，真实 store revision 不变、条目唯一、本轮零 apply
- 缺 agenda 的真实拒绝：旧 8 项 toolsAllow 下真实 matcher(agenda)=false（r1 P1 门控形态），登记被拒且零回执无部分写入；追加 agenda 后 matcher=true（修复生效）；非 main agentId 被真实工具以 "owned by the main personal assistant" 拒绝（线上 collector 以 main 运行，不阻塞）
- 真实 schema 严格性：缺 operationId/expectedRevision、read 携带 change 均被真实工具拒绝（mock 不再宽松）

**剩余行为验证缺口（如实声明）**：模型的判定与工具选择本身不在此执行——在不写入用户数据的前提下无法运行真实 isolated Agent（`openclaw agent` 不提供按轮工具限制，真实 apply 会污染用户 agenda）。部署后须自然周期观察一轮真实 delta 分诊（不 force run、不发对外测试消息）。

另有：`node --test lib/diff.test.mjs`（线上 collection 目录既有 diff 行为锁）通过；
`ops/collector-phase2/verify/l4-check.sh`（AGENTS.md L4 反模式自检）通过。

## 需部署后验证

- 任务内嵌副本与落盘文件一致性（`openclaw cron get` 比对），含 payload.toolsAllow 含 agenda 且无其他增删
- 自然周期：无变化轮不唤醒；真实 delta 轮分诊行为（观察一轮无需行动静默、一轮需要行动按 schedule-sweep 登记）；故障轮灯效通知仍正常
- 通知渠道现状说明：当前提醒/通知走灯效推送（`phone-notifications` 扩展）。
  用户已表达切换到钉钉机器人通知的意向（未授权测试发送、未授权清理灯效工具）。
  切换时需调整的位置：① 本 payload-message 与 trigger 脚本 message 里「既有渠道/灯效」措辞；
  ② schedule-sweep skill 的提醒落点；③ AGENTS.md「工具」节的推送命令。collector 本身不持有通知实现。
