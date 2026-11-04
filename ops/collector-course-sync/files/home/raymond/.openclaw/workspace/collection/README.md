# collection — 统一事项来源收集层

六个数据源的统一收集 owner：定时抓取 → 归一化 → 课表同步（Agenda 拥有写入）→ 带完整内容的增量报告 → 健康状态。
本层只做确定性工作：不做分诊、不直接写 Agenda 数据库、不发通知；分诊与通知发生在 `collector` 自动化的 Agent 轮（见下）。

## 用法

```bash
node collect.mjs all            # 全部源（受每源间隔门；自动化触发脚本用这个）
node collect.mjs yungu-tasks osh  # 指定源
node collect.mjs status         # 打印健康状态
# 选项: --force 忽略间隔门; --no-attach 跳过附件归档
```

每次运行每源输出一行 JSON 摘要（供自动化触发脚本解析）：

```json
{"source":"yungu-tasks","label":"云谷课堂","ok":true,"streak":0,"changed":"+1 ~0 -0"}
{"source":"osh","label":"One Schoolhouse","ok":false,"streak":2,"error":"RELOGIN_FAILED"}
```

## 产物

| 文件                       | 内容                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.json`              | 最新报告：每源 `{source,label,at,durationMs,ok,error?,detail?,coverage,items?,counts?,countsDelta?,delta,attach?}`；`delta.added/changed` 带**完整条目**，`removed` 带 key+标题 |
| `state/snapshot-<源>.json` | 上一轮成功快照（diff 基线；失败不覆盖）                                                                                                                                         |
| `state/health.json`        | 每源 `{lastOkAt,lastAttemptAt,lastError,streak,coverage}`                                                                                                                       |
| `state/attachments.json`   | 云谷附件归档索引 `{taskPublishId:{files:{文件名:{path,bytes,valid,deduped?}},checkedAt}}`                                                                                       |
| `state/history/`           | 每日一份报告快照，保留 7 天                                                                                                                                                     |

## 源与覆盖语义（消费方不得把未覆盖区间当空闲）

| 源             | 内容                                                            | 覆盖                                                   | 登录自愈                                                            |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| yungu-tasks    | 作业全字段（标题/课程/截止/状态/耗时）                          | 列表接口快照，单页上限 50                              | SESSION_EXPIRED 或会话文件缺失 → 密钥库凭据重登一次                 |
| yungu-schedule | 本周+下周课表原始槽位（逐周判定成功/失败；标签/占位保留供分诊） | 只覆盖最新连续成功周；失败/空周/日期不属于请求周不计入 | 同上（共用 ~/.yungu 会话）                                          |
| osh            | Canvas 作业（真实 UTC dueAt、submitted）                        | upcoming+past_due 两桶                                 | 同 yungu 模式（OSH_ACCOUNT/OSH_PASSWORD）                           |
| dingtalk       | 会话列表变化（cid/name/lastMsgAt），无消息正文                  | 群/单聊活跃前排各一页                                  | 无（dws 自刷 token；auth 失败报 DWS_AUTH，`dws auth login` 归用户） |
| mail           | 两邮箱收件箱净计数（counts/countsDelta）                        | 仅计数；邮件内容不进 workspace                         | 无需                                                                |

错误口径：`RELOGIN_FAILED`（重登仍失败/缺凭据）、`DWS_AUTH`、`MAIL_SYNC_FAILED`、`PARSE_FAILED`、`ADAPTER_CRASH`。
课表周级失败：`WEEK_DATE_MISMATCH`（槽位日期不属于请求周，通常为平台把下周返回成本周副本）、`EMPTY_WEEK`（未发布模板）、`INVALID_SLOT`、`INVALID_CONTENT`、`DUPLICATE_OCCURRENCE`（同一 start 两门课程）。只要还有一周成功，源仍算 ok，失败周写入 `coverage.weeks` 并从覆盖中排除；两周都失败才让源失败。
失败保留旧快照不动（不清空、不当空列表），streak 累计，成功归零。

## 课表确定性同步（Agenda）

`yungu-schedule` 抓取成功后，collector 直接调用 Agenda 插件的 loopback sync 接口
（`GET /agenda/api/session` 取 CSRF，`POST /agenda/api/sync`；SQLite 写入仍由 Agenda 完成），
不经过模型判断是否导入，也不直接写数据库。这条 Agenda sync 是 collector 内的确定性步骤，
不是第二个后台同步器。

- 每周单独判定：槽位日期不在请求周、整周为空、非法槽位 → 该周失败，不计入 coverage。
  `coverage.weeks` 记录每周 `ok/reason/counts`；`coverage` 只取最新连续成功周。
- 只同步课程槽位；起床/出寝/整理/午餐/晚餐/放学/熄灯/晚自修/寄宿社区时间/个人时间/留白时光
  等作息标签和「第N节/待确认」占位保留在报告里，但不作为课程写入。
- 缺席 = `unlisted`，不删除、不取消；只有平台显式取消字段（`status: cancelled` 等）才进入
  `cancellations` 并带 evidence。当前平台没有可靠取消标记，因此通常为空。
- 回执写在 `coverage.sync`（`ok/revision/created/updated/unchanged/unlisted/failures…`）。
  同步失败不影响抓取结果：下一轮成功抓取自动重试；操作 id 由窗口+槽位内容决定，未知结果
  重试时复用，Agenda 按 operationId 幂等回放。
- 覆盖与回执是消费方判断“哪些天真的读到、哪些没同步”的唯一依据；未覆盖日不得当空闲。
- 首次启用周校验时，旧快照里的“下周副本”条目会一次性显示为 removed；这是校验修复，
  不是课程取消，不要据此删除 Agenda 课程。

## 附件归档

yungu-tasks 每轮成功抓取后，对索引缺记录的任务自动下载附件到
`~/Documents/学术/高三/高三上/<课程目录>/`（config.attach.courseDirs 维护平台课程名→目录名映射），
同名+同大小去重，每轮上限 `maxTasksPerRun`。旧 `scripts/yungu-att-index.json` 已一次性迁移
（原地改名 `.legacy.json` 留档）。失败不落索引，下轮自动重试。`valid=false` 仅表示魔数非 zip/pdf
（如 .ipynb），不是故障。

## 自动化 `collector`（看门狗 + 事项分诊）

cron job `collector` 每 10 分钟评估，触发脚本 `trigger-collector.mjs` 跑一次 `collect.mjs all`
（1 次 exec 预算）。四种情况唤醒同一自动化内的模型轮：

1. **事项 delta**：任务类源（云谷课堂/课表、OSH、钉钉）`+A ~C -R` 非全零，或邮件源净新增 > 0
   （净减少视为已处理，不唤醒）。云谷课表在 collect 层已自动同步进 Agenda，Agent 不再判断
   “是否导入课程”，只处理作业/邮件/钉钉等需要行动的事项。唤醒后 Agent 读 `report.json` 分诊：
   值得行动按 `schedule-sweep` 既有规则登记/排程/通知（先查重；通知走 collection/dingtalk-notify.mjs 钉钉
   Markdown 单聊；发送失败如实记录，不换通道重发）；无需行动则静默结束。delta 由快照 diff 产生，每轮成功抓取
   只出现一次，无需额外去重。课表同步回执见 `sources.yungu-schedule.coverage.sync`。
2. **源连续故障**：streak≥2（每源每日最多唤醒一次）。
3. **收集器自身异常**：collect.mjs 连续 2 次输出异常（行数不对/不可解析/无法执行）。
4. **Agenda 完成反馈**：触发脚本只读 `/agenda/api/snapshot?includeCompleted=true`，存在
   `pending/queued/running` 且未撤销的 feedback 时唤醒。M18 replanner 在 sentinel 停用时唤起
   collector；本轮必须读 feedback、重排，并在同一 apply 提交 `feedbackResults`，否则 finished 钩子
   会记为“未收到调整结果”。

2、3 唤醒轮只修障 + 通知，不动 agenda、不做排程；4 只处理反馈，不改课程、不发消息、不启用 sentinel。
skipped（间隔门跳过）的源不当 delta、不当故障。
**修改触发脚本或 payload 后必须 `openclaw cron edit collector --trigger-script/--message ...` 同步进任务**（任务内嵌的是创建时的副本）。

## 排障

- 看健康：`node collect.mjs status`，或读 `state/health.json` 的 `lastError`。
- 单源复跑：`node collect.mjs <源> --force`（加 `--no-attach` 排除归档干扰）。
- 会话文件：云谷 `~/.yungu/state.json`、OSH `~/.oneschoolhouse/state.json`（缺失会自动重登重建）。
- 附件目录缺失会按映射表建目录；新课程名先加进 `config.mjs` 的 courseDirs 再重跑。
- diff 行为锁：`node --test lib/diff.test.mjs`。
