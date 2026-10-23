# dsh-review-desk

把 DSH Web UI 放到一个**私有 Win32 桌面**：需要复验时切过去，平时主桌面完全不受影响。

## 当前范围（0.2.0）

- `prepare`（helper 的 `ensure`）：**只在后台**创建/复用私有桌面，启动 Edge app 模式到 DSH Web UI，并在桌面内放一个“返回工作桌面”panel；**不切屏**；
- `open`：显式切到复验桌面；只能由用户主动调用，不放在任何自动流程里；
- `return`：切回默认桌面，并尽量恢复原前台窗口；
- `close`：切回默认桌面，结束 Edge/panel，删除 Edge profile；
- `status`：查看当前活动桌面和进程；
- `watchdog`：定时兜底切回默认桌面；
- Host 命令：`/review-desk prepare|open|return|close|status|list|show <turn>`；默认 `status`，不会切屏；
- 复验记录：观察 `session/event`，在 `turn/end` 生成 packet；`list` 看最近记录，`show` 看单条 JSON；默认不保存工具参数值，只保存 key。

这不是 Windows 11 虚拟桌面：私有桌面没有 Explorer 任务栏，也不在 `Win+Tab` 里；它是 UI 隔离，不是安全沙箱。

## 模块

- `lib/review.js`：`ReviewStore`，从 `session/event` 生成复验包；只存工具 key，不存参数值/输出；
- `lib/audit.js`：`AuditLog`，JSONL 记录 prepare/open/return/close，2 MB 滚动；
- `lib/index.js`：Host 插件、命令、helper 生命周期、服务 `reviewDesk`。

`workspace/changes` 只带 turn；文件列表在 `turn/end` 用 `ctx.workspaceChanges.summary(sessionId, seq)` 取。summary 没有“新增/修改/删除”状态，只有 `path/display/added/deleted`，所以复验包也不伪造。

## 安装

先退出 DeepSeekRuntime（pnpm 会改写 profile 的 `node_modules`），再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本只改 profile 的 `package.json`（`file:` 依赖 + `dsh.profile.bundles`），不会动 `cordis.patch.yml`。装完重启 DeepSeekRuntime，在会话里用：

```text
/review-desk prepare
/review-desk list
```

## 构建 helper

需要 .NET Framework 4.8 的 `csc.exe`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-helper.ps1
```

输出：`bin\DshReviewDesktop.exe`。

## 测试 helper

```powershell
$h = ".\bin\DshReviewDesktop.exe"
$state = "$PWD\.state.txt"
# 后台准备：不切屏
& $h ensure --desktop DSH-Test-Desk --url http://127.0.0.1:52685 --state $state
& $h status --state $state
# 显式进入：会切屏
& $h open --desktop DSH-Test-Desk --url http://127.0.0.1:52685 --state $state
& $h return --state $state
& $h close --state $state
```

`open` 会真的切桌面；测试前建议另开一个 `watchdog --seconds 15` 兜底。

## 已知限制

- 焦点恢复是 best-effort：`SwitchDesktop` 本身不保证恢复原前台窗口，helper 会调用 `SetForegroundWindow`；
- Edge 和 panel 用 `taskkill /T /F` 清理，不是 Job Object；后续会换成 Job Object + PID 树 fallback；
- 多显示器 / DPI / RDP / 全屏 / 锁屏尚未验证；
- 私有桌面没有任务栏，panel 是唯一可见的返回入口；全局快捷键尚未接入 Host。
