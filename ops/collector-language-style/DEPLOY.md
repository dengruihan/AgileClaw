# Collector 通知语言风格改版 + 全局表达规则（M4，2026-11-02）

玲珑的通知语言从公文式改为体贴、清晰、偶尔克制幽默的助理口吻。
双层方案：**SOUL.md 持有全局表达规则（唯一 owner）**；**collector payload 持有最小自洽的通知风格规则**——因为已证实 isolated + lightContext 的 cron 会话**不会注入** SOUL.md（证据链见下），payload 不能留"见 SOUL.md"式空指针。
功能逻辑、事实边界、通知命令、触发器一律不动；IDENTITY.md 不动。

## 文件

| 文件                   | 作用                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `payload-message.txt`  | 改版后完整 `payload.message`，部署时作 `--message` 内容（含最小通知风格块 + 五类示例） |
| `baseline-message.txt` | 线上 collector 现状（2026-11-02 `cron get 6a45be21-…` 捕获）                           |
| `SOUL.md`              | 制备好的完整 SOUL.md = live 原文 + 「## 表达」一节（在「气质」与「延续」之间）         |
| `baseline-soul.txt`    | live SOUL.md 原文（2026-11-02 捕获，3614 字节，无末尾换行）                            |
| `verify.mjs`           | L4 静态自检：payload 锚点/禁词/示例 + SOUL 插入节纯净性/身份红线/空指针检查            |

## 关键证据：lightContext cron 不注入 SOUL.md

源码链（本仓库，live 运行的同一套代码）：

1. `src/cron/isolated-agent/run-executor.ts:133-137` — `payload.lightContext=true` ⇒
   `bootstrapContextMode="lightweight"`（collector 的 payload 里 `lightContext: true`）。
2. `src/agents/bootstrap-files.ts:366-367` — `contextMode === "lightweight" ? [] : sessionFiles`，
   注释明确"all lightweight runs omit bootstrap context"：AGENTS/SOUL/IDENTITY/USER/MEMORY 全部省略。
3. `src/agents/harness/prompt-context.ts:21-28` — lightweight cron 连 runtime context 段也不附带。

会话实证：collector 隔离会话 `840b1881-e316-46bf-ab43-ae04822b6b2e`
（`agent:main:cron:6a45be21-…`，2026-11-02 10:29 运行轮）转写序列为
session → model_change → thinking_level → model-snapshot → **user（cron payload 原文）** → assistant，
全库检索无任何 "Project Context" 事件；唯一 "SOUL.md" 命中是运行中一次 `ls` 的目录输出。

**结论**：SOUL.md 部署后，主对话等其他会话继承全局表达风格；collector 唤醒轮读不到它，
所以 payload 保留最小自洽的通知风格规则（气质描述、长度、紧急先说行动、幽默边界、不自称角色、五示例）。
这不构成双重 owner：全局规则管玲珑所有表达，payload 只兜住"注入不到"的通知场景；
若将来关掉 lightContext，可再把 payload 风格块收敛为通知特有约束。

## SOUL.md before / after

after = before 逐字节不变，仅在「## 气质」和「## 延续」之间插入：

```markdown
## 表达

- **体贴但有边界**：周到地想到下一步，但不越权、不替用户做决定。
- **清晰有条理、简单易懂**：先说结论和该做什么，再补必要细节；能一句说清就不用两句。
- **偶尔一点克制的幽默**：可以有趣，但不拿人、不拿失误、不拿紧急事项开玩笑，不强行玩梗，不借用影视角色名自称或模仿。
- **通知与提醒用日常口吻**，不用内部术语和公文措辞；紧急事项第一句先说行动。
```

不出现"贾维斯"字样（防自称/模仿）；IDENTITY.md 未改。

## Payload before / after（语言-only，锚点全部保留）

| 位置                 | before                                                                                     | after                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 通知风格（反例原文） | 「G12 Academic English 3 群 17:22 有新消息。收集层无正文，未读内容，请本人打开钉钉查看。」 | 「G12 Academic English 3 群 17:22 有新消息，钉钉这边只能看到会话动态，正文要打开钉钉才能看到。」（新【通知语言】块 + 五类示例） |
| 正文不可读时的说法   | 需要正文时提示用户本人查看                                                                 | 需要正文时请用户到对应应用查看原文                                                                                              |
| 内部措辞             | delta / 收集层 / 本人                                                                      | 新增、变化或移除的事项 / 登录自愈 / 用户自己                                                                                    |

五类示例：普通变化轻柔不制造紧张；需要行动含已做事项；紧急事项第一句即行动
（「物理作业今晚 23:00 截止，现在还未提交。建议先完成这一件，我已把它排到待办最前。」）；
收集故障不玩笑（「…需要你在终端跑一次 dws auth login，我不能代登；登录后我会自动重试验证。」）；
无法读取内容不暗示用户未读（「邮箱净增 2 封。邮件正文不在收集范围，需要的话打开邮箱查看…」）。

## 验证（已通过）

```bash
node ops/collector-language-style/verify.mjs
# 全部通过：20 个功能锚点未漂移；6 处批准改写成立；8 个禁用措辞缺席；
# 风格块与五类示例齐全；SOUL 仅插入表达节（逐字节一致）；无角色名；payload 无 SOUL 空指针。
```

## 部署（由 tower 执行，先备份，不发送真实消息）

```bash
# 1. 部署前复核基准未漂移
diff <(openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659 | jq -r .payload.message) \
     ops/collector-language-style/baseline-message.txt   # 忽略末尾换行
diff /home/raymond/.openclaw/workspace/SOUL.md ops/collector-language-style/baseline-soul.txt

# 2. 备份并部署 SOUL.md（全局表达规则）
cp /home/raymond/.openclaw/workspace/SOUL.md /home/raymond/.openclaw/workspace/SOUL.md.bak-20261102
cp ops/collector-language-style/SOUL.md /home/raymond/.openclaw/workspace/SOUL.md

# 3. 仅替换 collector 的 message；触发脚本未改，不要 --trigger-script
openclaw cron edit 6a45be21-ce0b-4b8b-8986-4c885d1ea659 \
  --message "$(cat ops/collector-language-style/payload-message.txt)"

# 4. 核验：除 payload.message 外所有 cron 字段不变；新 message 与制备文件一致（$(cat) 两侧对比）
openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659
```
