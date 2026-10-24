# 架构

## 目标

让 DSH 的长时间任务在后台推进，用户需要复验时再进入一个独立的私有桌面；平时当前桌面不被切走、不被抢焦点。

## 非目标

- 不实现 Windows 11 虚拟桌面；
- 不启动第二个带 GUI/Web 的 DSH 实例；`task` 只启动一次性 headless worker；
- 不移动 DSH 的 Electron 窗口；
- 不做安全沙箱或权限隔离；
- 不保证硬实时、CPU/GPU 隔离。

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| Host 插件 | `lib/index.js` | 命令、配置、helper 生命周期、Host 服务 |
| `ReviewStore` | `lib/review.js` | 从 `session/event` 生成复验包，内存队列 |
| `AuditLog` | `lib/audit.js` | JSONL 动作审计，2 MB 滚动 |
| Native helper | `helper/DshReviewDesktop.cs` | 桌面创建/切换/关闭、Edge/panel、任务进程、短路径、WMI 进程识别 |
| Edge app mode | 外部进程 | 加载 DSH Web UI |
| Headless worker | `DeepSeekRuntime.exe` + 独立 profile | 一次完整 Agent 任务，运行在私有桌面 |
| Return panel | helper 内 WinForms | 私有桌面内唯一的可见返回入口 |

## 启动与准备

`prepare`（helper 的 `ensure`）：

1. 解析 `url`：配置优先，否则 `ctx.get("webServer").getOrigin()`；
2. helper 用 `CreateDesktopW` 创建/打开 `DSH-Review-Desk`；
3. 用 `CreateProcessW` + `STARTUPINFO.lpDesktop` 启动 Edge app 模式和 panel；
4. panel 用 `CREATE_NO_WINDOW` 启动，避免继承 helper 的 stdout 管道；
5. 写入 state 文件；
6. **不调用 `SwitchDesktop`**。

`status` 应显示：

```text
active=Default
desktop=DSH-Review-Desk
browserPid=...
browserCount=...
panelPid=...
```

`active=Default` 是正确结果，不是失败。

## 任务执行

`run`（helper 的 `run`）：

1. Host 把任务写成 UTF-8 BOM 的 `.ps1`，避免 Windows PowerShell 5.1 按 ANSI 解码中文路径；
2. helper 打开/创建私有桌面，但**不切过去**；
3. 用 `CreateProcessW` + `STARTUPINFO.lpDesktop = WinSta0\DSH-Review-Desk` 启动 `powershell.exe -File <script>`；
4. stdout/stderr 通过可继承文件句柄写入任务日志，Host 读回并截断到 `runOutputLimit`；
5. 等待进程结束；超时则 `TerminateProcess` + `taskkill /T` 收进程树；
6. 返回 exit code 和输出，**不调用 `SwitchDesktop`**。

任务派生的 GUI 子进程继承私有桌面；因此 `run notepad` 不会在主桌面弹窗。

`task`（完整 Agent）：

1. Host 在 `taskHome` 下生成一个独立 profile：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + `@deepseek-ai/dsh-llm-pi-ai`；
2. profile 的 `cordis.patch.yml` 写入 provider/model/baseURL；API key 只在运行时通过环境变量注入；
3. Host 用 `cmd.exe` 的 stdin/stdout 重定向启动 `DeepSeekRuntime.exe` 的 headless 模式，任务文本从文件走 stdin；
4. 因为 `DeepSeekRuntime.exe` 是 `powershell.exe` 的子进程，它继承 `lpDesktop = WinSta0\DSH-Review-Desk`；
5. worker 只把最终答案写到 stdout；reasoning 留在 stderr；
6. 超时按进程树终止；worker 退出后 profile/会话留在独立 `DSH_HOME`，不污染当前会话。

边界：`task` 是一次性 headless Agent，不是第二个带 GUI/Web 的 DSH 实例。

## 切屏

### `open`

1. 复用已存在的桌面和 Edge；
2. 调用 `SwitchDesktop`；
3. 尽量把 Edge 置前；
4. 可选启动 `watchdog`，到点 `return`。

### `return`

1. `SwitchDesktop(Default)`；
2. `SetForegroundWindow` 恢复原前台窗口（best-effort）；
3. 不结束 Edge/panel。

### `close`

1. 先 `return` 到 Default；
2. 结束 panel；
3. 结束 tracked browser PID；
4. 用 WMI 按绝对 `--user-data-dir` 匹配所有 `msedge.exe` 子进程；
5. 重试删除 Edge profile；
6. 删除 state。

## Helper 协议

helper 是独立的 `.exe`，不是长期服务；Host 每次动作启动一次。

| 模式 | 作用 | 切屏 |
|---|---|---|
| `ensure` | 创建/复用桌面、启动 Edge/panel | 否 |
| `open` | 切到复验桌面 | 是 |
| `return` | 切回 Default | 是 |
| `close` | 返回、结束进程、删 profile/state | 先返回 |
| `status` | 打印 `k=v` 状态 | 否 |
| `run` | 在私有桌面执行 PowerShell 任务并等待 | 否 |
| `shortpath` | 把长路径逐段转成 8.3 短路径 | 否 |
| `panel` | 私有桌面内的返回 panel | 否 |
| `watchdog` | 定时兜底返回 | 是（到点） |

公共参数：

```text
--desktop <name>
--state <state.txt>
--profile <edge-profile>
--url <dsh-web-url>
--panelSeconds <n>
--edge <msedge.exe>
```

## 复验包

`ReviewStore` 消费 `session/event`：

```text
turn/start          → 建 packet
tool/call           → name / callId / step / argument keys
tool/result         → ok / error
workspace/changes   → 只记 seq
turn/end            → reason / duration / changes
```

`workspace/changes` 事件只带 `turn`；文件列表必须：

```js
ctx.workspaceChanges.summary(sessionId, seq)
```

summary 结构：

```json
{
  "turn": 3,
  "cwd": "C:/work/project",
  "files": [
    { "path": "src/a.ts", "display": "src/a.ts", "added": 12, "deleted": 3 }
  ],
  "total": 1,
  "added": 12,
  "deleted": 3
}
```

没有“新增/修改/删除”状态，也没有 `changeType`；复验包不补这个字段。summary 缺失时 `changes.state = "partial"`，`evidenceState = "partial"`。

默认：

- 只存参数 key；
- 不存参数值；
- 不存工具输出；
- 不存会话正文。

## 生命周期与失败

- 所有 helper 调用串行化，避免 `open`/`close` 交错；
- `runHelper` 监听 `exit` 并销毁 stdout/stderr，避免 panel 继承管道导致超时；
- Edge 根进程可能退出并把窗口交给子进程，因此 `browserPid` 可能为 0，但 `browserCount > 0` 仍表示桌面可用；
- `close` 删除 profile 失败时重试 3 次，仍失败则保留并报告；
- helper 日志：`%TEMP%\dsh-review-desktop.log`；
- 审计：`%LOCALAPPDATA%\dsh-review-desk\audit.jsonl`。

## 已知边界

- 私有桌面没有 Explorer 任务栏，也不在 `Win+Tab`；
- 焦点恢复 best-effort；
- 多显示器 / DPI / RDP / 全屏 / 锁屏 / UAC 未系统验证；
- 没有全局快捷键；panel 是私有桌面内唯一返回入口；
- 不是安全边界：同一用户会话内，程序仍可访问同一文件系统。
