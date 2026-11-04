# 提示词/措辞替换说明（通知出口切换）

通知发送命令（全篇统一）：

```
node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>
```

- 标题 ≤20 字（会话列表预览），正文 Markdown，单条 ≤1900 字符由脚本按 code point 自动分块。
- 脚本只发送、不判重：每源每日一次、便单/日程查重等既有去重与分诊判断不变。
- 发送失败（退出码 1，stderr 含进度与回退提示）时退回灯效推送：
  `node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <标题> --reason <30字内原因>`。

## 部署形态（r1 修复后）

本目录不再要求在部署时手工拼接替换段。**完整的 post-M2 文件已随包提供**：

| 文件                                                                      | 基准                              | 变更                            |
| ------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| `files/home/raymond/.openclaw/workspace/collection/payload-message.txt`   | M1 tip `7a53295ef` 同名文件逐字节 | 仅 R1a/R1b 两处通知措辞（见下） |
| `files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs` | M1 tip `7a53295ef` 同名文件逐字节 | 仅 R2a/R2b 两处通知措辞（见下） |

部署直接用这两个完整文件（README 步骤 3/4），不需要从 M1 包里取文件、也不重写任何未修改副本。
diff 复核命令：

```bash
diff ops/collector-phase2/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs \
     ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs
# 应只有 64、72 两行（通知措辞）不同
```

另有一处不落盘文件的行内措辞更新（R3，对线上 collection README 的一次性安全替换，命令见 README 步骤 5）。

## R1. payload.message 措辞变化（相对 M1 部署版）

### R1a 事项变化分支

Before:

```
- 需要行动：按 schedule-sweep skill 的既有规则登记/排程；需要提醒时走当前既有通知渠道（现为灯效推送）发简短通知；登记或排程前先查重，已有同条目便单/日程只更新、不重复创建。
```

After（已在 post-M2 payload-message.txt 中）:

```
- 需要行动：按 schedule-sweep skill 的既有规则登记/排程；需要提醒时发简短通知：node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>（私人钉钉机器人 Markdown 单聊，非 AI 卡片；只发本人，失败会退出码 1 并打印灯效回退命令：node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <标题> --reason <30字内原因>）；登记或排程前先查重，已有同条目便单/日程只更新、不重复创建。
```

### R1b 收集故障分支

Before:

```
修复后重跑验证 streak 归零；按既有渠道推送一条简短通知（每源每日一次）。
```

After（已在 post-M2 payload-message.txt 中）:

```
修复后重跑验证 streak 归零；用同一 dingtalk-notify 命令推送一条简短通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <修复结果>；失败退回灯效推送，每源每日一次）。
```

## R2. trigger 脚本 message 措辞变化（相对 M1 部署版，已在 post-M2 trigger-collector.mjs 中）

### R2a collectFails 分支

Before: `按既有渠道推送一条灯效通知（每源每日一次）。`
After: `按既有渠道推送一条通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>；失败退回灯效，每源每日一次）。`

### R2b 源故障分支

Before: `按既有灯效渠道推送一条简短通知（title=故障源，reason=修复结果，每源每日一次）。`
After: `按既有渠道推送一条简短通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title=故障源 --text=修复结果；失败退回灯效，每源每日一次）。`

## R3. collection README（线上 `/home/raymond/.openclaw/workspace/collection/README.md`「自动化 collector」节，一次性安全替换）

Before:

```
   既有规则登记/排程/通知（先查重）；无需行动则静默结束。
```

After:

```
   既有规则登记/排程/通知（先查重；通知走 collection/dingtalk-notify.mjs 钉钉
   Markdown 单聊，失败退回灯效推送）；无需行动则静默结束。
```

替换命令（Before 串必须存在且唯一，否则报错退出、不写文件）见 README 步骤 5。

## 明确不做

- **不修改 workspace AGENTS.md**：本次授权仅限 collector 通知出口；核心 workspace 指令
  形成第二处通知策略 owner，超出授权。灯效回退命令已在 R1a/R2a 措辞内联，Agent 无需
  依赖 AGENTS.md 条目即可完成回退。
