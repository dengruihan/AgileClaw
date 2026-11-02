# collector 钉钉会话分诊：先补查正文/已读/已回复，再决定提醒

状态：**提示词与部署/回滚脚本、只读验证证据已就绪；未部署**。本次未修改 live cron、`~/.openclaw` 工作区文件或 Gateway，未发送任何消息。

覆盖对象：线上自动化 `collector`（`6a45be21-ce0b-4b8b-8986-4c885d1ea659`，`displayName=统一事项收集`，每 10 分钟评估、`sessionTarget=isolated`、`timeoutSeconds=600`）。

## 1. 用户要求（原文）

> 用户明确要求：『现在玲珑在自动化里看到钉钉有消息后不应该直接来提醒我，应该调用 dws 看一下对应的消息，确认我有没有已读，有没有回复，如果回复了就不用做提示，如果没回复，再结合所有的信息分析需不需要提醒我』。

## 2. 现状与根因

- 收集层 `collection/sources/dingtalk.mjs` 只调用 `dws chat +chat-list`（群/单聊各默认页），每会话产出 `{key, kind:'conversation', cid, name, lastMsgAt}`；覆盖说明明确「不含消息正文」。
- 触发脚本按 `lastMsgAt` 变化产生 delta 并唤醒 Agent；这一层没有错，也不需要改。
- 旧 payload 的「能力边界」写死为「钉钉源只有会话列表变化（cid/name/lastMsgAt）……不得声称读过或总结正文；需要正文时请用户到对应应用查看原文」。模型因此**被禁止补查**，只能在看到会话动静后直接发内容为空的提醒（或按示例写「只能看到会话动态」）。
- 结果正是用户抱怨的行为：本人刚回复完的消息也会触发提醒；有正文可判断时不判断。

线上基线（2026-11-02 读取）：

| 项                          | 值                                                                 |
| --------------------------- | ------------------------------------------------------------------ |
| payload.message sha256      | `3422e6ed8a38d0e1169f508c16d951991ef9aaa6fd0d5436b0cea4d4845dd311` |
| trigger.script sha256       | `2fefcf25abc694c645c1e856ec85433f2b5bff25ce72d938e2be92b8f53e3a91` |
| 期望 payload.message sha256 | `fa8537795b3b7bcda4b1feb2dcf7b9a5edbb24ed80401c295a7812e11e7ca25c` |

## 3. 方案（只改 Agent 提示词）

把钉钉分诊从「看到 lastMsgAt 变化就提醒」改为「变化后必须只读补查，再决定」：

1. **本人身份**：`dws contact +me` 取 `userId`；`dws contact user search --query "<userId>"` 在 `result[]` 里按 `userId` 精确匹配取 `openDingTalkId`，作为本人 `senderId`。身份只比较稳定 ID，不比较展示名（dws 输出 `identityResult.nameComparisonAllowed=false`、`stableIdField=senderId`）。
2. **会话详情**：`dws chat +chat-messages --group "<cid>" --limit 15` 取新→旧的 `messages[]`（`sender/senderId/text/createTime/messageId`，含 `quotedMessage/reactions`）。
3. **已回复/本人动态**：`messages[0].senderId` 等于本人 `senderId` → 最后一条是本人发的 → 不提醒、不登记、不排程，直接跳过。
4. **未读状态**：`dws chat +chat-list --types group,p2p --page-size 100 --sort active_time` 按 `cid` 取 `unreadPoint`（>0 未读、0 已读），找不到时用 `dws chat +unread-chats --count 100` 交叉判断。**已读不等于不用管**，仍按内容判断。
5. **未回复时的判断输入**：正文要点、是否 @ 我、是否提问、是否含截止/时间要求、未读状态。需要行动才按 `schedule-sweep` 登记/排程并提醒；否则静默。
6. **通知可写正文要点**：可以准确概括「谁、什么时候、说了什么要点」，不再写「只能看到会话动态」或让用户自己去钉钉看。只提炼要点，不复述大段原文，不展开隐私细节。
7. **补查失败**：同一会话重试一次；仍失败则本轮跳过，**不发「收集层无正文」这类提醒，也不猜内容**。`DWS_AUTH`/auth/token/401/403 → 走既有故障流程提示用户 `dws auth login`，不代登。
8. **有界**：一轮最多补查 10 个变化会话，按 `lastMsgAt` 从新到旧。超出上限的会话本轮**完全跳过**：不提醒、不登记、不排程，也不能只凭未读状态行动——未读只是补查后的判断输入，不是提醒依据。

保留不变：

- 【通知语言】规则原文逐字保留（只把「普通变化」示例改成能概括正文的说法，因为旧示例描述的正是本次要消除的行为）。
- 钉钉 Markdown 通知命令与灯效回退命令逐字保留。
- 邮件、云谷课堂/课表、One Schoolhouse 的分诊规则不变（邮件仍只有净计数、不得声称读过邮件正文）。
- 第二节收集故障流程逐字保留。
- 触发脚本、调度、超时、`toolsAllow`、description、session target 全部不动。

## 4. dws 只读验证（v1.0.63）

所有调用均为 `effect=read`，未发送消息、未标记已读。

| 调用                                                                                     | 观察到的结构                                                                                                                                           | 用途                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `dws contact +me --format json`                                                          | `data.userId`（另含姓名/部门）                                                                                                                         | 本人 `userId`            |
| `dws contact user search --query "<userId>" --format json`                               | `result[]` 含 `userId`、`name`、`openDingTalkId`；按 userId 精确匹配得到唯一本人条目                                                                   | userId → `senderId` 映射 |
| `dws chat +chat-messages --group "<cid>" --limit 15 --format json`                       | `messages[]` 新→旧，含 `sender`、`senderId`、`text`、`createTime`、`messageId`；`identityResult.nameComparisonAllowed=false`、`stableIdField=senderId` | 正文与会话详情           |
| 同上加 `--sender "<userId>"`                                                             | `resolvedFilters.senders[].selected` 给出 `{userId, openDingTalkId}`；**群聊里消息过滤本身可能返回 0 条**（即使本人发过言）                            | 映射兜底，不用条数下结论 |
| `dws chat +chat-list --types group,p2p --page-size 100 --sort active_time --format json` | 每会话 `openConversationId`、`name`、`lastMsgCreateAt`、`unreadPoint`                                                                                  | 未读状态（已实测字段）   |
| `dws chat +unread-chats --count 100 --format json`                                       | `result.conversations`；当前实测为空列表（与全部 `unreadPoint=0` 一致）                                                                                | 未读交叉判断             |

真实只读抽样（`verify/probe.sh`，输出已脱敏，不含正文）：

1. 单聊，最后一条是本人回复 → `activityFromSelf=true` → `skip`。
2. 群聊，最后一条是他人（本人从未发言）→ `activityFromSelf=false` → `triage`。
3. 单聊，他人 21:51:38 发言、本人 21:51:45 回复 → `activityFromSelf=true` → `skip`（正是旧 prompt 会误报的场景）。

已知 dws 细节（已写进提示词，避免踩坑）：

- `+chat-messages` 没有 `--cid`；会话目标用 `--group "<openConversationId>"`，群聊与单聊都可用。cid 含 `/`、`=`，必须加引号。
- 本人与部分同学的 `senderId` 前缀相同，必须比较完整 ID，不能看前缀/展示名。
- 群聊 `--sender <userId>` 的消息过滤可能返回空，但 `resolvedFilters` 仍给出映射；因此身份映射走通讯录搜索，不用消息条数判断。

## 5. 部署（审查通过后由 tower 执行；本任务未执行）

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-dingtalk-detail-triage

./scripts/status.sh            # 只读：应显示 state=not deployed、trigger sha 与基线一致
./scripts/deploy.sh            # 只打印计划
./scripts/deploy.sh --yes      # 备份 → 只改 payload.message → 逐项核验
./scripts/status.sh            # 应显示 state=deployed
```

`deploy.sh` 只调用 `openclaw cron edit <id> --message ...`，不会传 `--trigger-script`；编辑前把完整 job JSON 与旧 message 存到 `~/.openclaw/backups/collector-dingtalk-detail-triage/<UTC 时间戳>/`，编辑后核验：

- `payload.message` 与 `payload-message.txt` 的 sha256 一致；
- `trigger.script` 的 sha256 与部署前一致；
- `schedule`、`timeoutSeconds`、`toolsAllow`、`sessionTarget`、`enabled`、description 全部未变。

任一项不符会自动把旧 message 写回并报错。**部署后的读取失败、JSON 解析失败也走同一恢复路径**：`verify_after` 内的 after-get、字段解析、比较任一步失败都会先 `restore_previous` 再退出，不会因 `set -e` 把新 prompt 留在线上。`cron edit` 本身报错时同样先尝试写回。当前 live message 若已不是 §2 的基线，脚本会拒绝，需先看 `openclaw cron get ... --json` 再决定是否 `--allow-drift`。

部署后验证（不 force run、不发测试消息）：

1. 等下一个 10 分钟评估点，确认 `triggerEvalCount` 递增、无异常。
2. 真实出现钉钉 delta 时观察一轮：本人收尾的会话不提醒；他人未回复且值得行动时，提醒里能说出正文要点而不是「只能看到会话动态」。
3. `openclaw cron get <id> --json` 复核 message sha 与 trigger sha。

## 6. 回滚

```bash
cd /home/raymond/repos/AgileClaw/ops/collector-dingtalk-detail-triage

./scripts/rollback.sh            # 只打印计划（默认用最新备份）
./scripts/rollback.sh --yes      # 写回部署前的 message 并核验
./scripts/status.sh              # state=not deployed
```

回滚同样只改 `payload.message`，并核验 trigger sha 未变。若 live message 已被别的变更改过，脚本默认拒绝；先看 `openclaw cron get` 再决定是否 `--force`。指定备份：`--backup ~/.openclaw/backups/collector-dingtalk-detail-triage/<ts>`。

## 7. 验证结果（2026-11-02）

| 命令                                      | 结果                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node verify/check-prompt.mjs`            | **84/84 PASS**：必需补查步骤、身份映射、本人收尾跳过、失败不降级为「无正文」提醒、超限会话只跳过不做未读-only 行动、语言/通知/其他来源/故障流程保留、脚本不碰 trigger、部署后读取失败可恢复、无真实 cid/messageId/手机号/个人 userId 泄漏 |
| `./verify/deploy-sim.sh`                  | **28/28 PASS**（fake CLI，不碰 live）：dry run、drift 拒绝、apply、字段不变、status、rollback、未知状态拒绝、`--force`、校验失败自动回滚，以及 **edit 成功后 after-get 失败 / 返回坏 JSON 两种情况都自动恢复**                            |
| `./verify/probe.sh --cid <已脱敏 cid>` ×3 | 3 个真实只读样本，结论分别为 `skip` / `triage` / `skip`，无正文输出                                                                                                                                                                       |
| `./scripts/deploy.sh`（无 `--yes`）       | 只打印计划，未改动 live                                                                                                                                                                                                                   |
| `./scripts/status.sh`                     | live：`state=not deployed`，trigger sha 与基线一致，message 未变                                                                                                                                                                          |
| `./scripts/rollback.sh`（无 `--yes`）     | 当前无备份，按预期报错退出；有备份路径由 deploy-sim 覆盖                                                                                                                                                                                  |

## 8. 边界、风险与后续

- **未验证部分（如实声明）**：模型是否按提示正确调用工具、判断是否值得提醒，离线无法执行；需部署后自然周期观察一轮真实 delta（不 force run）。
- `+unread-chats` 的字段名无法预演（当前未读为空）；提示词因此以已实测的 `chat-list.unreadPoint` 为主、`+unread-chats` 为交叉验证，成员匹配按会话 ID/名称。
- 每会话只读最近 15 条，同一秒内多条消息依赖 dws 返回顺序；极端并发下可能把同一秒的收尾判成未回复（会多提醒一次，不会漏掉本人回复）。
- 一轮最多补查 10 个会话；超出部分本轮完全跳过（不提醒、不登记、不排程），不允许仅凭未读状态行动。
- 正文只在本轮 Agent 上下文使用，不写入 `report.json`、快照或日志；提醒只提炼要点。部署后仍建议人工抽查一条通知是否泄露过多原文。
- live 工作区 `~/.openclaw/workspace/collection/README.md` 描述的是收集层（仍准确），本次不改；如需让运维文档也写明「唤醒后由 Agent 补查钉钉正文」，可在部署后追加一句，不阻塞本任务。
- description 未改（「有事项delta唤醒Agent分诊」仍准确）。

## 9. 产物清单

- `payload-message.txt` — 新的 `payload.message` 全文（唯一下发的行为变更）
- `scripts/lib.sh` — job id、基线 sha256、`OPENCLAW_CLI`、备份目录、JSON 字段助手
- `scripts/deploy.sh` — 备份 → 只改 message → 核验 → 失败自动写回
- `scripts/rollback.sh` — 按备份写回 message 并核验
- `scripts/status.sh` — 只读状态：当前/期望/基线 sha、trigger sha、字段、最新备份
- `verify/check-prompt.mjs` — 提示词与脚本的静态契约检查
- `verify/probe.sh` — 对指定 cid 执行真实只读判断，输出脱敏结论
- `verify/deploy-sim.sh` + `verify/fake-openclaw.sh` — 离线部署/回滚/自动恢复测试
