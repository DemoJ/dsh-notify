# dsh-notify

DSH（DeepSeek Harness）Host 插件：**需要你介入、或一轮跑完时，主动弹系统通知。**
切去做别的事也不会错过审批、提问和结果。

> Windows 走 WinRT Toast，macOS 走 `osascript`，Linux 走 `notify-send`。
> 通知**标题只说状态**，细节进正文——扫一眼就知道要不要过去。

---

## 通知格式

| 场景 | 标题 | 正文 |
| --- | --- | --- |
| 工具需要用户审批 | `⚠️ 需要审批` | `需要审批：工具「××」正在等待你的授权 — 原因` |
| 被沙箱/审批/权限规则拒绝 | `⚠️ 权限问题` | `权限问题：工具「××」执行被拒绝 — 原因` |
| 工具在等你回答问题 | `❓ 需要回答` | `需要回答：问题正文（共 N 个问题）` |
| 任务完成（Agent 转为 idle） | `✅ 任务完成` | `任务完成：本轮处理已结束` |

「原因」会被归纳成中文，例如 `沙箱拒绝（workspace-write 模式）`、`提权审批被拒绝`、
`你拒绝了这次操作`、`审批被取消，操作未执行`、`没有可用的审批通道，操作未执行`。
审批没有原因时不会留一个悬空的破折号。

非正常结束的轮次有各自的状态标题，**不会谎报成"完成"**：

| 结束原因 | 标题 | 正文 |
| --- | --- | --- |
| `error` | `❌ 任务出错` | `任务出错：本轮处理异常结束 — 原因` |
| `aborted` / `interrupted` | `⏹️ 任务已中止` | `任务已中止：本轮处理被中断` |
| `blocked` | `⛔ 任务被阻止` | `任务被阻止：本轮处理被策略阻止` |
| `max-tokens` | `⚠️ 达到输出上限` | `达到输出上限：本轮处理被截断` |

## 触发时机分别监听哪个事件

| 时机 | 事件 |
| --- | --- |
| 等审批 / 审批落地 | `approval/request`（含 `next()` 的返回值） |
| 被沙箱或提权拒绝 | `tools/result` 的失败结果 |
| 等你回答问题 | `user-questions/request` |
| 任务完成 | `agent/status` 的 `running → idle` |

两个容易踩的点：

- **`ask_user_question` 不产生审批事件。** 它走的是 `user-questions/request`，和
  `approval/request` 完全不是一回事；而且提问期间 Agent 仍是 `running`，
  所以「任务完成」也不会覆盖这一段，必须单独监听。
- **完成用 `idle` 而不是 `turn/end`。** `turn/end` 只代表"这一轮关了"，
  goal 自动续轮时它一轮一条、而那时 agent 还在干活；`idle` 才真正等于
  "驱动已停下、在等你"。`turn/end` 在这里只负责记账（轮次号与结束原因），
  供 `idle` 时取用一次。

只认**真实的** `running → idle` 转换：既不会在装载时对着一个本来就 idle 的 agent
补发，也不会因 idle 被重复广播而连发。子代理（subagent）的轮次由
`rootSessionsOnly` 过滤。

## 设计约束

- **只观察，不干预。** 所有 hook 都原样透传流水线返回值，插件不参与任何决策，
  也不写会话状态。
- **不 inject 任何 Service。** 五个事件都是 Host 全局广播，插件只 `import`
  Node 内置模块 + schemastery，因此装载顺序不会成为失败点。
- **通知失败绝不影响对话。** 发送全程包在 try/catch 里；即使 `powershell.exe`
  起不来，工具调用和模型回复也照常。
- **去重。** 同一 `callId` 在 `dedupeWindowMs`（默认 1500ms）内只通知一次。
  注意"⚠️ 需要审批"和随后的"⚠️ 权限问题"是**两条不同的状态通知**，不是重复。

---

## 安装

### 前置条件

- DSH 桌面版（`%LOCALAPPDATA%\Programs\DeepSeek Harness`），profile 位于
  `~/.dsh/profiles/desktop`（下面用 `$PROFILE` 指代你实际在用的那个）。
- 用 Git Bash / PowerShell 都行；下面给 PowerShell。

### 第 1 步：克隆到 profile 目录下

```powershell
$PROFILE = "$env:USERPROFILE\.dsh\profiles\desktop"
$PLUGIN  = "$PROFILE\plugins\dsh-notify"

New-Item -ItemType Directory -Force -Path "$PROFILE\plugins" | Out-Null
git clone https://github.com/DemoJ/dsh-notify.git $PLUGIN
```

> **为什么要放在 profile 目录下面？**
> 插件 `import` 了 `@deepseek-ai/schemastery`（用来导出配置校验 schema）。
> Node 解析软链接时会先取 realpath，再从**源码目录**向上找 `node_modules`。
> profile 是 pnpm 的 `hoisted` 布局，`$PROFILE\node_modules\@deepseek-ai\schemastery`
> 本来就在；把插件放在 profile 下面，向上查找自然命中，**一个联接都不用建**。
> 如果你非要克隆到别处，见文末「克隆到任意位置」。

### 第 2 步：让 loader 能用包名解析到它

```powershell
New-Item -ItemType Junction -Path "$PROFILE\node_modules\dsh-notify" -Target $PLUGIN
```

### 第 3 步：在 patch 层挂载

编辑 `$PROFILE\cordis.patch.yml`，在末尾追加：

```yaml
- insert:
    - id: dsh-notify
      name: 'dsh-notify'
      config:
        debug: true
```

`id` 建议显式写：不写的话这条会是个匿名 hash，插件管理器无法寻址。

**这一步改完是热生效的，不用重启。** 保存后几秒内插件就会挂上（可以在
「设置 → 插件清单」里看到 `include:dsh-notify`，或者查下面的验证方法）。

### 第 4 步（推荐）：写进 profile manifest，避免被 pnpm 剪掉

`node_modules` 里的联接是手工建的，将来在这个 profile 里跑 `pnpm install`
时可能被当成多余条目清掉。把依赖正式声明一下就不会：

`$PROFILE\package.json` 的 `dependencies` 里加一行：

```json
"dsh-notify": "link:C:/Users/你的用户名/.dsh/profiles/desktop/plugins/dsh-notify"
```

`$PROFILE\pnpm-lock.yaml` 的 `importers.` → `dependencies:` 下加对应三条
（照抄同文件里其他 `link:` 条目的格式）：

```yaml
      dsh-notify:
        specifier: link:C:/Users/你的用户名/.dsh/profiles/desktop/plugins/dsh-notify
        version: link:../../plugins/dsh-notify
```

两个文件必须一致，否则将来 `pnpm install --frozen-lockfile` 会失败。

### 验证装好了

```powershell
# 1) 模块能否从 profile 解析
node -e "import('dsh-notify').then(m => console.log(m.name, m.Config({}).questions))"
#    期望输出: dsh-notify true

# 2) 宿主真的挂上了
#    设置 → 插件清单，应能看到 include:dsh-notify 且 fiberPhase = active

# 3) 端到端弹一条真通知
node "$PLUGIN\test\toast-probe.mjs"
```

---

## 更新

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-notify"
git pull
```

拉完以后**要做什么，取决于改了什么**——这里有个必须知道的坑：

| 改了什么 | 生效方式 |
| --- | --- |
| `cordis.patch.yml` 里的 `config` | **热生效**，不用重启 |
| `lib/*.js`（插件代码） | **必须重启 DSH** |
| `lib/toast.ps1` | 下次通知就生效（每次都是新进程） |

**为什么 `.js` 要重启**：Host 用的是 Node 的 ESM 模块缓存，**同一个文件路径只求值
一次**，进程活着就一直复用旧模块。实测过：改完源码后即使改 `cordis.patch.yml`
让整棵 loader 树重新 reconcile（连其他插件条目的 hash id 都变了），本插件的
Config schema 仍然显示旧字段——证明拿到的是缓存里的同一个 module 实例。

> 顺带一个技巧：如果你**同时改变了插件的路径**（比如换了克隆位置），
> 解析出的 URL 变了就会自然重新 import，那一次不用重启。

重启方式：关掉 DeepSeek Harness 再打开。会话是持久化的，会照常恢复。

---

## 卸载

```powershell
$PROFILE = "$env:USERPROFILE\.dsh\profiles\desktop"
$PLUGIN  = "$PROFILE\plugins\dsh-notify"

# 1) 从 patch 层摘掉：编辑 $PROFILE\cordis.patch.yml，删掉那段 - insert:（含 dsh-notify）
#    保存后立即生效（fiber 会被 dispose，不再有任何监听器）

# 2) 删掉 manifest 声明（如果你做过第 4 步）
#    从 $PROFILE\package.json 的 dependencies 和 $PROFILE\pnpm-lock.yaml 的
#    importers.dependencies 里各删掉 dsh-notify 那几行，保持两个文件一致

# 3) 删联接 —— 必须用 rmdir，不能用 Remove-Item -Recurse
cmd /c rmdir "$PROFILE\node_modules\dsh-notify"

# 4) 删源码
Remove-Item $PLUGIN -Recurse -Force
```

> ⚠️ **删联接一定要用 `cmd /c rmdir`。**
> `Remove-Item -Recurse` 会**顺着链接递归进去**，把目标目录的内容删掉。
> 如果你按「克隆到任意位置」的方式装了、并且在插件目录里建过指向
> `$PROFILE\node_modules\@deepseek-ai\` 的联接，用 `Remove-Item -Recurse`
> 会直接把 profile 里的 schemastery 和 cordis 删掉，整个 DSH 都起不来。
> `rmdir` 只摘链接本身，不碰目标。

之后重启一次 DSH 即可（`lib/*.js` 已在内存里的那份会随进程消失）。

---

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `approvals` | `true` | 工具开始等审批时通知 |
| `approvalOutcomes` | `true` | 审批结果为拒绝/取消/无通道时补一条「权限问题」 |
| `denials` | `true` | 被沙箱拒绝或被拒绝提权时通知 |
| `questions` | `true` | 工具在等你回答（`ask_user_question`）时通知 |
| `completion` | `true` | Agent 转为 idle（本轮处理结束）时通知 |
| `rootSessionsOnly` | `true` | 只通知主会话，忽略子代理自己的轮次 |
| `minTurnMs` | `0` | 短于该时长的轮次不通知；`0` = 每轮都通知 |
| `backend` | `auto` | `auto` / `toast` / `log`（`log` 只打印，用来排查） |
| `appId` | `com.deepseek.dsh` | Windows 通知的 AUMID，见下方说明 |
| `sound` | `true` | 是否播放提示音 |
| `dedupeWindowMs` | `1500` | 同一事件去重窗口 |
| `bodyPreviewChars` | `0` | 完成通知正文里附上回答预览的字符数。**默认 0，正文严格是约定文案**；设成 90 会变成 `任务完成：本轮处理已结束 — <回答开头>` |
| `debug` | `false` | 把每次通知追加写入 `~/.dsh/dsh-notify.log` |

需要人做决定的（审批、权限、提问）用 `duration="long"`，横幅停留久一点；
完成通知用默认时长。

### 关于 `appId`

Windows 只显示**已注册的 AppUserModelID** 对应的通知。默认值 `com.deepseek.dsh`
是 DeepSeek Harness 桌面版注册的，所以通知会带着 DSH 的名字和图标出现。

未经注册的 AUMID（比如 `Microsoft.Windows.PowerShell`）会被 Windows **静默丢弃**
——`Show()` 返回成功，屏幕上什么都不会出现。如果你不用桌面版、或想换成自己的应用，
请把 `appId` 改成一个在「开始菜单快捷方式」里有对应项的名字。

---

## 自测

```powershell
node test/harness.mjs      # 假的 ctx 驱动全部触发条件，逐条断言通知文案
node test/toast-probe.mjs  # 真的发一条通知，验证端到端通道
```

`test/harness.mjs` 全部用 `backend: 'log'`，不会弹任何东西，可以放心跑。
它覆盖 19 条断言：文案格式、去重、无原因时不留破折号、沙箱模式解析、
普通失败不误报、idle 才触发完成、首次即 idle 不补发、子代理过滤、
forked 不通知、提问文案、答案原样透传、畸形输入健壮性。

---

## 关于「设置 → 插件」列表

**它会以 bundle 的身份出现**（`package.json` 里声明了 `dsh.bundle.patch`，
所以 dsh 启动时会把它当成一个 profile 层加载）。

但要注意这个页面是**配置界面**，不是运行时插件注册表：渲染的行来自客户端半边
注册的 `plugins.item` slot（`dsh-client-ui-settings-*` 那一批）。本插件是**纯 Host
插件**，没有 `dsh.client`，所以除了 bundle 那一栏之外不会有额外的配置行。

要确认它在跑，看「插件清单」页（应能看到 `include:dsh-notify` 且
`fiberPhase = active`），或用上面的验证方法。

## 排查：启动时报 `cannot resolve profile bundle`

这个报错来自 `dsh-app-boot` 的 `resolveBundleDir()`——它遍历 `dsh.profile.bundles`，
对每一项按 Node 的 node_modules 查找顺序探 `package.json`，全都找不到就抛这个错，
该 bundle 会被记进 `skippedBundles` 并显示成异常。

按顺序检查：

1. **源码目录还在吗？** `Test-Path "$PLUGIN\package.json"`。
   源码被删/被移动（比如放在会被清理的临时目录里）是最常见的原因。
2. **`$PROFILE\node_modules\dsh-notify` 联接透过能读到 package.json 吗？**
   ```powershell
   Test-Path "$PROFILE\node_modules\dsh-notify\package.json"   # 必须是 True
   ```
   注意 `Test-Path` 只测目录**会返回 True 也说不定**——一个指向空目录的悬空联接
   里没有任何东西，必须连 `package.json` 一起测。
3. **`dsh.bundle.patch` 指向的文件在吗？** 见仓库根的 `cordis.patch.yml`。
4. 不重启就能验证 bundle 层是否正常（跑的就是 dsh 自己的启动逻辑）：
   ```powershell
   $DSH = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
   node -e "const{join}=require('node:path'),{pathToFileURL}=require('node:url');(async()=>{const m=await import(pathToFileURL(join(process.env.DSH,'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);const x=await m.loadProfileDirectory('dsh', join(process.env.USERPROFILE,'.dsh/profiles/desktop'), join(process.env.DSH,'package.json'));console.log('skipped:', JSON.stringify(x.skippedBundles ?? []));})()"
   ```
   `skipped: []` 就说明启动时不会再有 bundle 报错。

## 两个踩过的 Windows 坑

改 `lib/toast.ps1` 之前请先读：

1. **`ContentType=WindowsRuntime` 中间不能有空格。** 写成
   `ContentType = WindowsRuntime` 会让类型解析静默失败，随后 `New-Object` 报
   `Cannot find type [Windows.UI.Notifications.ToastNotification]`。
   注意本文件中其他类型加载写成 `ContentType=WindowsRuntime` 是有意的，不要"顺手格式化"。
2. **必须用已注册的 AUMID**（见上方 `appId` 一节）。

标题和正文里是工具名、审批理由、错误信息等外部文本，进 XML 前统一用
`[System.Security.SecurityElement]::Escape()` 转义，所以 `&`、`<`、引号都不会把
toast 打挂。

## License

MIT
