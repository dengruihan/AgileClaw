# collection — 统一事项来源收集层

六个数据源的统一收集 owner：定时抓取 → 归一化 → 带完整内容的增量报告 → 健康状态。
本层只做确定性工作，不做分诊、不写 agenda、不发通知；分诊与通知发生在 `collector` 自动化的 Agent 轮（见下）。

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

| 源             | 内容                                                                 | 覆盖                                 | 登录自愈                                                            |
| -------------- | -------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| yungu-tasks    | 作业全字段（标题/课程/截止/状态/耗时）                               | 列表接口快照，单页上限 50            | SESSION_EXPIRED 或会话文件缺失 → 密钥库凭据重登一次                 |
| yungu-schedule | 本周+下周课表原始槽位（含平台错误条目；假晚自修/占位过滤归消费规则） | 本周一 00:00 ～ 下周日 24:00（北京） | 同上（共用 ~/.yungu 会话）                                          |
| osh            | Canvas 作业（真实 UTC dueAt、submitted）                             | upcoming+past_due 两桶               | 同 yungu 模式（OSH_ACCOUNT/OSH_PASSWORD）                           |
| dingtalk       | 会话列表变化（cid/name/lastMsgAt），无消息正文                       | 群/单聊活跃前排各一页                | 无（dws 自刷 token；auth 失败报 DWS_AUTH，`dws auth login` 归用户） |
| mail           | 两邮箱收件箱净计数（counts/countsDelta）                             | 仅计数；邮件内容不进 workspace       | 无需                                                                |

错误口径：`RELOGIN_FAILED`（重登仍失败/缺凭据）、`DWS_AUTH`、`MAIL_SYNC_FAILED`、`PARSE_FAILED`、`ADAPTER_CRASH`。
失败保留旧快照不动（不清空、不当空列表），streak 累计，成功归零。

## 附件归档

yungu-tasks 每轮成功抓取后，对索引缺记录的任务自动下载附件到
`~/Documents/学术/高三/高三上/<课程目录>/`（config.attach.courseDirs 维护平台课程名→目录名映射），
同名+同大小去重，每轮上限 `maxTasksPerRun`。旧 `scripts/yungu-att-index.json` 已一次性迁移
（原地改名 `.legacy.json` 留档）。失败不落索引，下轮自动重试。`valid=false` 仅表示魔数非 zip/pdf
（如 .ipynb），不是故障。

## 自动化 `collector`（看门狗 + 事项分诊）

cron job `collector` 每 10 分钟评估，触发脚本 `trigger-collector.mjs` 跑一次 `collect.mjs all`
（1 次 exec 预算）。三种情况唤醒同一自动化内的模型轮：

1. **事项 delta**：任务类源（云谷课堂/课表、OSH、钉钉）`+A ~C -R` 非全零，或邮件源净新增 > 0
   （净减少视为已处理，不唤醒）。唤醒后 Agent 读 `report.json` 分诊：值得行动按 `schedule-sweep`
   既有规则登记/排程/通知（先查重）；无需行动则静默结束。delta 由快照 diff 产生，每轮成功抓取
   只出现一次，无需额外去重。
2. **源连续故障**：streak≥2（每源每日最多唤醒一次）。
3. **收集器自身异常**：collect.mjs 连续 2 次输出异常（行数不对/不可解析/无法执行）。

2、3 唤醒轮只修障 + 通知，不动 agenda、不做排程。skipped（间隔门跳过）的源不当 delta、不当故障。
**修改触发脚本或 payload 后必须 `openclaw cron edit collector --trigger-script/--message ...` 同步进任务**（任务内嵌的是创建时的副本）。

## 排障

- 看健康：`node collect.mjs status`，或读 `state/health.json` 的 `lastError`。
- 单源复跑：`node collect.mjs <源> --force`（加 `--no-attach` 排除归档干扰）。
- 会话文件：云谷 `~/.yungu/state.json`、OSH `~/.oneschoolhouse/state.json`（缺失会自动重登重建）。
- 附件目录缺失会按映射表建目录；新课程名先加进 `config.mjs` 的 courseDirs 再重跑。
- diff 行为锁：`node --test lib/diff.test.mjs`。
