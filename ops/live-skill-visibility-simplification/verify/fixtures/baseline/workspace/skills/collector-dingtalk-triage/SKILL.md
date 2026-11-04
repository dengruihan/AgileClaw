---
name: collector-dingtalk-triage
description: "collector 唤醒：钉钉会话变化时只读补查正文、未读与是否本人已回复，再决定提醒、登记或静默。仅供 collector 自动化使用。"
---

# 钉钉会话分诊

只处理唤醒原因里点明的钉钉会话变化（kind=conversation，带 cid/name/lastMsgAt）。收集层只给会话列表变化，正文要本轮现查——这是常规步骤，不是能力边界。lastMsgAt 变化只说明有动静，不能据此直接提醒。必须先用 dws 只读补查会话详情和未读状态，再判断。

1. 取本人 userId 和对应 senderId（每轮一次）：`dws contact +me --format json`，读 `.data.userId`；再用 `dws contact user search --query "<本人 userId>" --format json`，在 `.result[]` 里按 userId 精确匹配，取 `openDingTalkId` 作为本人 senderId。身份只按 userId/openDingTalkId(senderId) 判断，不比较展示名。`+me` 不可用时回退 `dws contact user current --format json`，读 `.result[0].orgEmployeeModel.userId`。映射取不到时，对任一变会话执行下面第 3 步的 `--sender` 调用，读 `.resolvedFilters.senders[]` 里的 `selected.openDingTalkId`；群聊按 sender 过滤可能返回空消息，但该映射仍会给出，不能用返回条数判断本人是否发过言。
2. 读该会话最近消息：`dws chat +chat-messages --group "<cid>" --limit 15 --format json`。cid 原样加双引号（可能含 / 和 =）。`messages[]` 按新→旧排列，字段 sender/senderId/text/createTime/messageId；有 quotedMessage/reactions 时一并参考。
3. 判断最新动态是否来自本人：若第 2 步 `messages[0].senderId` 等于第 1 步的本人 senderId，说明最后一条是本人发的（已回复或本人动态）→ 不提醒、不登记、不排程，跳过该会话；不相等或本人从没在该会话发言，继续第 4 步。映射缺失时的兜底调用：`dws chat +chat-messages --group "<cid>" --sender "<本人 userId>" --limit 1 --format json`。
4. 未回复时确认未读状态（每轮一次）：`dws chat +chat-list --types group,p2p --page-size 100 --sort active_time --format json`，按 cid 找该会话的 `unreadPoint`（>0 未读，0 已读）；找不到该 cid 时用 `dws chat +unread-chats --count 100 --format json` 交叉判断（列出即未读，未列出即已读）。已读不等于不用管，仍按内容判断。
5. 未回复时结合正文、是否 @ 我（正文出现本人姓名或被 @ 的迹象）、是否提问、是否含截止时间或明确请求、未读状态，判断是否需要提醒：需要行动 → 读 `/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`，按它的规则登记/排程（agenda 字段、查重、去重、优先级只在那里），再按第 6 步发提醒；不需要 → 静默结束，不通知、不登记。
6. 提醒可以准确概括钉钉消息（谁、什么时候、说了什么要点），不要再写「只能看到会话动态」或让用户自己去钉钉看正文。只提炼要点，不复述大段原文，不展开隐私细节。发送前读 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md`。
7. 补查失败（dws 报错、超时或解析失败）：同一会话重试一次；仍失败则本轮跳过该会话，不发「收集层无正文」这类提醒，也不猜内容。认证失效（DWS_AUTH，或错误含 auth/token/401/403）→ 读 `/home/raymond/.openclaw/workspace/skills/collector-health-repair/SKILL.md`，按故障流程提示用户 `dws auth login`，不代登。
8. 一轮内钉钉变化较多时，按 lastMsgAt 从新到旧最多补查 10 个。本轮超出上限的会话完全跳过：不提醒、不登记、不排程，也不能只凭未读状态行动——未读只是补查后的判断输入，不是提醒依据；宁可本轮漏报，也不做无正文误报。
