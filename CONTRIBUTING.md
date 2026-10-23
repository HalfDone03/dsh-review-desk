# Contributing

## 开发环境

- Windows 10/11 x64；
- Node.js >= 20.3；
- .NET Framework 4.8（构建 native helper）；
- 一个可用的 DSH profile（仅集成测试需要）。

## 本地检查

```powershell
node .\scripts\check.mjs
node .\scripts\selftest.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-helper.ps1
```

不需要 `npm install`；运行时只依赖 Node 内置模块。

## 设计约束

以下行为是产品约束，不是实现细节，改动前请先开 issue：

1. `prepare` / `ensure` **绝不能**调用 `SwitchDesktop`；
2. `open` 是唯一的用户触发切屏入口，不能放进自动流程、事件回调或测试默认路径；
3. 复验包不能伪造变更类型；`workspace/changes` summary 只有 `path/display/added/deleted`；
4. 默认不保存工具参数值、工具输出、token、会话正文；
5. 私有桌面是 UI 隔离，不是安全沙箱，文档不能暗示它是安全边界；
6. `close` 先尝试返回 Default，再结束进程和删除 profile。

## 提交

- 一个 PR 只做一件事；
- 附上实际执行的命令和结果；
- 涉及 helper 的改动，请同时说明是否重新编译了 `bin/DshReviewDesktop.exe`；
- 不要提交 `state.txt`、`audit.jsonl`、Edge profile、日志。

## 报告问题

请使用 issue 模板，附：

- Windows 版本、DSH 版本、Edge 路径；
- 复现步骤；
- `%TEMP%\dsh-review-desktop.log` 的相关片段；
- 不要贴 token、cookie 或完整会话正文。
