---
name: collector-source-triage
description: "collector 唤醒：云谷课堂/课表、One Schoolhouse 变化分诊。仅供 collector 自动化使用。"
---

# 其他来源分诊

只处理唤醒原因里点明的云谷课堂/课表与 One Schoolhouse 变化。逐项判断是否值得行动（需要提醒、排程、登记便单或跟进）。

- 云谷课堂/课表与 One Schoolhouse：事项带完整条目，可直接阅读。
- 忽略 report.json 里 skipped 的条目。
- 无需行动：不通知、不登记，直接结束本轮。
- 需要行动：读 `/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`，按它的规则登记/排程（agenda 字段、查重、去重、优先级只在那里，本 skill 不重复）；需要提醒时读 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md` 后发送。
