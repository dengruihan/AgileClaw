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
| 目标约束        | 灯效硬件通道                                                 | **只发本人单聊**：连接器上下文 inbound senderId 钉定，flag/env 均须精确匹配                               |
| 通道失败时      | 无回退                                                       | 脚本退出码 1 并打印灯效回退命令；prompt 要求退回灯效                                                      |
| 自动化 delivery | `none`                                                       | `none`（不变）                                                                                            |
| 灯效工具        | 主通道                                                       | 回退保留，不清理                                                                                          |

## 文件映射

| 部署包内路径（相对仓库根）                                                                                   | 线上目标路径                                                                                 | 说明                                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs`   | `/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs`                           | 发送封装（新文件）                                           |
| `ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/payload-message.txt`   | 任务内嵌 `payload.message`（cron edit 同步）                                                 | post-M2 完整提示词（= M1 tip 7a53295ef 版 + R1a/R1b 措辞）   |
| `ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs` | `/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs`（+ cron edit 内嵌副本） | post-M2 完整触发脚本（= M1 tip 7a53295ef 版 + R2a/R2b 措辞） |
| `prompt-segments/replacements.md` R3                                                                         | 线上 collection README 一行                                                                  | 一次性安全替换（命令见步骤 5）                               |

包装脚本职责：钉定并强制使用本人单聊目标。权威来源是连接器自己的消息上下文
（`~/.openclaw/dingtalk-connector/message-context.json`）中本人私人会话 inbound 记录的
senderId——2026-11-02 真实测试证实它是 `robot/oToMessages/batchSend` 唯一接受的本人
staffId（`dws auth status` 的 user_id **不是**，调用会返回 `staffId.notExisted`）。
解析 fail-closed：全部 inbound 恰好同一纯数字 senderId 才可用；多身份、无 inbound、
senderId 缺失/非数字、文件损坏一律拒绝。目标钉定在 `state/notify-owner.json`
（`--set-owner` 或上下文自举写入，均须与上下文身份一致）；发送时 `--target`/env 必须
精确匹配钉定值，拒绝 group:/空 ID/他人 ID/损坏状态；按 ≤1900 code point 行边界分块
（不拆代理对）；逐块调用 `openclaw gateway call dingtalk-connector.send`
（`useAICard:false`、`msgType:"markdown"`）并校验返回 JSON `ok` 字段；非零退出时
stdout/stderr 都保留在错误信息里便于诊断。不读取/输出凭据；去重与分诊判断不在脚本内。

## 部署步骤（审查通过后由 tower 执行；所有命令从仓库根目录运行）

```bash
cd /home/raymond/repos/AgileClaw   # 主 checkout（wt-2 合并后）或含本部署包的检出

# 0. 前置：M1（ops/collector-phase2）已部署并核验通过。部署前核对 M1 基准未漂移：
diff ops/collector-phase2/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs \
     ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs
#    应只有 64、72 两行（通知措辞）不同。若 M1 在 7a53295ef 之后又有修复落盘，
#    不得直接用本包文件覆盖：以新的 M1 部署版为基准，按 prompt-segments/replacements.md
#    的 R1a/R1b/R2a/R2b Before→After 重新生成 post-M2 文件后再继续（杜绝把旧 M1 副本写回）。

# 1. 落盘发送封装
cp ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs \
   /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs

# 2. 钉定本人目标（一次性；权威来源为连接器消息上下文 inbound senderId）
node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs \
  --title "目标钉定" --text "部署期目标钉定" --dry-run
# 首次运行无钉定时会自动从连接器上下文解析本人身份并钉定（dry-run 不写钉定；
# 正式发送或用 --set-owner 才写）。期望输出 target 为 user:<20位数字>。
# 注意：不要使用 `dws auth status` 的 user_id 作为目标——真实测试（2026-11-02）证实
# 它不是 oToMessages 的合法 staffId（返回 staffId.notExisted）。
# 如需显式钉定（例如在上下文不可判定的人工核验后）：
#   node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --set-owner user:<本人staffId>
#（--set-owner 会与上下文身份比对，不一致即拒绝；verifiedVia=connector-context）
# 核验：cat /home/raymond/.openclaw/workspace/collection/state/notify-owner.json（只含 ID，不涉凭据）。

# 3. 真实单条测试（用户已授权这一条；建议工作日白天执行。目标已钉定，无需再带 --target）
node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs \
  --title "通知通道测试" \
  --text "这是一条测试消息：collector 提醒与故障告警将改由此机器人发送（普通 Markdown，非 AI 卡片）。无需处理。"
# 期望：退出码 0，stdout {"ok":true,...}；用户钉钉单聊收到普通消息（非卡片样式）。

# 4. 同步任务内嵌副本与落盘触发脚本（只改 --trigger-script/--message 两项；
#    delivery/toolsAllow/description/enabled/schedule 等其他字段一律不动）
cp ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs \
   /home/raymond/.openclaw/workspace/collection/trigger-collector.mjs
openclaw cron edit 6a45be21-ce0b-4b8b-8986-4c885d1ea659 \
  --trigger-script ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs \
  --message "$(cat ops/dingtalk-private-notifications/files/home/raymond/.openclaw/workspace/collection/payload-message.txt)"

# 5. collection README 一行安全替换（Before 串必须存在且唯一，否则报错不写）
node -e '
const fs = require("node:fs");
const p = "/home/raymond/.openclaw/workspace/collection/README.md";
const before = "   既有规则登记/排程/通知（先查重）；无需行动则静默结束。";
const after = "   既有规则登记/排程/通知（先查重；通知走 collection/dingtalk-notify.mjs 钉钉\n   Markdown 单聊，失败退回灯效推送）；无需行动则静默结束。";
const src = fs.readFileSync(p, "utf8");
const n = src.split(before).length - 1;
if (n !== 1) { console.error(`Before 串出现 ${n} 次，拒绝写入`); process.exit(1); }
fs.writeFileSync(p, src.replace(before, after));
console.log("README 替换完成");
'

# 6. 部署后核验
#    - openclaw cron get 6a45be21-...：enabled/every 600000ms/timeoutSeconds=600/lightContext/
#      toolsAllow=[ls,read,edit,write,apply_patch,exec,process,light_control,agenda] 与 M1 部署后一致，
#      delivery.mode 仍为 none；payload.message 与 post-M2 payload-message.txt 一致；
#      trigger.script 与落盘 trigger-collector.mjs 一致。
#    - diff 本包 trigger-collector.mjs 与线上落盘文件：应无差异。
#    - 等一个自然周期：无 delta 轮不唤醒；有真实 delta 的轮观察是否只走钉钉单聊（非卡片）。
```

## 回退

- 任务内嵌副本与触发脚本：把 M1 部署包（`ops/collector-phase2/`）的
  `payload-message.txt` / `trigger-collector.mjs` 按 M1 README 步骤 1–2 重新同步；
  或在没有 M1 检出时，用线上备份 `trigger-collector.mjs.bak.20261102`（M1 制备期创建）
  恢复触发脚本，并把 payload.message 按 prompt-segments/replacements.md 的 Before 段还原
  （openclaw cron edit --message）。
- collection README：按 replacements.md R3 的 Before 串反向替换（同样的唯一性校验）。
- 封装脚本与钉定目标：
  `rm /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs` +
  `rm -f /home/raymond/.openclaw/workspace/collection/state/notify-owner.json`。
- 回退后通知自动回到灯效渠道。灯效技能/工具全程未动，回退零成本。
- 本包不触碰 workspace AGENTS.md，回退亦无需涉及。

## 部署后待验证项

1. 第 3 步测试消息在用户钉钉客户端呈现为**普通消息**（无卡片外壳/无「AI」标识）。
2. 下一个真实事项 delta 唤醒轮：Agent 用 dingtalk-notify 发送提醒，内容/目标正确，
   未误发灯效（除失败回退外）。
3. 下一个源故障唤醒轮：每源每日一次的告警以 Markdown 单聊送达。
4. 长提醒（>1900 字符，含 emoji）分块连续送达、顺序正确、无乱码。
5. 发送失败场景（如 Gateway 重启窗口）Agent 正确退回灯效并在答复中说明。

## 边界

- 不改插件、不改 openclaw.json、不改 workspace AGENTS.md、不新建机器人/群、不清理灯效技能与工具。
- 不实现/修改触发器（M1 职责）；本包的 post-M2 trigger/payload 仅做 M1 基准之上的措辞替换。
- 包装脚本只向**钉定的本人单聊**发送；对外发消息仍按 workspace AGENTS.md 既有授权红线，
  本包不新增任何对外发送能力。
