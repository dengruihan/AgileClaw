---
name: yungu-schedule
description: "查询云谷课堂个人周课表：作息时段、上课时间、晚饭、放学、晚自修等。触发词：云谷课表、我的课表、今天课表、晚饭时间、几点放学、学校日程。"
---

# yungu-schedule

查询云谷课堂（task.yungu.org）的学生个人周课表，返回按天分组的作息时段（起床/上课/社团/晚餐/晚自修/熄灯等）。

## 前置条件

| 依赖            | 位置                                                        | 缺失时的处理                                       |
| --------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| 登录会话        | ~/.yungu/state.json（权限 600）                             | 无或过期时先跑 yungu-tasks skill 的第 1 步登录脚本 |
| playwright-core | /home/raymond/repos/AgileClaw/node_modules/playwright-core/ | 见 yungu-tasks skill 前置条件                      |

## 工作流

1. 若会话可能失效，先完成 yungu-tasks skill 第 1 步（CAS 登录，凭据走密钥库环境变量）。
2. 运行抓取脚本：

```bash
node <skill目录>/scripts/yungu-schedule.mjs   # 可选参数：周一起始毫秒时间戳，默认本周
```

完成标准：按天输出时段表（== 周一 == 至 == 周日 ==，每行 HH:MM-HH:MM 名称）。

日常同步不需要手工执行：collector 每 6 小时抓本周+下周，逐周校验后通过 Agenda sync 自动入库；
本 skill 的抓取命令用于查询或排障。

## 数据说明

- 数据源：https://task.yungu.org/calendar/api/personal/schdedule/templateForPc?weekNumber=1&queryStartTime=<周一0点ms>&queryEndTime=<周日23:59:59ms>
- 脚本先监听页面加载的响应，再直接调 API 兜底；会话失效时 API 返回非 content 结构，脚本以 FAIL 退出码 1 结束，此时回到登录步骤。
- 晚自修（18:15–20:45）会出现在课表中，但用户 agency 等级 3（最高）不参加，排日程时忽略。
- 晚上的“寄宿社区时间”和“个人时间”是完全空闲的作息标签，原始课表可如实列出；写入 Agenda 或生成个人日程时，按 schedule-sweep 的空闲规则处理，不将标签导入为事项、固定事件或占位块。
- 周六/周日为在家休息日：系统周末条目（如晚自修）属平台显示 bug，一律忽略，不据此排程。
- 平台会把“下周”返回成本周日期的副本。抓取层按请求周校验：槽位日期不属于该周、整周为空或槽位非法时，该周判失败，不写入 coverage，也不当作下周课表；只有日期确实落在请求周的周才算同步成功。
- 常用锚点：晚餐 17:15/17:30–18:15；放学 17:15/17:30；22:30 熄灯就寝。

## 已知坑

1. Chrome 沙箱在此服务器启动必崩 —— launch 参数必须含 --no-sandbox。
2. 接口路径是 schdedule（官方拼写如此，非 schedule），搜索接口时别纠正拼写。

## 安全边界

- 抓取内容属用户隐私数据：仅用于用户本人的日程安排，不进群聊、不对外发送。
- state.json 等价于登录态：权限 600，不进 git、不外发。
