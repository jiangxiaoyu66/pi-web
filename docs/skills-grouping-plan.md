# 技能窗口层级分组方案

状态：用户批准后已实施，未提交。源码基线：本仓库声明及本机安装的 Pi SDK 均为 1.5.2。

## 范围

只改现有「技能」窗口左侧列表，不新增入口、窗口或独立管理系统。右侧详情、安装、更新和技能加载保持现状。

```text
项目级 · 当前项目
├── Plugin A
│   ├── skill-a
│   └── skill-b
└── 本地技能
    ├── 剪辑
    │   ├── jianying-editor
    │   └── jy-image-video
    └── 根目录技能
全局
├── Plugin B
└── 本地技能
额外路径（仅有对应技能时显示）
```

同 Plugin 的技能放在一起。本地分类对应真实文件夹，支持任意深度；不新增虚拟分类、拖拽、移动文件或编辑分类功能。

## 已有事实

- `lib/skills-service.ts:loadSkillsWithInstallInfo(cwd)` 使用 `DefaultResourceLoader`，并保留 `noExtensions: true` 和项目信任策略。
- `components/SkillsConfig.tsx` 当前按作用域和 skills.sh 平铺分组；`setGroupSkills()` 已支持批量修改与逐项失败回显。
- `lib/api-types.ts:SkillInfo.sourceInfo` 目前只声明 source、scope；SDK `SourceInfo` 另有 origin、baseDir，且 `origin === "package"` 明确表示包来源。类型声明不全，不代表运行时没有这些数据。
- `SkillInstallInfo.package` 包含技能名，且 install 注解主要通过技能名匹配锁文件，陈旧锁可能误标同名本地技能。本次不依据 install 判定分组；保留其既有详情、更新和来源链接用途，不将 skills.sh 来源伪称为 Pi Plugin。
- SDK 自动发现资源的 sourceInfo.baseDir 是配置根目录，例如 `.pi`、`.agents`；SkillInfo.baseDir 则是单个技能的目录，不能混用。

## 执行流程

读取现有技能列表 → 服务端补充展示元数据 → 纯函数生成树 → 左侧递归展示 → 复用既有详情和批量开关。

### 1. 补充展示元数据（新增）

新增 `lib/skill-grouping.ts:annotateSkillGrouping(skills, { cwd, agentDir, homeDir })`，由现有 `loadSkillsWithInstallInfo()` 在 install 注解之后调用。只处理已加载技能，不另扫目录、不加载扩展、不请求 `/api/plugins` 或安装包信息。

在 `SkillInfo` 增加可选 `grouping`：scope、kind（plugin / local / path）、sourceKey、sourceLabel、rootKey、directorySegments。补全 sourceInfo.origin、baseDir 的可选类型。作用域严格使用 SDK 元数据：user → 全局，project → 项目级，temporary 或未知 → 顶层额外路径，不根据磁盘位置强行重写作用域。

分类优先级：

1. `sourceInfo.origin === "package"`：Plugin；按作用域与完整 source 标识分组，短名称只用于显示。不根据 node_modules 路径猜归属。
2. 非 Plugin 且有可靠技能根目录：本地技能；按根目录与相对分类路径建树。skills.sh 安装的技能也按实际文件夹归类，保留原有来源和更新信息。
3. 无可靠目录来源：保留在对应作用域的「额外路径」，展示原路径，不猜来源或丢弃技能。

目录根优先匹配 agentDir/skills、homeDir/.agents/skills、cwd/.pi/skills、cwd/.agents/skills 等已知根；仅 sourceInfo.source === "auto" 且 baseDir 与已加载文件存在正确包含关系时，才接受 baseDir/skills（覆盖祖先 .agents/skills）。取最具体的有效根，不一律将 baseDir 拼成根；baseDir 缺失、指向单技能目录或与文件不符时不可作为根。不从 SkillInfo.baseDir 猜分类。路径关系由服务端 Node path API 计算。相对目录不包含单个技能目录：`skills/剪辑/jy-image-video/SKILL.md` 对应「剪辑 → jy-image-video」。根目录直接的 `.md` 作为叶子，直接的 `name/SKILL.md` 不再套同名目录。越界或无法定位根时回退额外路径。不同根目录保留独立 rootKey，遇到同名目录时显示根目录来源以区分，不静默混并。

grouping 缺失时前端保留旧列表展示，避免新增字段变为所有调用方的强制依赖。新增字段仅用于展示，不作为文件授权依据。

### 2. 生成与展示树（新增，最小接入）

新增 `lib/skill-tree.ts:buildSkillTree(skills)` 纯函数，返回作用域 / 来源 / 目录节点和技能叶子。节点稳定 ID 由节点类型（作用域 / 来源 / 目录）、scope、kind、sourceKey、rootKey、完整目录段做 JSON 元组编码，不拼接易冲突的标题或分隔符；叶子仍以 filePath 定位。

新增 `components/SkillGroupTree.tsx` 负责递归列表、展开折叠、数量和组开关。`SkillsConfig.tsx` 只替换左侧分组 JSX 并传入既有回调；不重构右侧详情和安装更新逻辑，不修改共享 SettingsUi 的行为。

项目级在前、全局其次、额外路径最后；组内沿用启用优先的技能排序，目录排序稳定。作用域默认展开，来源与分类默认折叠；初次载入或选中 filePath 变化时展开其祖先，之后用户可以手动折叠而不清空详情；开关操作、树引用变化或更新重载不得再次强制展开。折叠状态仅在当前窗口生命周期内保留，不新增持久化配置。

折叠按钮使用原生 button + aria-expanded，组开关与折叠按钮是并列控件，互不触发。移动端继续使用现有列表 / 详情导航；组标题使用普通按钮而非 ConfigSidebarItem，避免点击折叠或组开关误入详情。折叠后选中叶子可能卸载，因此由仍挂载的 SkillDetail 调用已有 useConfigDetailNavigation().reportDetailTitle(skill.name) 上报移动端标题，并保留详情打开、面板未隐藏的检查。深目录限制视觉缩进，选中项完整分类路径在详情区换行显示，不能仅依赖 title。折叠时若焦点位于后代，先移回组标题；隐藏后代不可聚焦。

### 3. 组开关复用（修改接入，不改接口）

任意分组的开关只收集当前节点的全部后代技能，按 filePath 去重，调用既有 `setGroupSkills()` 与 `PATCH /api/skills`。不包含其他来源、同名节点或未加载技能。

沿用现有语义：全部启用才显示开；部分启用显示 n/m，点击补齐；关闭只修改 disable-model-invocation，仍能手动调用，不是禁用 Plugin。批量操作期间，在 SkillsConfig 的回调入口和控件上同时锁定单项开关、其他组开关、更新与安装，AddSkillPanel 接收禁用状态，避免重载与批量结果互相覆盖；已有写操作进行中也禁止启动批量。不扩展为跨窗口全局锁。部分失败保留成功项，失败信息绑定稳定节点 ID；列表树外保留可见摘要与「展开失败组」入口，折叠祖先不能隐藏唯一错误提示。开关附近有可见说明「控制模型自动调用，仍可手动调用」，读屏关联 n/m 数量。

## 边界与兼容

| 场景 | 处理 |
|---|---|
| 同 Plugin 全局与项目都有技能 | 不跨作用域合并；只显示 SDK 最终实际加载的条目 |
| 两个不同包同显示名 | 完整 sourceKey 区分，展示来源标识 |
| skills.sh 来源或陈旧锁记录 | 按真实目录归类，不因 install 注解改变目录归属；原有详情与更新行为不变 |
| 祖先目录 `.agents/skills` | 按 SDK 实际 scope 和 baseDir 展示，不只考虑 cwd 下目录 |
| 软链接 | 不改变 SDK 返回的 filePath；分类用逻辑路径，写入继续走现有真实路径权限检查；链接与目标同时发现时只保留 SDK 去重后的胜者 |
| 无法判定分类 | 保留条目到额外路径，不自行扫描、猜测或显示整个文件系统 |
| 未信任项目 | 保留现有提示，不列出未加载项目资源 |
| 同名技能被 SDK 覆盖或扩展动态发现 | 不自行恢复或新增；沿用既有 diagnostics 和列表范围 |

不改 SDK、不改包配置、不搬文件、不重建会话；不承诺开关修改即时改变已运行会话的模型上下文。上游合并冲突不能消除，新增独立文件、只留少量现有列表接入可降低冲突面。

## 修改位置与验收

- 新增 `lib/skill-grouping.ts`、`lib/skill-tree.ts` 及对应测试：来源识别、目录归属、缺失 / 无效 / 单技能 baseDir、陈旧锁不影响归类、稳定 ID、同名不同根、Windows 路径、软链接和回退。
- 新增 `components/SkillGroupTree.tsx`；在 `app/settings.css` 增加仅技能树生效的局部样式；修改 `components/SkillsConfig.tsx` 的列表接入、写操作互锁与移动端标题上报。新增文案进入 `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`，不硬编码中文。
- 修改 `lib/skills-service.ts`、`lib/api-types.ts`：可选展示元数据；扩充 `lib/skills-service.integration.test.mjs`，确保无扩展导入、信任边界不变、包技能正确聚合。
- 复用并运行既有 bulk / dormancy / instructions 测试，补父子组批量的实际请求断言（包含折叠后代、去重、只提交需变化项、不串同名来源）、部分失败可见性、并发写入阻止、选中项展开及手动折叠保持、键盘焦点与移动端标题测试；运行类型检查和 lint，不运行 next build。
- 浏览器验证桌面与 320px 移动端：折叠、详情选择、组开关、失败提示、安装更新回归。
- 实施后更新 `docs/agents/settings-ui.md`，按 Fork 约定建立 `docs/customizations.md` 记录最小接入点与可删除条件。

## 评审收敛记录

已组织两路只读独立评审：数据来源 / SDK 兼容，以及交互 / 验收。修订后已由数据兼容评审复核，未发现剩余设计阻塞；这不是实现验证。

- 修正目录根假设：baseDir 不一定是配置根，改为已知根匹配与自动发现元数据校验。
- 去掉 install 驱动的来源分组：锁文件不是可靠归属证据；本次只实现用户要求的 Plugin 聚合与实际目录嵌套。
- 写操作互锁明确为新增接入，不再暗示仅替换左侧 JSX 即可完成全部行为。
- 补齐折叠外失败摘要、稳定节点编码、手动折叠保持、移动端标题与键盘焦点验收。

上述为实施前的方案修订。实施验证记录见下；未提交或推送 Git。

## 实施验证

- 分组 / 树 / 服务集成 / 现有技能面板与共享导入规范测试：39 项通过。
- `tsc --noEmit`、`npm run lint`、`git diff --check` 通过；LSP 进程仍保留依赖缺失时的模块解析诊断，未将其当作干净证据。
- `PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node e2e/skills-grouping.mjs`：7 项真实浏览器检查通过，含桌面分组、折叠后代批量请求、写操作互锁、部分失败、重载保持折叠、320px 标题与返回导航；pageerror / console error 均为空。所有技能写操作由测试路由拦截，不修改真实技能。
- 截图与报告：`test-results/skills-grouping/`（测试产物，不提交）。
- 全量 `npm test`：3655 通过、12 失败、2 跳过；失败位于并行编辑器打开改动涉及的 FileExplorer、SessionSidebar 和编辑器文案 key 对齐，不属于本次技能分组用例，未代改这些文件。
- 恢复 package.json 已声明依赖供验证；未修改依赖声明、未生成锁文件、未执行 next build。

上游参考：技能详情复用现有能力 https://github.com/agegr/pi-web/pull/1158；折叠命令菜单的讨论 https://github.com/agegr/pi-web/issues/1295 针对命令菜单，不代表技能管理页目录树已有排期。
