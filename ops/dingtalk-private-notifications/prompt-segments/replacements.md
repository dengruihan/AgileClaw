# 提示词/措辞替换段（通知出口切换）

通知发送命令（全篇统一）：

```
node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>
```

- 标题 ≤20 字（会话列表预览），正文 Markdown，单条 ≤1900 字符由脚本自动分块。
- 脚本只发送、不判重：每源每日一次、便单/日程查重等既有去重与分诊判断不变。
- 发送失败（退出码 1，stderr 含进度与回退提示）时退回灯效推送：
  `node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <标题> --reason <30字内原因>`。
- 依赖顺序：R1–R3 作用于 M1（ops/collector-phase2）部署后的线上文件，须先完成 M1 部署；
  R4（workspace AGENTS.md）与包装脚本落盘相互独立，任何顺序均可。

## R1. collector 自动化 payload.message（M1 部署包 `ops/collector-phase2/payload-message.txt` 对应线上任务内嵌副本）

### R1a 事项变化分支

Before:

```
- 需要行动：按 schedule-sweep skill 的既有规则登记/排程；需要提醒时走当前既有通知渠道（现为灯效推送）发简短通知；登记或排程前先查重，已有同条目便单/日程只更新、不重复创建。
```

After:

```
- 需要行动：按 schedule-sweep skill 的既有规则登记/排程；需要提醒时发简短通知：node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>（私人钉钉机器人 Markdown 单聊，非 AI 卡片）；发送失败退回灯效推送（workspace AGENTS.md「手机推送提醒」命令）；登记或排程前先查重，已有同条目便单/日程只更新、不重复创建。
```

### R1b 收集故障分支

Before:

```
修复后重跑验证 streak 归零；按既有渠道推送一条简短通知（每源每日一次）。不动 agenda 数据、不做排程、不动其他自动化；无法修复时写明阻塞点并保持现状。
```

After:

```
修复后重跑验证 streak 归零；用同一 dingtalk-notify 命令推送一条简短通知（每源每日一次；失败退回灯效推送）。不动 agenda 数据、不做排程、不动其他自动化；无法修复时写明阻塞点并保持现状。
```

写入方式（与 M1 相同，任务内嵌副本需同步）：

```bash
openclaw cron edit 6a45be21-ce0b-4b8b-8986-4c885d1ea659 --message "$(cat payload-message.txt)"
```

## R2. 触发脚本 message 措辞（M1 部署包 `trigger-collector.mjs` 对应线上 `collection/trigger-collector.mjs` + `openclaw cron edit --trigger-script` 内嵌副本）

### R2a collectFails 分支

Before:

```
按既有渠道推送一条灯效通知（每源每日一次）。
```

After:

```
按既有渠道推送一条通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>；失败退回灯效，每源每日一次）。
```

### R2b 源故障分支

Before:

```
按既有灯效渠道推送一条简短通知（title=故障源，reason=修复结果，每源每日一次）。
```

After:

```
按既有渠道推送一条简短通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title=故障源 --text=修复结果；失败退回灯效，每源每日一次）。
```

## R3. collection README（线上 `/home/raymond/.openclaw/workspace/collection/README.md`「自动化 collector」节，M1 部署版）

Before:

```
   既有规则登记/排程/通知（先查重）；无需行动则静默结束。
```

After:

```
   既有规则登记/排程/通知（先查重；通知走 collection/dingtalk-notify.mjs 钉钉
   Markdown 单聊，失败退回灯效推送）；无需行动则静默结束。
```

## R4. workspace AGENTS.md（`/home/raymond/.openclaw/workspace/AGENTS.md`「手机推送提醒」节，493 行一带）

Before（原块整体保留，仅在其前插入新块）：

```
**手机推送提醒：** 提醒用户走带屏硬件的灯效推送（用户 App 里叫「重点关注」）：`node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <简短标题> --reason <30字内原因>`；title/reason 纯文本无 emoji。YoooClaw App 未接入聊天渠道，无法主动发聊天消息。
```

After（新增块 + 原块）：

```
**钉钉通知（collector 提醒/告警首选）：** `node ~/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>` — 私人钉钉机器人普通 Markdown 单聊（非 AI 卡片），长文自动分块；只发送不判重。发送失败再退回下方灯效推送。

**手机推送提醒：** 提醒用户走带屏硬件的灯效推送（用户 App 里叫「重点关注」）：`node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <简短标题> --reason <30字内原因>`；title/reason 纯文本无 emoji。YoooClaw App 未接入聊天渠道，无法主动发聊天消息。
```
