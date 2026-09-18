# Future Code 源码快照（安全研究用途）

> 本仓库镜像了一份**公开暴露的 Future Code 源码快照**，该快照于 **2026 年 3 月 31 日**通过 npm 发行包中的 source map 泄露而被访问。本仓库维护目的为**教育、防御性安全研究及软件供应链分析**。

---

## 研究背景

本仓库由一名**在校大学生**维护，研究方向包括：

- 软件供应链暴露与构建产物泄漏
- 安全软件工程实践
- 智能体开发工具架构
- 真实 CLI 系统的防御性分析

本存档旨在支持：

- 教育学习
- 安全研究实践
- 架构分析
- 软件打包与发布流程失误的讨论

本仓库**不主张对原始代码的所有权**，也不应被视为 Future 的官方仓库。

---

## 公开快照如何变得可访问

[Chaofan Shou (@Fried_rice)](https://x.com/Fried_rice) 公开指出，Future Code 的源代码可通过 npm 包中暴露的 `.map` 文件访问：

> **"Future Code 源代码通过其 npm 注册表中的 map 文件泄露了！"**
>
> — [@Fried_rice，2026 年 3 月 31 日](https://x.com/Fried_rice/status/2038894956459290963)

已发布的 source map 引用了托管在 Future R2 存储桶中的未混淆 TypeScript 源码，使得 `src/` 快照可被公开下载。

---

## 仓库范围

Future Code 是 Future 推出的 CLI 工具，用于在终端中与 Future 交互，执行软件工程任务，如编辑文件、运行命令、搜索代码库和协调工作流。

本仓库包含一份镜像的 `src/` 快照，供研究和分析使用。

- **公开暴露发现时间**：2026-03-31
- **语言**：TypeScript
- **运行时**：Bun
- **终端 UI**：React + [Ink](https://github.com/vadimdemedes/ink)
- **规模**：约 1,900 个文件，512,000+ 行代码

---

## 目录结构

```text
src/
├── main.tsx                 # 入口编排（基于 Commander.js 的 CLI 路径）
├── commands.ts              # 命令注册表
├── tools.ts                 # 工具注册表
├── Tool.ts                  # 工具类型定义
├── QueryEngine.ts           # LLM 查询引擎
├── context.ts               # 系统/用户上下文收集
├── cost-tracker.ts          # Token 费用追踪
│
├── commands/                # 斜杠命令实现（约 50 个）
├── tools/                   # 智能体工具实现（约 40 个）
├── components/              # Ink UI 组件（约 140 个）
├── hooks/                   # React Hooks
├── services/                # 外部服务集成
├── screens/                 # 全屏 UI（Doctor、REPL、Resume）
├── types/                   # TypeScript 类型定义
├── utils/                   # 工具函数
│
├── bridge/                  # IDE 及远程控制桥接层
├── coordinator/             # 多智能体协调器
├── plugins/                 # 插件系统
├── skills/                  # 技能系统
├── keybindings/             # 快捷键配置
├── vim/                     # Vim 模式
├── voice/                   # 语音输入
├── remote/                  # 远程会话
├── server/                  # 服务器模式
├── memdir/                  # 持久化内存目录
├── tasks/                   # 任务管理
├── state/                   # 状态管理
├── migrations/              # 配置迁移
├── schemas/                 # 配置模式（Zod）
├── entrypoints/             # 初始化逻辑
├── ink/                     # Ink 渲染器封装
├── buddy/                   # 伴侣精灵
├── native-ts/               # 原生 TypeScript 工具
├── outputStyles/            # 输出样式
├── query/                   # 查询管道
└── upstreamproxy/           # 代理配置
```

---

## 架构概览

### 1. 工具系统（`src/tools/`）

Future Code 可调用的每个工具均实现为独立模块，每个工具定义其输入模式、权限模型和执行逻辑。

| 工具 | 说明 |
|---|---|
| `BashTool` | Shell 命令执行 |
| `FileReadTool` | 文件读取（图片、PDF、笔记本） |
| `FileWriteTool` | 文件创建/覆盖 |
| `FileEditTool` | 文件局部修改（字符串替换） |
| `GlobTool` | 文件模式匹配搜索 |
| `GrepTool` | 基于 ripgrep 的内容搜索 |
| `WebFetchTool` | 获取 URL 内容 |
| `WebSearchTool` | 网络搜索 |
| `AgentTool` | 子智能体生成 |
| `SkillTool` | 技能执行 |
| `MCPTool` | MCP 服务器工具调用 |
| `LSPTool` | 语言服务器协议集成 |
| `NotebookEditTool` | Jupyter 笔记本编辑 |
| `TaskCreateTool` / `TaskUpdateTool` | 任务创建与管理 |
| `SendMessageTool` | 智能体间消息传递 |
| `TeamCreateTool` / `TeamDeleteTool` | 团队智能体管理 |
| `EnterPlanModeTool` / `ExitPlanModeTool` | 计划模式切换 |
| `EnterWorktreeTool` / `ExitWorktreeTool` | Git 工作树隔离 |
| `ToolSearchTool` | 延迟工具发现 |
| `CronCreateTool` | 定时触发器创建 |
| `RemoteTriggerTool` | 远程触发 |
| `SleepTool` | 主动模式等待 |
| `SyntheticOutputTool` | 结构化输出生成 |

### 2. 命令系统（`src/commands/`）

用户通过 `/` 前缀调用的斜杠命令。

| 命令 | 说明 |
|---|---|
| `/commit` | 创建 git 提交 |
| `/review` | 代码审查 |
| `/compact` | 上下文压缩 |
| `/mcp` | MCP 服务器管理 |
| `/config` | 设置管理 |
| `/doctor` | 环境诊断 |
| `/login` / `/logout` | 身份验证 |
| `/memory` | 持久化内存管理 |
| `/skills` | 技能管理 |
| `/tasks` | 任务管理 |
| `/vim` | Vim 模式切换 |
| `/diff` | 查看变更 |
| `/cost` | 查看使用费用 |
| `/theme` | 修改主题 |
| `/context` | 上下文可视化 |
| `/pr_comments` | 查看 PR 评论 |
| `/resume` | 恢复上一会话 |
| `/share` | 分享会话 |
| `/desktop` | 切换到桌面应用 |
| `/mobile` | 切换到移动应用 |

### 3. 服务层（`src/services/`）

| 服务 | 说明 |
|---|---|
| `api/` | Future API 客户端、文件 API、引导程序 |
| `mcp/` | 模型上下文协议服务器连接与管理 |
| `oauth/` | OAuth 2.0 认证流程 |
| `lsp/` | 语言服务器协议管理器 |
| `analytics/` | 基于 GrowthBook 的功能标志与分析 |
| `plugins/` | 插件加载器 |
| `compact/` | 对话上下文压缩 |
| `policyLimits/` | 组织策略限制 |
| `remoteManagedSettings/` | 远程托管设置 |
| `extractMemories/` | 自动记忆提取 |
| `tokenEstimation.ts` | Token 数量估算 |
| `teamMemorySync/` | 团队记忆同步 |

### 4. 桥接系统（`src/bridge/`）

连接 IDE 扩展（VS Code、JetBrains）与 Future Code CLI 的双向通信层。

- `bridgeMain.ts` — 桥接主循环
- `bridgeMessaging.ts` — 消息协议
- `bridgePermissionCallbacks.ts` — 权限回调
- `replBridge.ts` — REPL 会话桥接
- `jwtUtils.ts` — 基于 JWT 的身份验证
- `sessionRunner.ts` — 会话执行管理

### 5. 权限系统（`src/hooks/toolPermission/`）

在每次工具调用时检查权限。根据配置的权限模式（`default`、`plan`、`bypassPermissions`、`auto` 等），提示用户批准/拒绝或自动解析。

### 6. 功能标志

通过 Bun 的 `bun:bundle` 功能标志实现死代码消除：

```typescript
import { feature } from 'bun:bundle'

// 非活跃代码在构建时被完全剥离
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

主要标志：`PROACTIVE`、`KAIROS`、`BRIDGE_MODE`、`DAEMON`、`VOICE_MODE`、`AGENT_TRIGGERS`、`MONITOR_TOOL`

---

## 关键文件详解

### `QueryEngine.ts`（约 46K 行）

LLM API 调用的核心引擎，负责处理流式响应、工具调用循环、思考模式、重试逻辑和 Token 计数。

### `Tool.ts`（约 29K 行）

定义所有工具的基础类型和接口，包括输入模式、权限模型和进度状态类型。

### `commands.ts`（约 25K 行）

管理所有斜杠命令的注册与执行，使用条件导入在不同环境中加载不同命令集。

### `main.tsx`

基于 Commander.js 的 CLI 解析器和 React/Ink 渲染器初始化。启动时并行进行 MDM 设置、钥匙串预取和 GrowthBook 初始化，以加快启动速度。

---

## 技术栈

| 类别 | 技术 |
|---|---|
| 运行时 | [Bun](https://bun.sh) |
| 语言 | TypeScript（严格模式） |
| 终端 UI | [React](https://react.dev) + [Ink](https://github.com/vadimdemedes/ink) |
| CLI 解析 | [Commander.js](https://github.com/tj/commander.js)（extra-typings） |
| 模式验证 | [Zod v4](https://zod.dev) |
| 代码搜索 | [ripgrep](https://github.com/BurntSushi/ripgrep) |
| 协议 | [MCP SDK](https://modelcontextprotocol.io)、LSP |
| API | [Future SDK](https://docs.future.com) |
| 遥测 | OpenTelemetry + gRPC |
| 功能标志 | GrowthBook |
| 身份验证 | OAuth 2.0、JWT、macOS 钥匙串 |

---

## 值得关注的设计模式

### 并行预取

通过在大型模块评估之前并行预取 MDM 设置、钥匙串读取和 API 预连接来优化启动时间。

```typescript
// main.tsx — 在其他导入之前作为副作用触发
startMdmRawRead()
startKeychainPrefetch()
```

### 懒加载

重型模块（OpenTelemetry、gRPC、分析模块及部分功能门控子系统）通过动态 `import()` 延迟加载，直到实际需要时才载入。

### 智能体群组

子智能体通过 `AgentTool` 生成，`coordinator/` 负责多智能体编排。`TeamCreateTool` 支持团队级并行工作。

### 技能系统

在 `skills/` 中定义的可复用工作流通过 `SkillTool` 执行，用户可添加自定义技能。

### 插件架构

内置及第三方插件通过 `plugins/` 子系统加载。

---

## 研究声明 / 所有权声明

- 本仓库是由一名在校大学生维护的**教育性防御安全研究存档**。
- 其存在目的是研究源码暴露、打包失误及现代智能体 CLI 系统的架构。
- 原始 Future Code 源代码的所有权归 **Future** 所有。
- 本仓库**与 Future 无关，未获 Future 背书，亦不由 Future 维护**。
