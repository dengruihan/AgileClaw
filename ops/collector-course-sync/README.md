# Collector 确定性课表同步（M19）

状态：**代码与隔离验证就绪，未部署**。生活周期依赖 M18（Agenda source-owned sync）合并；
本包作者未修改 live cron、`~/.openclaw` 工作区、Gateway、Agenda 数据或任何消息；部署脚本会在
M18/M15 合并后更新 collector 的 `payload.message` 与 `trigger.script`（带备份和字段校验）。
部署必须等 M18/M15 合并后用 `scripts/deploy.sh --yes` 执行。

目标：用户要求“脚本自动获取课表并添加进系统，Agent 只负责读取课程和安排待办”。本包把云谷课表
从“模型看到 delta 后自行决定是否导入”改为 collector 抓取成功后**确定性同步**进 Agenda；不重新启用
已停用的 sentinel，不另建后台同步器，也不直接写 SQLite。

## 1. 改了什么

| 部署包内路径                                                          | 线上目标                                                                | 变更                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `files/.../collection/lib/course-weeks.mjs`                           | `~/.openclaw/workspace/collection/lib/course-weeks.mjs`                 | 新增：逐周成功/失败、实际覆盖、标签/占位分类、显式取消证据（纯函数）      |
| `files/.../collection/lib/agenda-sync.mjs`                            | `~/.openclaw/workspace/collection/lib/agenda-sync.mjs`                  | 新增：Agenda loopback sync 客户端（CSRF、512KiB、receipt、operationId）   |
| `files/.../collection/sources/yungu-schedule.mjs`                     | `~/.openclaw/workspace/collection/sources/yungu-schedule.mjs`           | 替换：两周分别校验；成功后自动 sync；失败周不覆盖；同步失败可重试         |
| `files/.../collection/collect.mjs`                                    | `~/.openclaw/workspace/collection/collect.mjs`                          | 仅一行：`await mod.collect()`，允许适配器异步调用 sync                    |
| `files/.../collection/README.md`                                      | `~/.openclaw/workspace/collection/README.md`                            | 更新覆盖语义、同步章节、错误口径                                          |
| `files/.../skills/collector-source-triage/SKILL.md`                   | `~/.openclaw/workspace/skills/collector-source-triage/SKILL.md`         | 课程不再由模型导入；失败周/未覆盖/unlisted 的分诊规则                     |
| `files/.../skills/yungu-schedule/SKILL.md`                            | `~/.openclaw/workspace/skills/yungu-schedule/SKILL.md`                  | 说明 collector 自动同步与“下周副本”判失败                                 |
| `files/.../agents/main/agent/workshop-skills/schedule-sweep/SKILL.md` | `~/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md` | 后台入口改为 collector、sentinel 停用不重启、课程证据取消、失败周不当空闲 |

不修改：`toolsAllow`、`schedule`、`enabled`、`sessionTarget`、`wakeMode`、`delivery`、sentinel 配置、
通知渠道、Agenda 源码/数据库。只更新 `payload.message` 与 `trigger.script`，部署前后都做字段校验。

## 2. 周判定与覆盖

`course-weeks.mjs` 对每个请求周独立判定：

- 槽位 `startTime` 必须落在请求周内；否则整周 `WEEK_DATE_MISMATCH`，不采用任何槽位。这直接拦住
  “请求下周、平台返回本周日期副本”的已知行为。
- 7 天槽位数组缺失/不是 7 天 → `INVALID_CONTENT`；时间缺失 → `INVALID_SLOT`；整周无槽位 →
  `EMPTY_WEEK`（未发布模板，不作为已覆盖）。
- `coverage` 只取最新的一段连续成功周；失败周写入 `coverage.weeks`，绝不并进覆盖。
- 一周成功、一周失败时 source 仍 `ok`，报告里保留成功周条目与失败原因；两周都失败才让 source 失败。
- 快照只包含成功周的条目，失败周的副本不会污染 diff。

## 3. 课程过滤（用户既有规则）

只有课程槽位进入 Agenda sync。以下保留在报告/快照供分诊，但不写入 Agenda：

- 作息/空闲标签：起床、出寝、整理、午餐/午休、晚餐、放学、熄灯就寝、晚自修、寄宿社区时间、
  个人时间、留白时光。
- 占位名称：`第N节`、含“待确认/待定/TBD”的名称。
- 平台错误的周末条目如果名字是上述标签，同样按标签过滤；真实周末课程保留。

## 3b. Agenda 完成反馈轮（M18 回退）

M18 的 replanner 在 sentinel 停用时唤起 `collector`，但 collector 只有在触发脚本/模型轮真正处理反馈后
才算完成闭环。本包补齐：

- `trigger-collector.mjs` 每次评估额外只读 `GET /agenda/api/snapshot?includeCompleted=true`，
  过滤 `!undoneBy && status in {pending,queued,running}` 的反馈；有则 `fire=true`，即使没有源 delta。
- 唤醒消息给出条数与 kind（complete_block/complete_task/undo），并明确要求：
  读 `~/.openclaw/extensions/agenda/skills/agenda/SKILL.md` 的 Desktop feedback 段与 `schedule-sweep`；
  `agenda read`（includeCompleted:true）取 revision/feedback；只调整受影响部分；在同一 `apply`
  提交 `feedbackResults`（adjusted/unchanged/error + 简短中文 summary）。
- 反馈轮不改课程、不改 source coverage、不发送消息、不新建自动化、不启用 sentinel，也不直接写 SQLite。
- Agenda 读取失败只累计 `state.agendaReadFails`，不单独唤醒（collector 自然轮会继续尝试）；
  模型未提交结果时 M18 的 finished 钩子仍会诚实记录“未收到调整结果”，不会假装重排成功。

## 4. Agenda sync 合约（M18 提供）

collector 使用 loopback HTTP，不直接打开数据库：

1. `GET http://127.0.0.1:18810/agenda/api/session` → `{csrfToken}`（无 cookie 绑定，不转发 Set-Cookie）。
2. `POST http://127.0.0.1:18810/agenda/api/sync`，headers：`Content-Type: application/json`、
   `Origin: http://127.0.0.1:18810`（与请求 URL 同 host；可用 `AGENDA_SYNC_ORIGIN` 覆盖但必须与
   `AGENDA_SYNC_URL` 的 host 一致）、`X-Agenda-CSRF: <token>`；body ≤512KiB。

Payload（严格字段）：

```json
{
  "operationId": "ys-sync-<内容hash>",
  "sourceId": "yungu-schedule",
  "label": "云谷课表",
  "window": { "start": "2026-11-02T00:00:00.000+08:00", "end": "2026-11-16T00:00:00.000+08:00" },
  "weeks": [
    {
      "start": "2026-11-02",
      "end": "2026-11-08",
      "ok": true,
      "message": null,
      "slots": [
        {
          "title": "数学",
          "start": "2026-11-02T08:10:00.000+08:00",
          "end": "2026-11-02T08:50:00.000+08:00",
          "sourceUrl": null
        }
      ]
    },
    {
      "start": "2026-11-09",
      "end": "2026-11-15",
      "ok": false,
      "message": "WEEK_DATE_MISMATCH: ...",
      "slots": []
    }
  ],
  "cancellations": []
}
```

- `operationId` 只由 `sourceId + window + weeks(slots) + cancellations` 的 SHA-256 决定。同 id +
  完全相同 body 幂等 replay；内容变化才换新 id（同 id 不同 body 会被 Agenda 以
  `operation_id_reused` 拒绝）。相同 no-op 仍会刷新 checkedAt、不 bump revision，`changed:false`
  是成功。
- `weeks[].ok=false` 只带 `message`，`slots` 为空；Agenda 据此把 source 标为 error 并指出周，
  且**不会删除已有课程**。
- `cancellations` 只在平台返回显式取消字段时非空，evidence `kind=platform`、非空 `detail`、
  `observedAt`；当前平台无可靠取消标记，通常为空。
- 回执写入 `report.json` 的 `sources.yungu-schedule.coverage.sync`。客户端只要求 `ok`，并记录
  `revision/created/updated/unchanged/adopted/cancelled/unlisted/failures/code/details`。
  业务拒绝是 HTTP409 + `ok:false/code`，schema/JSON 错误是 HTTP400；两者都转成可重试的
  `ok:false`，不抛异常。
- 同步失败不把抓取判失败：下一轮成功抓取自动重试；失败原因在 `coverage.sync.error/detail`，
  可用 `node collect.mjs status` 查看 `coverage.note`。

## 5. 验证

```bash
cd ops/collector-course-sync
node verify/check-package.mjs        # 静态契约（167 项）
node --test verify/course-sync.test.mjs  # 21 个隔离测试
node --test verify/trigger-feedback.test.mjs  # 7 个反馈唤醒测试
./verify/deploy-sim.sh               # 17 项临时树部署/回滚模拟（含假 openclaw CLI）
./scripts/deploy.sh                  # 只打印部署计划（dry run）
./scripts/status.sh                  # 只读：包 hash vs live + sync 接口健康
```

隔离测试覆盖：两周成功、下周返回本周日期、空周、非法槽位、同一 start 冲突、标签/占位过滤、显式取消 vs 缺席、
重复槽位、operationId 幂等、sync 失败不丢抓取、全失败不调用 sync、会话缺失/过期重登、
HTTP receipt/CSRF/no-cookie、业务拒绝 409、HTTP400、不可达/超时/超大 payload。
`trigger-feedback.test.mjs` 覆盖：只有 pending/queued/running 反馈唤醒、已处理/已撤销不唤醒、
反馈+源 delta 单次唤醒、读取失败不误唤醒、只读 snapshot 不调用写接口、原有故障/delta 行为不变。

## 6. 部署（M18 合并并部署后由 tower 执行）

```bash
cd ops/collector-course-sync
./scripts/deploy.sh                    # dry run：列出文件，不写入
./scripts/deploy.sh --yes              # 先备份到 ~/.openclaw/backups/collector-course-sync/<UTC>，再落盘并校验 hash
./scripts/status.sh                    # 期望全部 deployed，session: ok
```

部署脚本先探测 `GET /agenda/api/session` 与 `POST /agenda/api/sync`（空 body 只验证路由存在），任一未就绪就拒绝；只有“仅暂存文件”的场景才用 `--allow-missing-sync`。
`collect.mjs` 是共享运行时：live 既不是 `baselines/collect.pre-m19.mjs.txt` 也不是本包版本时，
脚本默认拒绝，确认差异后加 `--allow-drift`。部署会备份完整 job JSON、旧 message/trigger，
然后 `openclaw cron edit --trigger-script ... --message ...`；`toolsAllow`、schedule、enabled、
sessionTarget、wakeMode、delivery 逐项比对不变，失败会自动恢复旧 payload/trigger。

回滚：

```bash
./scripts/rollback.sh                  # dry run
./scripts/rollback.sh --yes            # 恢复备份；部署前不存在的文件会被删除
./scripts/status.sh
```

## 7. 部署后验证（等待 M18）

以下步骤尚未执行，必须等 M18 合并部署后，由 tower 在 live 上完成：

1. 备份后部署本包；`./scripts/status.sh` 全部 `deployed`，Agenda session 可读。
2. 只 force 运行相关源一次（不碰其他源、不发消息）：
   `node ~/.openclaw/workspace/collection/collect.mjs yungu-schedule --force --no-attach`。
   期望：本周成功；若平台仍把下周返回成本周副本，下周 `WEEK_DATE_MISMATCH`，coverage 止于本周日。
3. 读 `report.json` 确认 `coverage.weeks`、`coverage.sync.ok`、`created/updated/unlisted` 与实际情况一致；
   重复运行一次应 `changed=false`/revision 不涨。
4. 用 Agenda 工具/网页只读核对今天与本周区间：课程 event 与锁定块落在正确日期；
   无日期的旧课程不再新增；`unlisted` 不被取消；`coverage` 不把失败周算作已读。
5. 不发送任何消息、不 force run 其他源、不重新启用 sentinel。
6. 反馈闭环：部署后自然出现桌面完成反馈时，确认 collector 触发消息含“Agenda 完成反馈”，
   模型在同一 apply 提交 `feedbackResults`，Agenda 不再记录“未收到调整结果”。不伪造用户完成动作。
7. 如实报告任何来源歧义（例如平台仍未返回下周真实日期）；没有证据就不宣称已导入。

## 8. 未完成/等待依赖

- **M18 未合并/未部署**：sync 接口尚不存在；本包不能在 live 生效，也未导入任何真实课程。
- **M15 未合并**：本包的 `collector-source-triage/SKILL.md` 会替换 live 版本；部署顺序应在本包之前
  完成 M15，或由 tower 确认最终 skill 内容以本包为准。
- **replanner 的 sentinel 依赖**：M18 已部署回退——sentinel 禁用时唤起 collector。本包补上 collector
  反馈轮：trigger 只读 `/agenda/api/snapshot?includeCompleted=true`，有 pending/queued/running feedback
  就唤醒模型；模型按 agenda skill 的 Desktop feedback 段重排，并在同一 apply 提交 `feedbackResults`
  （adjusted/unchanged/error + 简短中文 summary）。不重新启用 sentinel；未提交结果时 M18 仍会诚实记为
  “未收到调整结果”。
- **live UI/区间读取**：任务要求的 today/week range read 与 UI 数据验证只能在 M18 部署后执行。
- **持续 sync 失败不会单独唤醒**：collector 每 6 小时自然重试；若 Agenda loopback 长期不可用，
  只有下一次有事项 delta 的轮次才会被 Agent 看到 `coverage.sync`。要单独告警需由 trigger/skill
  owner 增加判定，本包不改 trigger。
- **真实平台下周数据**：当前平台把下周返回成本周副本；本包会判该周失败并如实报告，不会伪造覆盖。
