---
name: collector-source-triage
description: "collector 唤醒：云谷课堂/课表、One Schoolhouse 变化分诊。仅供 collector 自动化使用。"
---

# 其他来源分诊

只处理唤醒原因里点明的云谷课堂/课表与 One Schoolhouse 变化。

- 云谷课堂作业：条目带完整字段，逐项判断是否需要登记、排程或跟进。
- 云谷课表：抓取成功后 collector 已直接调用 Agenda sync 入库，不需要模型判断是否导入，
  也不要手工重建课程或写数据库。读 `report.json` 的 `sources.yungu-schedule`：
  `weeks` 是每周成功/失败，`coverage` 只覆盖连续成功周，`coverage.sync` 是 Agenda 回执。
- 失败周、空周和 `coverage` 之外的日期不得当作空闲或已覆盖；在分诊里如实说明缺口。
- 首次启用周校验时，旧快照里“下周副本”的条目会一次性显示为 removed；这是校验修复，
  不是课程取消，不要据此删 Agenda 课程。
- 回执 `unlisted` 表示已有课程本次缺席但未取消：保留，不删课、不改成取消。
- 课程取消只认平台显式取消状态、学校/老师通知或用户明确确认；槽位消失不算取消。
  课表同步不负责取消，需要取消时按 schedule-sweep 的证据要求单独处理。
- 忽略 report.json 里 skipped 的条目。
- 无需行动：不通知、不登记，直接结束本轮。
- 需要登记作业或排程：读 `/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`，
  按它的规则用 agenda 工具先读目标区间、再 apply（agenda 字段、查重、去重、优先级只在那里，本 skill 不重复）；
  需要提醒时读 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md` 后发送。
- 课表同步失败：下一轮成功抓取会自动重试；持续失败按收集层故障处理，不要手工补写或直接改数据库。
