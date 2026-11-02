# Collector 通知语言风格改版（M4，2026-11-02）

玲珑（用户助理）的通知语言从公文式改为体贴、清晰、偶尔克制幽默的助理口吻。
**只改 `payload.message` 的语言表达与示例；功能逻辑、事实边界、通知命令、触发器一律不动。**

## 文件

| 文件                   | 作用                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `baseline-message.txt` | 线上现状：`openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659` 的 `payload.message` 原文（2026-11-02 捕获） |
| `payload-message.txt`  | 改版后完整 `payload.message`，部署时作为 `--message` 的内容                                                     |
| `verify.mjs`           | L4 静态自检：功能锚点保留、批准改写核对、禁用措辞缺席、风格示例齐全                                             |

## 验证（已通过）

```bash
node ops/collector-language-style/verify.mjs
# 全部检查通过：20 个功能锚点未漂移，6 处批准改写成立，
# 8 个禁用措辞缺席，风格块与五类示例齐全。
```

外加人工示例审查：五类示例各 1–3 句；普通消息不制造紧张；紧急示例第一句即行动；
故障示例不玩笑、只陈述事实与下一步；无一条示例拿人或失误开玩笑。

## 关键 before / after

| 位置                     | before                                                                                     | after                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 通知开头风格（反例原文） | 「G12 Academic English 3 群 17:22 有新消息。收集层无正文，未读内容，请本人打开钉钉查看。」 | 「G12 Academic English 3 群 17:22 有新消息，钉钉这边只能看到会话动态，正文要打开钉钉才能看到。」        |
| 正文不可读时的说法       | 需要正文时提示用户本人查看                                                                 | 需要正文时请用户到对应应用查看原文（不暗示用户已读/未读，不出现"本人"）                                 |
| 事项变化判定依据         | report.json 里对应来源存在 added/changed/removed delta                                     | report.json 里对应来源有新增、变化或移除的事项（去掉 delta 行话）                                       |
| 通知出口说明             | 只发本人                                                                                   | 只发给用户自己                                                                                          |
| 修障路径                 | 优先走收集层登录自愈                                                                       | 优先走登录自愈（去掉"收集层"内部词）                                                                    |
| 新增                     | —                                                                                          | 【通知语言】风格块：玲珑口吻、1–3 句、紧急先说行动、幽默有边界、不自称或模仿任何影视角色 + 五类中文示例 |

## 未变（功能锚点，verify.mjs 逐项锁定）

- 唤醒总原则、无需行动静默结束、schedule-sweep 登记/排程、先查重不重复建单
- dingtalk-notify 完整命令（标题≤20字、Markdown 单聊非 AI 卡片、退出码 1 + 灯效回退命令原文）
- 能力边界：邮件仅净计数、钉钉仅会话列表变化（cid/name/lastMsgAt）、不得声称读过或总结正文、
  云谷/课表与 OSH 带完整条目、忽略 skipped
- 修障：README + health.json 定位、`collect.mjs <源> --force`、dws 认证失效提示重新 login 不代登、
  streak 归零验证、每源每日一次灯效回退、不动 agenda/不做排程/不动其他自动化

## 部署（由 tower 执行，本分支不直接写线上）

```bash
# 1. 部署前再次确认线上基准未漂移（应与 baseline-message.txt 的 payload.message 一致）
openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659

# 2. 仅替换 message；不碰 --trigger-script 与其他字段
openclaw cron edit 6a45be21-ce0b-4b8b-8986-4c885d1ea659 \
  --message "$(cat ops/collector-language-style/payload-message.txt)"

# 3. 核验：除 payload.message 外所有字段不变（schedule、trigger、toolsAllow、delivery…），
#    且新的 message 与 payload-message.txt 一致（注意 $(cat) 会去掉末尾换行，
#    两侧都经 $(cat) 对比即可）
openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659
```

注意：触发脚本注释要求"修改触发脚本或 payload 后必须 `openclaw cron edit --trigger-script/--message`
同步进任务"——本次只同步 `--message`，触发脚本未改，无需 `--trigger-script`。
