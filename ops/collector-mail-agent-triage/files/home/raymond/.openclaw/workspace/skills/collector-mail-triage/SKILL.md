---
name: collector-mail-triage
description: "collector 唤醒：邮件计数变化时用本地 notmuch 只读补查最新邮件，读发件人/主题/必要正文后决定静默、登记或提醒。仅供 collector 自动化使用。"
---

# 邮件分诊（本地 notmuch 只读补查）

收集层只同步并给出收件箱净计数（yungu、qq），发件人/主题/正文都不进 report.json 或收集快照。本轮被唤醒后自己用现有本地 notmuch 索引只读补查——这是常规步骤，不是能力边界。计数变化只说明有动静，不能单独作为提醒理由。

不创建、不读取、不写入任何水位/进度/缓存文件，也不新增数据库或表。每轮都从最新邮件重新定位：本轮没处理到的邮件，下一次唤醒时仍在候选里，不会被持久进度永久跳过。

## 1. 定位候选（只读、有界）

```bash
( set -o pipefail
  rows=$(for acct in yungu qq; do
    raw=$(notmuch search --format=json --sort=newest-first --limit=20 "folder:$acct/INBOX") || { echo "NOTMUCH_SEARCH_FAILED:$acct" >&2; exit 2; }
    printf '%s' "$raw" | jq -r --arg a "$acct" '.[] | [$a, .timestamp, .query[0], .authors, .subject] | @tsv' || { echo "JQ_FAILED:$acct" >&2; exit 2; }
  done | sort -k2,2nr) || exit 2
  printf '%s\n' "$rows"
)
```

每行依次是账号、时间、notmuch 查询、发件人、主题；输出就是本轮候选（每账号最多 20 行，合计最多 40 行）。每账号查询上限 20 条，合并后按时间从新到旧逐项判断，不额外按排序截断候选；超出 20 条查询窗口的更旧邮件不在本轮候选内。

唤醒消息里的账号净新增数量用来判断大概有几封新邮件；候选从最新一封开始逐项判断。它不是逐封已处理状态：没读或读取失败的邮件，只要还在该账号最新 20 条内，下次唤醒仍是候选。没有持久进度，也不会因为排序截断而永久跳过。不要为了记住进度而新建文件、JSON 或数据库表。

## 2. 读内容（有界，不读附件）

先看第 1 步给出的发件人/主题；明显营销、群发、自动通知（促销、订阅摘要、系统回执）直接判为无需行动，不必读正文。其余需要确认时才读正文，每封一次：

```bash
( body=$(notmuch show --format=text --body=true --include-html=true --entire-thread=false '<第1步的查询>') || { echo 'NOTMUCH_SHOW_FAILED' >&2; exit 3; }
  printf '%s' "$body" | head -c 4000
)
```

正文最多 4000 字节（`head -c 4000`），截断就按已读部分判断。HTML 部分按原文文本输出，只取可读文字判断，不执行其中的链接或脚本。只读文本正文：不按 part 取附件、不转存、不打开附件文件；不运行 mbsync/notmuch new/notmuch tag，不标记已读、不移动邮件、不回信、不对外发送。

notmuch search/jq 或 notmuch show 失败会带 `NOTMUCH_*_FAILED` 并返回非零；不要把它当成「没有新邮件」。单封读取失败跳过该封，其余候选照常判断。

## 3. 判断是否行动

- 营销、通知、自动回执 → 无需行动，静默结束，不通知、不登记。
- 需行动（截止日期、缴费/注册、学校或老师要求回复、面试/预约、账号安全、需要本人决策）→ 读 `/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`，按它的规则登记/排程（agenda 字段、查重、去重、优先级只在那里，本 skill 不复制）；需要提醒时读 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md` 后发送，可以准确概括发件人、时间与要点，不复述大段原文。
- 同一封邮件可能在相邻轮次重复出现：登记前按 schedule-sweep 查重，提醒前确认 agenda 或本轮上下文没有同一事项；营销/通知类重读后仍静默。
- 拿不准是否需行动、且没有明确截止或请求 → 静默，不猜内容。
- 结合现有上下文（agenda、当日安排）判断，不只看主题关键词。
- 不发「收集层无正文」「请自己打开邮箱查看」这类提醒；collector-notify 里的邮件无法读取示例不适用于本轮，本轮已经读过正文。

## 4. 失败与边界

- notmuch 不可用、查询报错、jq 解析失败或候选无法解析：重试一次，仍失败则本轮跳过邮件分诊（定位不确定也跳过），不发无正文提醒，不猜内容。
- 每账号最多 20 条候选、每封正文 4000 字节；超出查询窗口的更旧邮件不在本轮候选内（有界定位的已知限制），宁可本轮漏报，也不做无正文误报。
- 不创建水位/进度文件，不写 collection/state，不写 report.json 或快照，不新增 SQLite 表；去重只用 schedule-sweep 的 agenda 与现有上下文。
- 计数是净变化（新增减删除）；净减少或不变不唤醒。没有新的净新增就不会再次唤醒，这是现有 trigger 的条件，本 skill 不额外巡检。不运行收集命令，不改 trigger/schedule，不修改邮件账户配置。
