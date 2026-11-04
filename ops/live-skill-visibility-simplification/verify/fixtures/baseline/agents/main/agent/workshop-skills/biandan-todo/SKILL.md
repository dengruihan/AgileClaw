---
name: "biandan-todo"
description: '在便单（biandangroup.com，数据存华为云空间）上执行用户明确点名的便单操作：添加或批量写入待办并按日期核对（"把X加到我待办"）、查某天有什么待办、调整四象限优先级、勾选完成，以及登录态失效后的重新授权（默认共享浏览器，备选扫码 / 密码+短信，见「登录」节）。统一事项收集、优先级判断与完成同步的主入口是 schedule-sweep（agenda 主清单）——常规"加待办/排优先级"先走那里，用户明确要求写便单本身时才进本 skill。云谷作业走 yungu-tasks，OSH 作业走 oneschoolhouse-tasks。'
platforms: [linux]
---

# 便单待办操作

写入 → 按日期核对的全流程已在真实账户上跑通（2026-10-15，14 条批量
写入逐日核对命中）。脚本在 `~/.openclaw/workspace/scripts/biandan/`：**shared-add（写入口**，
`BD_TODOS='[{"title":..,"y":..,"m":..,"d":..,"quadrant":"重要但不紧急"}]' node biandan-shared-add.mjs`，
补建缺项、设置 quadrant 并刷新后逐条核对）/ probe-shared（按日视图列现有待办，写入前查重）/
verify（不传清单仅查登录；传 BD_TODOS 逐条核对）/ sms-shared（登录，默认）/ qr；
add-todo / batch-add / login / sms 为旧无头版，仅当 state.json 出自无头
自身登录时可用。先按「登录」节拿到有效会话，再进写入流程。

## 登录（state.json 失效时才走；默认共享浏览器）

登录态 `~/.biandan/state.json`（600）：先直接试跑，失效再登录，别主动
重登。实测有效期约半天，隔夜大概率要重新授权。从共享浏览器导出的
storageState 在无头新上下文里不能通过登录（login-layer 仍盖上）；
state.json 只对「无头流程自己登录产生」的导出可信。

- **路 A 共享浏览器（默认）**：便单页面常开在共享浏览器（CDP
  127.0.0.1:18800）。跑 `biandan-sms-shared.mjs`（attach CDP，不新开实例，
  结尾必须 process.exit(0)）。找便单页必须按 URL hostname
  （biandangroup.com）匹配——OAuth 页的 redirect_uri 带 biandan_online，
  子串匹配会误认成 OAuth 页，下一步找 app frame 就报 no-app-frame。
  **已登录判定必须 two-check**：
  `[aria-label="新建"]` 可见 **且** `.login-layer.is-visible` 不存在
  ——登录浮层底下 `[新建]` 照样 isVisible，单查 marker 会误报已登录。
  共享 profile 的华为 OAuth 页是英文（无头新上下文才是中文），选择器必须
  走 CSS 类：账号 `input.userAccount`、密码 `input.hwid-input-pwd`、
  提交 `div.hwid-btn.hwid-btn-primary.hwid-login-btn`（不是 <button>；
  中文 `text=授权并登录` 在英文页静默匹配不到，点击循环空跑后脚本仍会
  打 submitted 日志——以页面状态变化确认点击生效）。首次在未信任浏览器
  登录，点提交即自动把验证码发到 owner 的华为设备（无需再点获取验证码）。
  码文件 `/tmp/bd-sms-code2.txt`，仅成功时写 state.json。
  **全链路一个脚本跑完**（填表→提交→自动发码→等码→逐键填码→确定→
  TRUST→等回跳，机器速度衔接）；跨脚本分步衔接会把 OAuth 会话拖到过期
  （This page has expired 0302094——验证码本身已被接受，作废的是流程）。
  验证通过后弹「Trust this browser?」：点 **TRUST**
  （`div.hwid-btn.dialog-btn.hwid-btn-primary`；`.hwid-trust-later` 是
  拒绝），信任即时登记在华为侧，流程随即过期也能在紧接着的重试免码直回。
  但**信任不保证长期有效**：同日数小时后重登可能再次要求密码+短信
  （2026-10-19 09:55 登记、16:04 重登页面即示 You have not trusted
  this browser）——按两条路准备，sms-shared 全链路本就覆盖密码+短信。
  `biandan-sms-shared.mjs` 已全链路：CSS 选择器登录、启动自动清理残留
  OAuth 标签页（旧页验证弹层会盖住登录按钮——按钮可见但点击 30s 超时）、
  验证通过自动点 TRUST。直接跑，等 owner 回码写 /tmp/bd-sms-code2.txt。
- **路 B 无头扫码（共享授权也失效时）**：后台跑 `biandan-qr.mjs`（窗口约
  30 分钟，二维码失效自动刷新），把 /tmp/bd-qr.png 发 owner 扫「设置→
  华为账号→扫一扫」，脚本检测到回跳自动存 state。
- **密码+短信凭据**：密钥库 `BIANDAN_ACCOUNT` / `BIANDAN_PASSWORD`，
  注入必须 `secrets store get <NAME> --plain`（裸 get 返回 dotenv 前缀，
  会连着填进账号框报「账号或密码错误」）。禁止用 `secrets store list`
  查凭据——它把 env 类型的值明文打印进会话上下文。
- **短信码规则**：码绑定当前浏览器会话，跨会话无效；owner 把码发进聊天，
  agent 写入码文件（3s 轮询取走并提交；等待窗口 8 分钟，超时需整个重跑）。
  多次重试会连发多条码，旧流程标签页被清理后其码即作废（旧码提交报
  「code does not exist or has expired」）——要 owner 回**最新一条**，
  并注明发出时间让其核对。
- **分格输入坑**：验证码框是 6 个 `input.hwid-input[type=tel]` 分格，
  必须点第一格后 `keyboard.type` 逐键输入；safeSet 全填第一格会让确认键
  （`div.dialog-btn.btn-next`，填满前带 `hwid-disabled`）一直置灰。
- **重登前清场**：先 kill 旧 sms 登录进程并 rm 码文件，否则新旧会话抢
  同一个码文件。
- **state.json 覆写陷阱**：旧 `biandan-login.mjs` / `biandan-sms.mjs`
  退出前会覆写 state.json（含未登录成功的运行）；失败后别信文件存在，
  用前实测页面。

## 四象限优先级调整

统一优先级与排程归 schedule-sweep（agenda 主清单）；本节只在用户明确要求调整便单条目的四象限时使用。
判断某条该进哪个象限读 `~/.openclaw/workspace/scripts/biandan/priority-workflow.md`
（四象限判断、升降级、完成口径）；既有待办也必须协调，不能只处理新事项或作业；无日期的个人项目、证书、申请协同和兴趣待办也纳入完整盘点。
无日期项明确使用 date:null，不为修改优先级强加日期；报告须区分已评估不变与未评估，批次核验不等于全清单覆盖。

入口：待办右侧 `代办操作` → `编辑` → `选择四象限` → 选择中文四象限 → `保存代办`。
现有事项按完整标题和实际所在日期传 `quadrant`，运行 shared-add 的 `--priority-only` 模式；
该模式不新建。无日期项传 `{"title":"完整标题","date":null,"quadrant":"重要但不紧急"}`，不传 y/m/d；只编辑现有条目并保持无日期。批量成功必须 requested=verified 且每条 ok=true；写入后刷新再逐条打开编辑器
核对 aria-checked=true 对应象限。失败或歧义不冒充成功，不清空未成功队列。
verify 不带 BD_TODOS 时只是 session-only 登录探针，不是任务同步证明。
日期视图点击日期格可能直接关闭；若浮层仍有「确定」再点击。

## 勾选完成

完成状态的主记录在 agenda（schedule-sweep「完成与提交」），例行巡检不再登录便单做完成同步；
仅当用户明确要求把某条在便单上勾掉时执行本节。

共享浏览器定位实际日期视图（无日期项保持无日期），用完整标题找到唯一条目并检查当前状态：
已经完成则不重复切换；未完成才点击该条的 `[aria-label="完成待办"]`。
刷新后由 agent 读取该条完成状态，确认保存生效；不改标题、日期、四象限，不删除，不反向取消完成。
同日同名多条先向用户确认是哪条；写回失败如实报告并重试，不冒充成功。
现有 shared-add/verify 脚本面向新增与四象限；完成操作使用上述共享浏览器界面，不虚构脚本的 --complete 参数。

## 写入一条待办

默认一条命令：`BD_TODOS='[{"title":..,"y":2026,"m":..,"d":..,"quadrant":"重要但不紧急"}]'
node scripts/biandan/biandan-shared-add.mjs`（attach 共享浏览器，批量写+
按日核对）。下列选择器是手工兜底/改脚本时的同一套；headless +
storageState（`biandan-add-todo.mjs`）只在 state.json 来自无头自身登录时
可用。

1. 开 `https://www.biandangroup.com/#/biandan_online`，等 ~8s，从
   `p.frames()` 取 URL 含 `biandan_online` 的 app frame。
2. 点 `[aria-label="新建"]`——按钮只有 ＋ 图标，`has-text("新建")`
   匹配不到（aria-label 不算 text），裸找会 30s 超时。
3. `input.composer-title-input` 填标题（fill 可用，无凭据）。
4. 点 `button.composer-date-button` 开日历浮层（全屏，不是内联控件）：
   - `.date-picker-title` 显示「YYYY / M」；`button.date-nav-button`
     nth(1)=上一月、nth(2)=下一月；
   - 日期格用 evaluate 找坐标后 `p.mouse.click`：格子的 textContent
     对「今天」带「今」字（如「15今」），用 `^15(今[天]?)?$` 这类正则，
     `=== "15"` 会找不到（实测两次失败都在这）；
   - 选择日期后若仍显示「确定」则点击；日期视图可能直接切换并关闭浮层。
5. 点 `button.composer-submit-button` 提交。

## 核对（不能只扫一遍 innerText）

列表视图按 date-title 选中的日期过滤。逐日期用完整标题定位唯一 task-row，核对其日期，
重新打开编辑器读取实际四象限。不能以整页 innerText、总计数或同日其他条目替代这条的结果。
核对指定任务须向 verify 传完整 BD_TODOS；它复用 biandan-browser 的同一实现。

## 日期语义（实测）

- 日期 = 日程起点（0:00 → 当日 23:59）。
- 无日期的待办在每个日期视图都显示；**带日期（单日）的条目只出现在自己
  日期的视图**，更早/更晚视图都不显示（2026-10-19 逐视图实测：10/18
  逾期未完成项不出现在 10/19 视图；10/20–10/24 的项不出现在 10/25 视图）。
  旧的「更晚视图仍显示」观察来自跨多日范围条目（标「10/13 0:00 > 今天
  23:59」），不适用于单日条目。
- 推论：默认打开的「今天」视图只有无日期+当天条目——未来日期写入的作业
  在「今天」看不到是产品行为而非丢失，查漏必须逐日期视图 probe。
- 逾期写入：直接导航到过去月份写入即可（如 9/23），红色显示在
  「已过期」组——这是如实状态，不要改写成今天。

## 边界

- 登录态与待办内容属用户隐私：不进群聊、不外发。
- 便单无通用批量导入（其「导入」只是设备备份恢复）；批量走 shared-add
  循环 UI，约 10s/条。
- 写入/核对产出属任务结果；每日类待办（如体重）的定时自动创建是 cron
  决策，先问 owner 再建。

完成标准：所有请求逐条核对完整标题、日期、四象限；修改后刷新重读仍一致。任一缺失、歧义、保存失败或象限不符均返回 ok=false 和非零退出码。
