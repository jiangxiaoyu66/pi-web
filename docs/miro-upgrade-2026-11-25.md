# PiWeb Miro 首次主线整理与官方升级

## 授权与恢复点

用户已明确批准：建立本地及远端 `miro/main` / `miro/dev`、提交现有定制与修复、落实 JSON 持久化、合并官方更新、验证通过后推送并切换 GitHub 默认分支、最终重启。提交身份仅在本仓库配置为 GitHub noreply 身份。

- 原始 HEAD / 官方旧基线：`28b594718e23a3a1c3653be3aaebfa8dd29e6519`，PiWeb 0.17.0 / Pi 1.5.2。
- 原工作分支：`feat/open-in-editor`；该历史分支保留，不重写。
- 私有备份：`~/.pi/backups/pi-web/20261125-100346/`，包含原代码归档、工作区补丁、Git bundle 和旧开机脚本。备份目录权限 0700，不上传 GitHub。
- 本次固定官方目标：`432366bd510c72ce7b678a6cb1220f9cac1ed56c`，PiWeb 0.18.0 / Pi 1.6.0；包含 `v0.18.0` 之后的修复。
- 隔离验证目录：`~/Documents/我的AI搭子/pi-web-worktrees/upgrade-20261125`，与正在运行的源码目录各自拥有独立 `node_modules` / `.next`。

## 定制整理

保留 URL autofocus、MCP 分类、Skills 分组及 VS Code/Cursor 入口。修复既有编辑器相关 12 项失败（I18nProvider、侧栏按钮断言与布局、zh-TW 文案），以及继承宿主密码导致的认证测试环境污染；未放宽生产认证。增加稳定启动器，拒绝非主线或未提交工作区。

`.pi/mcp.json` 和 `.pi/pi-cast/` 已加入忽略规则；这些本机配置/日志不进入提交。仅 Fork 工作流 skills 随代码保存。

分组唯一真源改为 `getAgentDir()/pi-web/mcp-categories.json`，客户端旧 localStorage 仅供条件迁移，JSON 文件不存在且旧数据非空时才尝试导入，不覆盖已有服务端文件。浏览器旧数据不会因代码升级自动找回，必须仍能在原浏览器、原 origin 访问。

## 已执行的检查

### 首次修复后的升级前基线

- 全量 `npm test`：3755 passed、0 failed、2 skipped（原有跳过），共 3757 项；日志 `/tmp/pi-web-miro-before-upstream.log`。
- `tsc --noEmit`、全仓 ESLint、`git diff --check` 通过。
- Skills 分组浏览器回归 8/8；MCP 分组初轮 9/9；编辑器入口通过两种布局、默认/最窄侧栏及桌面/手机菜单回归。此轮 MCP 结果早于独立审查补强，最终以补强后的复测为准。
- 独立审查复现并要求修正：超时锁接管后的旧写入覆盖、非法 UTF-8、孤立 Unicode 代理码元、浏览器存储不可用时的迁移恢复入口。

### 审查补强后的升级前基线

- 四项问题均已修复；分类及相邻专项 168/168、MCP 浏览器回归 10/10 通过。
- 补强后全量压力复测暴露原有 MCP host 测试的 20ms idle 与握手事件循环竞态。该文件原先与目标上游完全相同；受控复现 3/3 后，仅在测试使用受控计时，保留并补充 closed/reconnect/运行中连接断言。目标测试 20/20，完整文件重复 5 次均 62/62。
- 最终升级前全量：**3792 passed、0 failed、2 skipped**，共 3794 项；日志 `/tmp/pi-web-miro-final-before-upstream.log`。TypeScript、全仓 ESLint、diff 空白检查通过。

### 官方依赖预检（隔离工作目录）

- 八个 `@earendil-works/*` 包通过 `npm install --save-exact` 保持一致的实际 1.6.0 版本，package 与 lock 无漂移。
- SDK 内部适配、包版本约束、原子写和终端安全等 50/50 通过；TypeScript 通过。
- node-pty 原生加载及创建 PTY 通过。
- 安装报告 12 项依赖审计告警（5 low / 7 moderate）；未运行 `npm audit fix`、未擅自升级无关依赖或批准额外安装脚本。审计输出不是新增漏洞归因分析。
- 未运行 `next build`，未更新全局 npm 安装，未向真实会话、MCP 或分组文件写测试数据。

## 最终验收与部署状态

待完成审查补强、上游合并及最终回归后填写。不得将上述预检当作已完成重启验收。

重启回执保存于私有备份目录 `deployment-status.json` / `deployment.log`，不写入运行中的源码工作区。只有回执 `state: verified` 才表示新的 `miro/main` 服务已通过真实 HTTP 检查；`failed` 时看日志，不重复盲目重启。当前聊天与服务器同进程，重启会断开现有连接。

手工边界：桌面编辑器协议真实唤起、真实 OPPO 输入法仍需用户在对应设备验收，自动化不声称已覆盖。
