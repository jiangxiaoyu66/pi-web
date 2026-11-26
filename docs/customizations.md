# Fork 定制清单

分支、数据目录、启动及同步约定见 [Miro 工作流](miro-workflow.md)；本 Fork 的稳定主线是 `miro/main`，开发集成为 `miro/dev`。首次整理与 PiWeb 0.18.0 / Pi 1.6.0 升级的完整验收见 [升级记录](miro-upgrade-2026-11-25.md)：3820 项通过、0 失败、2 项原有跳过，并完成隔离真实 HTTP 重启与全部定制浏览器回归。下列各功能小节保留其阶段性专项证据，正式服务状态以部署回执为准。

## 复制会话 JSONL 文件路径

普通、置顶或归档会话行的右键 / ⋯ 菜单提供“复制 JSONL 文件路径”。复制的是服务器上**所点会话**的 `SessionInfo.path` 原值，不拼接文件名、不读取正文、不切换会话；远程浏览器得到的仍是服务器路径。未落盘的临时会话不提供此操作。

`lib/sidebar-actions.ts` 和 `components/SessionSidebar.tsx` 接入内置菜单，复用 `copyText` 和侧栏提示报告成功或失败；现有下游右键事件可替换菜单，但不能向内置菜单插入一项。[上游](https://github.com/agegr/pi-web)提供等价操作后可移除。回归：`lib/sidebar-actions.test.mjs`、`lib/clipboard.test.mjs`、`e2e/session-navigation.mjs`。

## 文件标签右键关闭

右键右侧面板的文件标签，可关闭此项、其他、左侧、右侧或全部文件标签；左右按拖动后的显示顺序判断，没有目标的项禁用。操作只移除预览，不修改磁盘文件，不关闭终端、子代理或侧聊。

扩展不能向 Web 标签栏插入菜单。`components/TabBar.tsx` 复用 `SidebarMenu`，`lib/file-tab-close.ts` 计算目标，`components/AppShell.tsx` 一次更新文件列表并沿用单项关闭的选中回退规则。回归见 `lib/file-tab-close.test.mjs`；若[上游标签栏](https://github.com/agegr/pi-web/blob/main/components/TabBar.tsx)提供等价的文件限定操作，可移除本定制。

## URL 启动时聚焦输入框

- **用法**：打开 `/?autofocus=1`，或在已有 `?cwd=…` / `?session=…` 地址后追加 `&autofocus=1`。只有值为 `1` 才启用，默认行为不变。
- **实现**：`AppShell.tsx` 在初始导航时保留参数；主 `ChatWindow.tsx` 加载完成、消息框挂载且没有扩展对话框时报告就绪，再调用现有 `ChatInputHandle.focus()`。每次页面加载只尝试一次，不在后续会话切换、轮询或手动失焦后重复聚焦；已有其他控件焦点或模态框时放弃，不抢焦点。
- **边界**：仅聚焦，不发送消息、不请求麦克风、不启动豆包语音；移动端是否弹出当前输入法由实际浏览器和系统决定，PWA 无豁免。
- **验证**：`AppShell.autofocus.test.mjs` 与原 `ChatInput.focus.test.mjs` 共 24 项通过；TypeScript 与改动文件 ESLint 通过。独立无头 Chrome 验证桌面及 393px 手机模拟下参数开/关、聚焦后直接输入、手动失焦后不重抢，均无页面错误；未使用真实 OPPO 验证软键盘。

## MCP 展示分类

- **目的**：复用现有 MCP 窗口，按项目 / 全局分层，自定义一层分类，支持折叠、新建、改名、删除和移动 Server。
- **为何不只用扩展**：扩展管理 MCP 工具，不能替代 Web 管理页列表布局；本实现不修改扩展 API 或 Pi SDK。
- **独立模块**：`lib/mcp-categories.ts`（版本化结构/增量操作）、`lib/mcp-categories-file.ts`（服务端文件）、`lib/mcp-categories-client.ts`（共享客户端）、`hooks/useMcpCategories.ts`、`components/McpCategoryList.tsx`、`app/api/mcp/categories/route.ts`。
- **接入位置**：`components/McpConfig.tsx` 的作用域列表；`SidebarMenu` 增加可选 Settings 模态层（默认行为不变）；局部样式、三语言文案及类覆盖测试。
- **数据边界**：唯一真源为 `getAgentDir()/pi-web/mcp-categories.json`，即 `$PI_CODING_AGENT_DIR/pi-web/mcp-categories.json`，默认 `~/.pi/agent/pi-web/mcp-categories.json`。这是用户明确批准的个人 fork 配置特例，不是上游 CONTRIBUTING 允许的通用方案。版本 1 保留 global / 精确 cwd 桶、分类、服务归属与折叠；不写 `mcp.json` / `settings.json`，不启停/重连 MCP。删除分类不删除 Server，外部改名视为新 Server。
- **一致性与迁移**：GET 只读；POST 增量操作经进程内队列、跨进程文件锁、锁内重读和原子替换保存。拒绝损坏/未知版本/非普通文件，不覆盖原数据；文件上限 256 KiB，请求体流式上限 512 KiB。多个浏览器通过 focus / visibility / 刷新读取同一服务端文件。读取成功前禁止操作，写失败不冒充保存成功，保留最后确认视图并提示刷新重试。旧 `pi-web:mcp-categories` 仅在服务端不存在时条件迁移；是否导入由服务端锁内判定，已有数据永不被迁移覆盖。空浏览器不创建文件占位；旧 key 原样保留备份，只在导入成功后写 `:migrated` 标记，失败可重试。损坏旧数据可手动修复，或经单独确认跳过当前页面的浏览器导入（不改备份、不创建空文件，确认前重读服务端；服务端读失败不能跳过）。确认后服务端保存/刷新不再依赖 localStorage；仍无文件时重新加载页面会再次询问。迁移标记仅作提示，不保证永不重复迁移：手动删除服务端文件后可能重新导入较旧备份。文件级符号链接被明确拒绝；文件和请求均严格 UTF-8 解码，拒绝非法字节而非替换后覆盖，所有分类字符串边界拒绝孤立代理码元。
- **验证**：本轮 node:test 分类数据/文件/API/hook 与 MCP/菜单/移动布局专项回归 **168/168 通过**，含临时目录、重建 store、独立进程重启读取、跨进程并发、SIGSTOP 超过 11 秒不接管、独立客户端、严格 UTF-8、孤立代理码元渲染回归、空/已有/损坏数据迁移与失败重试，以及 SecurityError 显式恢复。所有文件写测试隔离 `PI_CODING_AGENT_DIR`。`e2e/mcp-categories.mjs` 通过 `PI_WEB_E2E_PORT` 选择已有服务（默认 30141，base/lsof 校验同步），本轮复用 30141、source 私有 autostart 环境并使用共享认证 helper，密码环境不记录 trace，拦截所有分类及配置请求，**10/10 通过**（含 SecurityError 恢复确认按钮）：独立浏览器共享 mock 服务端、折叠重载、键盘焦点及 320/390/768/1440px 布局；浏览器错误为空。`tsc --noEmit`、`npm run lint`、`git diff --check` 通过。LSP 检查 10 个相关 TS 文件，新增错误/警告为 0；`McpConfig.tsx` 的 24 条 Next 71007 回调 props 警告已通过内存文档与 HEAD 对照确认既存，未修改其 API。
- **锁的明确取舍 / 部署要求**：分类文件使用 `proper-lockfile@4.1.2` 的 `stale: Infinity, update: 1000`（有限获取重试），禁止按时间自动接管，以免暂停写入者恢复后覆盖已成功的更新。升级包必须重验 Infinity 契约；部署必须先停止所有使用旧有限 stale 策略的写入进程，再启新版本。SIGKILL/崩溃/断电可能永久遗留 `.lock`，不是无限等待请求；请求会报 `locked`。只有在禁用自动拉起、确认所有相关实例（含暂停进程/共享主机）已退出后，才可备份原 JSON 并 `rmdir` 精确的空锁目录，不能凭 mtime 或默认 `check()` 判死锁，也不能递归删锁或删 JSON。完整安全恢复步骤见 `docs/agents/mcp-settings.md`；本代理不执行停服务或清用户锁操作。
- **回归边界**：本轮未执行构建或全量 `npm test`。额外执行 `lib/i18n/registry.test.mjs` 时，当时既存 zh-TW 六个编辑器键缺失导致全语言键集合检查失败；分类键三语言对齐专项通过，无关编辑器文案由另一代理处理，最终全仓结果以主代理统一复测为准。上游合并后需重跑专项；当前只调用现有 `writePrivateFileAtomicSync`，未修改 `lib/atomic-file.ts`。
- **上游调研**：2026-11-20 对上游 Issues/PR 的分类/group 搜索因 GitHub GraphQL EOF 失败，未据此声称无同类方案或官方排期。
- **可删除条件**：上游原生提供同等作用域隔离、分类操作与安全删除、持久化能力时，移除本地分类模块及列表接入。

## 同机编辑器入口（VS Code / Cursor）

- **目的**：从当前工作目录、文件树行内按钮、文件树右键菜单、聊天中实际写入的文件标签右键菜单，以及文件预览工具栏，打开本机编辑器。支持 VS Code 与 Cursor，首次选择后按浏览器保存偏好；右键或 Shift+F10 / 菜单键可重新选择。
- **边界**：仅通过用户操作在浏览器客户端请求 `vscode://file/…` / `cursor://file/…`。浏览器、pi-web 服务端文件与编辑器须在同一电脑；不检测安装、不执行服务端 shell、不提供远程连接，也不宣称打开成功。浏览器可能拒绝协议或要求用户许可。
- **窗口策略**：文件链接保持编辑器原有窗口定位逻辑；文件夹和工作区链接附加 `?windowId=_blank` 请求新窗口，避免替换当前项目。不增加后端接口；协议是否被具体编辑器版本遵守，仍需本机验收。
- **为何不能仅用扩展**：这些入口属于 pi-web 的文件树、侧栏、聊天标签及预览器 UI；现有扩展 UI 接口不提供这些组件的行内操作插槽。本次仅增加客户端链接，不修改 pi 扩展协议或文件访问授权。
- **接入位置**：`components/OpenInEditor.tsx` 统一选择菜单及用户激活；`lib/editor-links.ts` 统一路径解析与逐段编码；`hooks/useEditorPreference.ts` 统一偏好、同页及跨标签同步。核心接入仅在 `FileExplorer.tsx`、`SessionSidebar.tsx`、`TurnWrittenFiles.tsx`、`FileViewer.tsx`；样式在 `app/globals.css` 与 `app/sidebar.css`，文案在 `lib/i18n/messages/en.ts`、`zh-CN.ts` 与 `zh-TW.ts`。侧栏入口使用 `sidebar-tool-button`，不套用预览工具栏尺寸；下置布局八键（13px 图标、17–26px 按钮），标签布局七键（14px 图标、18px 最小按钮、4px 间距），顺序为终端、文件管理器、编辑器、上传、刷新、忽略文件、变更，下置布局另有末尾搜索。
- **路径语义**：根目录入口使用当前 `explorerCwd`（含当前 worktree），相对文件使用所属 cwd，聊天标签使用已解析的真实绝对路径，不使用显示名或回复中的任意文本。文件和目录明确区分，中文、空格、`#?%:` 单独编码。无 cwd 的相对路径、协议字符串、UNC、控制字符、无效 Unicode、越过相对 cwd 的路径禁用；删除文件的 diff 不提供有效目标。此校验只决定链接是否可构造，不证明文件存在或同机。
- **回归测试**：`lib/editor-links.test.mjs`（路径和协议）；`hooks/useEditorPreference.test.mjs`（SSR、存储不可用、偏好同步）；`components/OpenInEditor.test.mjs`（实际 hook 事件、菜单状态、目标切换、不冒泡、错误提示、五类入口接线及文案）。配合既有 `components/FileViewer.test.mjs`、`lib/turn-written-files.test.mjs` 回归预览及实际写入路径。`e2e/open-in-editor.mjs` 复用已运行的 dev server，通过独立无头 Chrome 和拦截的目录/文件/会话夹具验证真实 UI，不修改用户会话或调用模型。
- **补齐回归**：两个 FileExplorer 测试使用真实 `I18nProvider`，保留原隐藏项及链接授权断言；两种侧栏测试逐个检查所有按钮的顺序、禁用状态、侧栏样式和图标，不再用会漏掉编辑器按钮的属性顺序正则。zh-TW 补齐六个编辑器键，文案测试覆盖三语言。`web-auth.test.mjs` 在同步、可恢复的环境隔离中检查密码未设、空值和非空值，以及省略参数 / 显式 `undefined` 的环境默认语义；保留用户名、错误密码、UTF-8、冒号、非法编码及签名过期断言，不修改生产认证。
- **本轮实测**：专项 77/77、相邻文件树/会话树/i18n/认证安全回归 54/54；认证专项在外层环境密码未设、空值和夹具值三种情况下均 6/6。`tsc --noEmit --incremental false`、全仓 `npm run lint` 通过；改动的三个 TS/TSX 文件经原生 tsserver 语言服务检查，语法和语义诊断均为空。未据此宣称全量测试或 Pi 1.6.0 已验证。
- **浏览器实测**：`e2e/open-in-editor.mjs` 复用 30141，使用 `LC_ALL=en_US.UTF-8` 与服务实际环境凭据；通过共享 `local-server-auth.mjs` 在每个隔离 context 安装路由夹具前登录，不记录 trace。Chrome 两种侧栏布局各验证 260px 默认宽度及 180px 最小宽度：按钮等尺寸、图标一致、不重叠、不裁剪、菜单可用及取消后恢复焦点；保留 1440px 桌面与 375px 手机菜单、行内不冒泡、键盘/右键、下载和各类预览工具栏检查。`pageerror` 与非预期写请求均为空，截图及尺寸记录在 `/tmp/pi-web-editor-e2e/`。媒体内容是夹具，不代表解码通过；桌面协议交接、真实编辑器打开结果及聊天标签的浏览器实测仍待手工验收（聊天标签已有接线测试）。
- **上游关联**：仓库 <https://github.com/agegr/pi-web>；本轮为已批准功能的接续实现，未重复检索 Issue/PR，暂无可确认的对应上游链接，不据此断言上游没有相关计划。
- **可删除条件**：上游提供等价的五类入口、VS Code/Cursor 选择及偏好、同机协议提示、当前 cwd/worktree 与特殊字符路径处理后，删除独立模块及上述接入，改用上游实现。

### 手动验收

1. 在文件区两种布局打开根目录入口，确认首次出现两个编辑器及同机提示；取消应恢复焦点。
2. 悬停文件/目录行，检查编辑器按钮、提及和下载不重叠；Tab 聚焦能显示按钮；点击编辑器不打开预览、不折叠目录。右键、Shift+F10 和菜单键均可选择编辑器。
3. 在真实写入文件标签上右键，确认目标是实际文件而非标签名；普通点击仍打开 pi-web 预览。
4. 检查文本（含 source/preview/diff/binary）、图片、音频、视频、PDF/Word 工具栏。切换项目/worktree/文件后旧菜单不应作用于新目标。
5. 用中文、空格和 `#?%:` 文件名检查请求链接。协议请求无法自动证明桌面应用已打开；最终唤起由用户在本机确认。

## Skills 按来源与目录分组

- **目的**：按全局/项目/插件来源及目录层级展示技能，减少长列表定位成本；同名但来源不同的插件不合并。
- **边界**：展示层分组，不改变 Pi 的技能发现与执行协议；批量启停复用已有 API，仅更新状态发生变化的叶节点。
- **接入点**：`components/SkillsConfig.tsx`、`components/SkillGroupTree.tsx`、`lib/skill-grouping.ts`、`lib/skill-tree.ts`、`app/settings.css`。
- **回归**：相邻模块 Node 测试及 `e2e/skills-grouping.mjs`。本轮浏览器 8/8 检查通过，覆盖来源隔离、折叠后详情、键盘操作、批量操作互锁/部分失败提示及 1440–320px 响应式布局；没有修改真实技能文件。
- **上游关联**：以 `docs/skills-grouping-plan.md` 的调研为准；本轮合并目标尚未替代此定制。
- **可删除条件**：官方提供等价来源分组、目录层级和批量操作语义时，核对用例后再移除。

## 稳定分支启动门禁

- `bin/miro-start.sh` 只启动干净的 `miro/main`，不会自动 checkout 或拉取代码；5 项启动器测试覆盖主线、开发分支、游离 HEAD、脏工作区及依赖缺失。
- 本机 launchd 入口转调用仓库启动器，私有密码配置仍留在仓库外。
- 独立 npm 全局包不承载 Miro 的代码；详细操作与回退要求见 `docs/miro-workflow.md`。
