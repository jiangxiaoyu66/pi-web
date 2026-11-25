# PiWeb Miro：定制分支与升级流程

## 分支约定

- `miro/main`：个人定制稳定主线；日常及开机启动只使用此分支的干净工作区。
- `miro/dev`：长期开发集成分支；功能验证完成后合入 `miro/main`。
- `feat/<功能>`：可选的独立需求分支，从 `miro/dev` 分出，完成后合回。
- `sync/<版本或日期>`：从最新稳定主线分出，合并一个已确认的官方提交，验证后再合入稳定主线，并同步开发分支。
- `origin`：个人 Fork `jiangxiaoyu66/pi-web`；`upstream`：官方 `agegr/pi-web`。
- `upstream/main`：官方跟踪引用，不放个人定制。现有本地及远端 `main` 保留为官方镜像线，仅允许快进，不强推。
- 个人 Fork 的 GitHub 默认分支为 `miro/main`；历史功能分支不自动删除。
- 当前 GitHub 凭据不具备修改 Actions workflow 的权限，因此保留官方 CI（push 仅匹配 `main`，另有 pull_request），不宣称定制分支已有远端 CI；后续如需覆盖 `miro/main`、`miro/dev`、`sync/**`，先由用户补充相应授权。不会为同步创建发布标签或向官方 npm 包发布。

## 启动

```bash
cd /path/to/pi-web
bash bin/miro-start.sh --check
bash bin/miro-start.sh
```

稳定启动器拒绝非 `miro/main`、detached HEAD 或未提交工作区，不会替用户 checkout、丢弃改动、拉取代码或安装依赖。默认监听 `127.0.0.1:30141`。可信局域网可设置 `PI_WEB_HOSTNAME=0.0.0.0`，并通过私有配置设置 `PI_WEB_PASSWORD`，不要将密码写入仓库。

Miro 的 Mac 开机入口是 `~/Library/LaunchAgents/local.pi-web.plist` → `~/.local/libexec/pi-web-start.sh` → 本仓库 `bin/miro-start.sh`。本机入口负责 PATH、私有认证配置和已有端口等待；仓库入口负责稳定分支门禁。

当前仍沿用源码 `next dev` 启动模式，不是 npm 全局发行版或 production build。源码修改会触发 HMR；不要在运行目录切换开发分支来做长期开发。建议在独立 worktree 开发，使用自己的依赖目录、独立端口，避免争用 `.next/dev/lock`。本轮原地整理完成后恢复到稳定主线。

全局 `pi-web update` 只升级独立 npm 发行版，不会更新定制仓库；升级本定制版必须走下述流程。不要在活跃开发目录运行 `next build`。

## 数据目录

MCP 分组是个人 Fork 的明确特例，不修改 Pi 扩展协议，也不作为提交给上游的新配置标准：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-web/mcp-categories.json
```

默认实际路径为 `~/.pi/agent/pi-web/mcp-categories.json`。全局与项目分组都在此文件，项目按 cwd 隔离。实际连接配置仍在原有 `mcp.json`，不会因分类增删而启停服务。

浏览器 localStorage 的 `pi-web:mcp-categories` 仅作为旧数据迁移来源；没有旧浏览器数据时不能自动恢复此前的分类。服务端文件不存在且旧数据非空时条件导入，不覆盖已有服务端配置；原浏览器数据保留备份。以后同一服务的浏览器/地址共享文件内容，刷新或重新聚焦后读取最新数据。

`.pi/mcp.json`、`.pi/pi-cast/`、私有环境文件与运行数据不上传 GitHub；`.pi/skills/` 中的 Fork 工作流规范可以跟随代码版本管理。

## 一次升级的检查点

1. 记录当前定制 HEAD、官方旧基线、依赖版本、工作区状态；保存仓库外备份，排除密钥后再提交。
2. 在 `miro/dev` 完成定制和测试，验证通过才合入 `miro/main`。保留一份升级前的稳定提交。
3. `git fetch upstream`，区分发布标签与最新 main；选择并固定目标 SHA，不让实施过程跟随新提交漂移。
4. 从 `miro/main` 建 `sync/<版本或日期>`，merge 目标 SHA，不 rebase 已共享的定制历史；逐项检查定制语义，不只看文本冲突。
5. 检查安装脚本后按官方 lock 安装；如有 Pi 升级，所有 `@earendil-works/*` 包保持一致的精确版本。运行 pin/SDK 内部适配测试。
6. 运行完整 Node 测试、TypeScript、ESLint、定制浏览器回归和隔离目录持久化测试。不向真实 MCP、会话或分组文件写测试数据。
7. 记录结果、已知限制和回退点；获准后合入并推送 `miro/main`，同步 `miro/dev`。官方镜像 `main` 仅快进到已经验证的目标。
8. 在干净的 `miro/main` 重启已有服务，检查页面、API、日志及实际依赖版本。当前聊天可能随服务重启中断，重启前将进度写入交接记录。

## 本次迁移起点（2026-11-25）

- 原工作分支：`feat/open-in-editor`，HEAD `28b594718e23a3a1c3653be3aaebfa8dd29e6519`；大量定制此前未提交。
- 原版本：PiWeb `0.17.0` / Pi SDK `1.5.2`。
- 原始代码、工作区补丁与 Git bundle：`~/.pi/backups/pi-web/20261125-100346/`；包含本机数据的备份保持私有，不上传。
- 本次候选官方目标：`432366bd510c72ce7b678a6cb1220f9cac1ed56c`，包版本 `0.18.0` / Pi SDK `1.6.0`；它包含 `v0.18.0` 发布标签之后的修复，不能与 npm 发布包视为完全相同代码。
- 最终提交、测试及重启验收另记于 `docs/miro-upgrade-2026-11-25.md`；本文件中的流程描述不代表这些步骤已经完成。
