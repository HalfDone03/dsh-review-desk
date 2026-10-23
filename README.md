# dsh-review-desk

> 把 DSH Web UI 放到一个私有 Win32 桌面：需要复验时切过去，平时主桌面完全不受影响。

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)
![node](https://img.shields.io/badge/node-%3E%3D20.3-339933)
![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-5B4BFF)
![license](https://img.shields.io/badge/license-MIT-green)
![status](https://img.shields.io/badge/status-0.2.0%20preview-orange)
[![ci](https://github.com/NewDataBag/dsh-review-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/NewDataBag/dsh-review-desk/actions/workflows/ci.yml)

---

## 解决的问题

DSH 在跑长任务时，用户仍然要在当前桌面工作。把 DSH 窗口直接切来切去，会打断输入、抢焦点，也容易误操作。

`dsh-review-desk` 不改 DSH 的 Electron 窗口，也不启动第二个 DSH 实例。它在后台创建一个**私有 Win32 桌面**，把 Edge app 模式的 DSH Web UI 放进去；只有用户显式执行 `open` 时才切过去。

## 它做什么

- `prepare`：**只在后台**创建/复用私有桌面，启动 Edge 和返回 panel，**不切屏**；
- `open`：显式切到复验桌面；这是唯一的切屏入口；
- `return`：切回默认桌面，并尽量恢复原前台窗口；
- `close`：切回默认桌面，结束 Edge/panel，删除 Edge profile；
- `status`：查看活动桌面和进程；
- `list` / `show`：查看最近复验记录；
- `audit`：查看桌面动作审计。

## 它不做什么

- 不是 Windows 11 虚拟桌面：私有桌面没有 Explorer 任务栏，也不在 `Win+Tab` 列表里；
- 不是安全沙箱：它只隔离 UI，不隔离权限、文件、网络；
- 不做硬性 CPU/GPU 隔离：资源低干扰是 best-effort；
- 不自动审批、不自动复验、不复制会话；
- 不在任何自动流程里调用 `open`。

## 快速开始

### 环境

- Windows 10/11 x64；
- DeepSeekRuntime `>= 0.2.1-rc.2`；
- Microsoft Edge（默认路径找不到时用 `edgePath` 指定）；
- 构建 helper 需要 .NET Framework 4.8 的 `csc.exe`。

### 安装

先退出 DeepSeekRuntime（pnpm 会改写 profile 的 `node_modules`），再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本只改 profile 的 `package.json`（`file:` 依赖 + `dsh.profile.bundles`），不会动 `cordis.patch.yml`。装完重启 DeepSeekRuntime。

### 使用

```text
/review-desk prepare     # 后台准备，不切屏
/review-desk list        # 看最近复验记录
/review-desk open        # 显式切到复验桌面
/review-desk return      # 切回工作桌面
/review-desk close       # 清理
```

`prepare` 后 `status` 应该显示 `active=Default`，但 `desktop=DSH-Review-Desk`、`browserPid`/`panelPid` 已存在。这就是正确状态：**桌面在后台，当前桌面没变**。

## 工作方式

![架构](docs/architecture.svg)

1. Host 插件通过 `ctx.get("webServer").getOrigin()` 拿到当前 DSH Web UI 地址；
2. `DshReviewDesktop.exe` 调用 `CreateDesktopW` 创建私有桌面；
3. 用 `CreateProcessW` + `STARTUPINFO.lpDesktop` 启动 Edge app 模式和返回 panel；
4. `SwitchDesktop` 只在 `open`/`return` 时调用；
5. Edge 进程按 `--user-data-dir` 的绝对 profile 路径通过 WMI 识别，避免 Edge 根进程退出后漏杀子进程；
6. panel 是私有桌面内唯一可见的返回入口；全局快捷键尚未接入 Host。

更细的设计见 [docs/architecture.md](docs/architecture.md)。

## 命令

| 命令 | 作用 | 是否切屏 |
|---|---|---|
| `/review-desk prepare` | 后台准备/复用复验桌面 | 否 |
| `/review-desk open` | 切到复验桌面 | 是 |
| `/review-desk return` | 切回默认桌面 | 是 |
| `/review-desk close` | 结束进程并清理 profile | 先切回 |
| `/review-desk status` | 查看活动桌面/进程 | 否 |
| `/review-desk list` | 最近 20 条复验记录 | 否 |
| `/review-desk show <turn>` | 单条复验记录 JSON | 否 |
| `/review-desk audit` | 最近 20 条审计动作 | 否 |

默认动作是 `status`。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: review-desk
  config:
    autoReturnSeconds: 30
    reviewIncludeToolArgs: false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `desktopName` | `DSH-Review-Desk` | 私有桌面名；固定名字便于接管残留 |
| `edgePath` | `""` | Edge 路径；留空自动探测 |
| `url` | `""` | DSH Web UI 地址；留空用 `webServer.getOrigin()` |
| `panelSeconds` | `0` | panel 自动返回秒数；`0` 不自动返回 |
| `autoReturnSeconds` | `0` | `open` 后 watchdog 自动返回秒数；`0` 关闭 |
| `statePath` | `""` | 状态文件；留空用 `%LOCALAPPDATA%\dsh-review-desk\state.txt` |
| `profilePath` | `""` | Edge profile；留空用状态文件同目录的 `edge-profile` |
| `helperPath` | `""` | helper 路径；留空用包内 `bin/DshReviewDesktop.exe` |
| `closeOnDispose` | `true` | 插件卸载时是否关闭复验桌面 |
| `reviewLimit` | `50` | 内存中最多保留多少条复验记录 |
| `reviewIncludeToolArgs` | `false` | 是否保存工具参数值；默认只存 key |
| `audit` | `true` | 是否写审计日志 |
| `auditPath` | `""` | 审计文件；留空用状态文件同目录的 `audit.jsonl` |
| `auditTurns` | `false` | 是否把每个 `turn/end` 写审计 |

## 复验记录

`ReviewStore` 观察 `session/event`：

- `turn/start`：建 packet；
- `tool/call`：记录工具名、callId、step、参数 key；
- `tool/result`：记录成功/失败；
- `workspace/changes`：只记 `event.seq`；
- `turn/end`：补齐结论、耗时、变更摘要。

`workspace/changes` 事件只带 `turn`，文件列表必须用 `ctx.workspaceChanges.summary(sessionId, seq)` 取。summary 只有 `path/display/added/deleted`，可能带 `binary/oversized`，**没有“新增/修改/删除”状态**，所以复验包不伪造变更类型。

摘要取不到时标 `partial`，不猜。默认不保存工具参数值、不保存工具输出，避免密钥进日志。

## 安全边界

- 私有桌面与默认桌面运行在同一个 Windows 登录会话、同一个用户权限下；
- 它防止的是“当前桌面被打断”，不是“恶意程序越权”；
- helper 以当前用户身份运行，不读 DSH 会话内容；
- 审计只记录动作、桌面名、错误摘要，不记录会话正文；
- Edge profile 在 `close` 后删除，可能包含登录 cookie；不要在不可信机器上保留；
- 不要把 `%LOCALAPPDATA%\dsh-review-desk` 提交到 Git。

## 构建 helper

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-helper.ps1
```

输出：`bin\DshReviewDesktop.exe`。

## 测试

```powershell
node .\scripts\check.mjs
node .\scripts\selftest.mjs
```

`selftest.mjs` 覆盖：

- `ReviewStore` 的 tool call/result、workspace summary、partial 降级；
- 默认不保存工具参数值；
- `AuditLog` 的追加和读取；
- `normalizeConfig` 的边界校验。

helper 手动测试：

```powershell
$h = ".\bin\DshReviewDesktop.exe"
$state = "$PWD\.state.txt"
& $h ensure --desktop DSH-Test-Desk --url http://127.0.0.1:52685 --state $state
& $h status --state $state
& $h open --desktop DSH-Test-Desk --url http://127.0.0.1:52685 --state $state
& $h return --state $state
& $h close --state $state
```

`open` 会真的切桌面；测试前另开一个 `watchdog --seconds 15` 兜底。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

只移除 profile 注册，不删用户数据。要连同状态、审计和 Edge profile 一起删：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -PurgeData
```

## 已知限制

- 焦点恢复是 best-effort：`SwitchDesktop` 本身不保证恢复原前台窗口，helper 会调用 `SetForegroundWindow`；
- Edge/panel 用 `taskkill /T /F` + WMI profile 匹配清理，不是 Job Object；后续会换成 Job Object + PID 树 fallback；
- 多显示器 / 125–200% DPI / RDP / 全屏 / 锁屏 / UAC 尚未系统验证；
- 私有桌面没有任务栏，panel 是唯一可见返回入口；全局快捷键尚未接入 Host；
- `open` 会切换当前桌面；远程会话/演示场景请谨慎使用。

## 故障排查

| 现象 | 检查 |
|---|---|
| `helper 不存在` | 运行 `scripts/build-helper.ps1`，或配置 `helperPath` |
| `没有 webServer.getOrigin()` | 在配置里填 `url` |
| Edge 没启动 | 配置 `edgePath`，确认 Edge 可执行文件存在 |
| panel 很快返回 | `panelSeconds` 是否为 `0` |
| `prepare` 后仍在当前桌面 | 这是设计行为；`prepare` 不切屏，用 `open` |
| 找不到复验记录 | 先跑完一个 turn，再 `/review-desk list` |
| 进程残留 | `/review-desk close`；仍残留时看 `%TEMP%\dsh-review-desktop.log` |

日志：

- helper：`%TEMP%\dsh-review-desktop.log`
- 审计：`%LOCALAPPDATA%\dsh-review-desk\audit.jsonl`

## 开发

```powershell
node .\scripts\check.mjs
node .\scripts\selftest.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-helper.ps1
```

提交前请确认：

- `prepare` 不调用 `SwitchDesktop`；
- 测试不自动调用 `open`；
- 不把工具参数值、token、会话正文写进审计或复验包。

## License

[MIT](LICENSE)
