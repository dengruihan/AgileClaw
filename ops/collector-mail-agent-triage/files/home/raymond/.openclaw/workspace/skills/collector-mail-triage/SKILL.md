---
name: collector-mail-triage
description: "collector 唤醒：邮件计数变化时用本地 notmuch 只读补查本轮新邮件，读发件人/主题/必要正文后决定静默、登记或提醒。仅供 collector 自动化使用。"
---

# 邮件分诊（本地 notmuch 只读补查）

收集层只同步并给出收件箱净计数（yungu、qq），发件人/主题/正文都不进 report.json 或收集快照。本轮被唤醒后自己用现有本地 notmuch 索引只读补查——这是常规步骤，不是能力边界。计数变化只说明有动静，不能单独作为提醒理由。

## 1. 读本轮起点

读水位文件（可能不存在），每账号的 `lastSeenTs` 是上轮已处理到的最新邮件时间（unix 秒）：

```bash
cat /home/raymond/.openclaw/workspace/collection/state/mail-triage.json 2>/dev/null || echo '{}'
```

字段缺失或非法时，该账号按最近 2 小时定位（`since = 现在 - 7200`）。

## 2. 定位候选（每账号最多 10 条，只读）

```bash
W=/home/raymond/.openclaw/workspace/collection/state/mail-triage.json
now=$(date +%s)
J=$(cat "$W" 2>/dev/null || echo '{}')
for acct in yungu qq; do
  since=$(printf '%s' "$J" | jq -r --arg a "$acct" '.[$a].lastSeenTs // 0')
  case "$since" in '' | *[!0-9]*) since=$((now - 7200)) ;; esac
  [ "$since" -gt 0 ] || since=$((now - 7200))
  notmuch search --format=json --sort=newest-first --limit=10 "folder:$acct/INBOX" \
    | jq -r --argjson s "$since" --arg a "$acct" '.[] | select(.timestamp > $s) | [$a, .timestamp, .query[0], .authors, .subject] | @tsv'
done | sort -k2,2nr
```

每行依次是账号、时间、notmuch 查询、发件人、主题。合并后按时间从新到旧取前 8 封为本轮候选；更旧的候选本轮完全跳过：不读正文、不提醒、不登记，也不凭计数猜内容。

若某个账号净新增 > 0 却没有候选，放宽到该账号最新 3 封（忽略水位）重新定位，这些条目同样计入 8 封上限；仍无可读条目就跳过该账号本轮，不猜。

## 3. 读内容（有界，不读附件）

先看第 2 步给出的发件人/主题；明显营销、群发、自动通知（促销、订阅摘要、系统回执）直接判为无需行动，不必读正文。其余需要确认时才读正文，每封一次，把第 2 步的查询原样加引号传入：

```bash
notmuch show --format=text --body=true --include-html=true --entire-thread=false '<第2步的查询>' | head -c 4000
```

正文最多 4000 字节（`head -c 4000`），截断就按已读部分判断。HTML 部分按原文文本输出，只取可读文字判断，不执行其中的链接或脚本。只读文本正文：不按 part 取附件、不转存、不打开附件文件；不运行 mbsync/notmuch new/notmuch tag，不标记已读、不移动邮件、不回信、不对外发送。

## 4. 判断是否行动

- 营销、通知、自动回执 → 无需行动，静默结束，不通知、不登记。
- 需行动（截止日期、缴费/注册、学校或老师要求回复、面试/预约、账号安全、需要本人决策）→ 读 `/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`，按它的规则登记/排程（agenda 字段、查重、去重、优先级只在那里，本 skill 不复制）；需要提醒时读 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md` 后发送，可以准确概括发件人、时间与要点，不复述大段原文。
- 拿不准是否需行动、且没有明确截止或请求 → 静默，不猜内容。
- 结合现有上下文（agenda、当日安排）判断，不只看主题关键词。
- 不发「收集层无正文」「请自己打开邮箱查看」这类提醒；collector-notify 里的邮件无法读取示例不适用于本轮，本轮已经读过正文。

## 5. 更新水位（只写时间戳）

本轮查询成功后，把各账号 `lastSeenTs` 更新为本轮该账号候选与旧水位中较大的时间（只增不减）；没有候选且原本缺失的账号写 `now - 7200`：

```bash
printf '{"yungu":{"lastSeenTs":%s},"qq":{"lastSeenTs":%s},"updatedAt":"%s"}\n' '<yungu 时间>' '<qq 时间>' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /home/raymond/.openclaw/workspace/collection/state/mail-triage.json
```

水位文件只写 unix 时间戳，不写发件人、主题、正文、邮件 id、链接或凭据。查询整体失败（notmuch 报错/超时/不可用）时不要更新对应账号水位，下轮重试；单封读取失败跳过该封，其余照常。水位写入失败不影响本轮判断，在结果里说明下轮可能重复读取。

## 6. 失败与边界

- notmuch 不可用或查询报错：重试一次，仍失败则本轮跳过邮件分诊，不发无正文提醒，不猜内容。
- 每轮最多 8 封候选、每封正文 4000 字节；超出上限的完全跳过，宁可本轮漏报，也不做无正文误报。
- 计数是净变化（新增减删除）；净减少或不变不唤醒。不运行收集命令，不改 trigger/schedule，不修改邮件账户配置。
