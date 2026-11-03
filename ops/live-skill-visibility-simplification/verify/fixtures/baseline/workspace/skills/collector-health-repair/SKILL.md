---
name: collector-health-repair
description: "collector 唤醒：收集层源连续失败或 collect.mjs 输出异常时的定位、登录自愈与故障通知；不动 agenda。仅供 collector 自动化使用。"
---

# 收集故障修复

处理唤醒原因里点明的收集层故障（某源连续失败，或 collect.mjs 输出异常），以及钉钉补查时发现的 DWS 认证失效。

1. 读 `/home/raymond/.openclaw/workspace/collection/README.md` 与 `state/health.json` 定位。
2. 优先走登录自愈：`node /home/raymond/.openclaw/workspace/collection/collect.mjs <源> --force`。
3. dws 认证失效需提示用户重新 `dws auth login`，不代登。
4. 修复后重跑验证 streak 归零。
5. 用同一通知命令推送一条简短通知：`node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <修复结果>`；发送失败就在本轮结果写明失败与原因，不换通道重发，每源每日一次。措辞与发送规则读 `/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md`。
6. 不动 agenda 数据、不做排程、不动其他自动化；无法修复时写明阻塞点并保持现状。
