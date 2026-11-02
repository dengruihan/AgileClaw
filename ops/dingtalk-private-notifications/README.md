# collector 通知出口切换：私人钉钉机器人普通文本/Markdown 单聊

目标：collector 自动化（id `6a45be21-ce0b-4b8b-8986-4c885d1ea659`）唤醒 Agent 后发出的
**事项提醒**与**收集故障告警**，从灯效推送切换到本人私人钉钉机器人单聊，**不使用 AI 卡片**
（普通 Markdown 消息）。自动化 `delivery` 保持 `none`，是否发送仍由 Agent 判断；
既有去重（每源每日一次、便单/日程查重）与 M1 的事项分诊逻辑不变；灯效技能/工具保留作回退。

普通文本可行性证据（AI 卡片由插件哪里决定、`useAICard:false` 通道、被排除的 dws 路径）：
见 [EVIDENCE.md](./EVIDENCE.md)。

## Before / After

|                 | Before                                                       | After                                                                                                     |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 提醒/告警通道   | 灯效推送（`ntf.cjs light send`）                             | 私人钉钉机器人 Markdown 单聊（非 AI 卡片）                                                                |
| 发送命令        | `ntf.cjs light send --segments ... --title ... --reason ...` | `node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>` |
| 通道失败时      | 无回退                                                       | 脚本退出码 1 并打印灯效回退命令；prompt 要求退回灯效                                                      |
| 自动化 delivery | `none`                                                       | `none`（不变）                                                                                            |
| 灯效工具        | 主通道                                                       | 回退保留，不清理                                                                                          |

## 文件映射

| 部署包内路径                                                            | 线上目标路径                                                       | 说明                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `files/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs` | `/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs` | 发送封装（新文件）                |
| `prompt-segments/replacements.md` R1–R4                                 | 见该文件逐条                                                       | 提示词/措辞替换段（不落盘新文件） |

包装脚本职责：解析本人单聊目标（state 缓存 → `dws auth status` 兜底）、按 ≤1900 字符
行边界分块、逐块调用 `openclaw gateway call dingtalk-connector.send`
（`useAICard:false`、`msgType:"markdown"`）、校验返回 JSON `ok` 字段。
不读取/输出凭据；去重与分诊判断不在脚本内。

## 部署步骤（审查通过后由 tower 执行）

```bash
cd <本部署包所在仓库检出>

# 0. 前置：M1（ops/collector-phase2）已部署且核验通过（R1–R3 改的是 M1 落盘文件的措辞）。

# 1. 落盘发送封装
cp files/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs \
   /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs

# 2. 解析并缓存通知目标（本人 staffId；只写 ID，不涉凭据）
node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs \
  --title "目标解析" --text "部署期目标解析" --dry-run
# 期望：dryRun JSON 中 targetSource 为 dws、target 为 user:<staffId>，
# 且 state/notify-target.json 已写入。若 dws 不可用，改用：
#   node .../dingtalk-notify.mjs --target user:<staffId> --title x --text x --dry-run
#（staffId 形状 3000...，经 `dws auth status --format json` 的 user_id 取得）

# 3. 真实单条测试（用户已授权这一条；建议工作日白天执行）
node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs \
  --title "通知通道测试" \
  --text "这是一条测试消息：collector 提醒与故障告警将改由此机器人发送（普通 Markdown，非 AI 卡片）。无需处理。"
# 期望：退出码 0，stdout {"ok":true,...}；用户钉钉单聊收到普通消息（非卡片样式）。

# 4. 提示词切换：按 prompt-segments/replacements.md 执行 R1–R4，
#    R1/R2 涉及任务内嵌副本的，沿用 M1 的 openclaw cron edit 命令同步。

# 5. 部署后核验
#    - openclaw cron get 6a45be21-...：enabled/every 600000ms/timeoutSeconds=600/lightContext/toolsAllow 不变，delivery.mode 仍为 none
#    - payload.message/trigger.script 措辞与替换段一致
#    - 等一个自然周期：无 delta 轮不唤醒；有真实 delta 的轮观察是否只走钉钉单聊（非卡片）
```

## 回退

- 提示词：按 `prompt-segments/replacements.md` 的 Before 段还原（R1–R4 均为纯措辞改动，
  无状态迁移）；任务内嵌副本用 `openclaw cron edit` 重新同步。
- 封装脚本：`rm /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs` +
  `rm -f /home/raymond/.openclaw/workspace/collection/state/notify-target.json`。
- 回退后通知自动回到灯效渠道（R4 之前的 prompt 只提灯效）。
- 灯效技能/工具全程未动，回退零成本。

## 部署后待验证项

1. 第 3 步测试消息在用户钉钉客户端呈现为**普通消息**（无卡片外壳/无「AI」标识）。
2. 下一个真实事项 delta 唤醒轮：Agent 用 dingtalk-notify 发送提醒，内容/目标正确，
   未误发灯效（除失败回退外）。
3. 下一个源故障唤醒轮：每源每日一次的告警以 Markdown 单聊送达。
4. 长提醒（>1900 字符）分块连续送达、顺序正确。
5. 发送失败场景（如 Gateway 重启窗口）Agent 正确退回灯效并在答复中说明。

## 边界

- 不改插件、不改 openclaw.json、不新建机器人/群、不清理灯效技能与工具。
- 不实现/修改触发器（M1 职责）；本包只提供通知出口。
- 包装脚本只向**本人单聊**发送；不对第三方发送（对外发消息仍按 workspace AGENTS.md 授权红线）。
