# dsh-github-reviewer

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/@xinlongwu/dsh-github-reviewer)](https://www.npmjs.com/package/@xinlongwu/dsh-github-reviewer)
[![CI](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@xinlongwu/dsh-github-reviewer)](https://github.com/Xinlong-Wu/dsh-github-reviewer/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@xinlongwu/dsh-github-reviewer)](https://nodejs.org)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：轮询配置的 GitHub 仓库中开放的 pull request，并自动发布 `COMMENT` 评审。它是 [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge) 内置 GitHub reviewer 的 TypeScript 移植，并且每次评审和 `/bot` 对话都通过 **harness agent 主循环**驱动：每个 PR 一个常驻 Agent、每个 PR 一条会话日志，通过 harness 的 session-persistence 机制持久化。

## 功能特性

- 轮询配置的仓库中的开放 PR；跳过 draft PR。
- 以 GitHub App 身份认证：签名 RS256 应用 JWT，换取短期安装访问令牌（临近过期前缓存复用）。
- PR 首次出现或 `head.sha` 变化时触发评审；未变化的 PR 记录在存储域的每账户游标记录中，不会重复评审。
- 只从基础仓库的 `.github/review_instructions.md` 读取可信评审指令（先按 base 分支，再按 base SHA）。文件缺失且配置了 `defaultInstructions` 时使用该默认文本；否则该 PR 被标记为 `missing_instructions`，仅当 head SHA 变化后才重试。
- **每个 PR 一个 harness Agent 与会话。** 同一 PR 的评审和 `/bot` 对话在同一个会话中进行，主循环会重放该 PR 的完整对话历史——模型记得之前的发现和讨论。挂载了持久化 provider 时，会话跨重启保留，评审器恢复既有会话而非新建。
- 评审走真实 agent 主循环：评审系统提示以 `complete` 系统提示段注册在 PR agent 上，被守卫的 GitHub 工具以作用域工具形式注册——主循环的日志、检查点、压缩全部生效。
- 每个回合启动一个全新的 `github-mcp-server`（stdio），注入安装令牌为 `GITHUB_PERSONAL_ACCESS_TOKEN`，配置的 web URL 为 `GITHUB_HOST`。首次接触某 PR 时会额外短暂启动一次 MCP server 用于工具 schema 发现，之后每个回合一台全新 server。
- 守卫每一次工具调用：调用必须指向当前 PR，读取被限制在允许的方法和 ref，写入被限制在 `create` → 行内评论 → `submit_pending(event=COMMENT)` 的 pending-review 工作流。
- 处理已处理 PR 上的评论命令：`/review` 触发重新评审，`/bot <消息>` 继续 PR 对话并把回复发回对应的 issue 线程或 review 线程。
- 在把不可信 PR 标题/正文放入提示词前做清洗（HTML 注释/隐藏属性、不可见/控制字符、markdown 图片 alt 文本、markdown 链接标题、类 GitHub 令牌字符串）。

## 部署要求

插件注入 harness 的 `agents`、`sessions` 与 `agentDefaultModel` 服务，因此部署必须挂载 agent-loop 家族。除 `github-reviewer` 外，最小可用组合至少需要以下条目（完整带注释示例见 [cordis.yml.example](./cordis.yml.example)）：

```yaml
- id: llm-deepseek          # 任意 LLM adapter
  name: '@deepseek-ai/dsh-llm-deepseek'
  config: { thinking: enabled, models: [{ id: deepseek-chat, contextWindow: 128000 }] }
- id: agent-spine           # agent 主循环 + 系统提示组装 + 工具管道
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    agents: [{ id: main, provider: deepseek-official, model: deepseek-chat, cwd: !!js process.cwd() }]
- id: persistence           # 跨重启的每 PR 会话
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config: { root: './.sessions' }
- id: storage               # storage hub（storage-json 与 storage-domain 都依赖它）
  name: '@deepseek-ai/dsh-storage'
- id: storage-json          # 游标存储后端（JSON 文件）
  name: '@deepseek-ai/dsh-storage-json'
  config: { root: './.storage' }
- id: storage-domain        # 游标存储域（dsh_github_reviewer）
  name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: json }
- id: agent-default-model   # 所有评审 agent 的默认模型选择
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: deepseek-official, model: deepseek-chat }
```

- **模型不由插件配置**：每个评审 agent 使用部署的默认模型选择（`agentDefaultModel`），它由 `@deepseek-ai/dsh-agent-default-model` 单独提供（config 需 `{ provider, model }`），并非来自 agent-spine 家族。
- **依赖不满足时插件不会激活**：cordis 依赖缺失时 fiber 会一直处于 PENDING、插件静默不激活——因此上面的 `agent-default-model` 行与整套存储行（`storage` hub、`storage-json` 后端、`storage-domain`）都是必需的。
- **游标需要存储域**：`dsh_github_reviewer` 域由 `@deepseek-ai/dsh-storage-domain` 提供，需要挂一个后端（`@deepseek-ai/dsh-storage-json` 或 `@deepseek-ai/dsh-storage-sqlite`）并在 storage-domain 配置里路由（例如 `backend: json` 或 `backend: sqlite`）。未挂载时插件在加载期报错。
- **没有 `sessionPersistence`**：评审器仍可用，但 PR 会话只在内存中——重启后每个 PR 从全新会话开始。
- **有 `sessionPersistence`**：每个回合都会被检查点化，重启后评审器恢复已持久化的 PR 会话（同一个 PR 不会创建第二个会话）。
- PR 会话与交互式会话共用同一个会话存储，因此评审在 harness 会话界面里可见、可回放。

## 安装

```sh
npm install @xinlongwu/dsh-github-reviewer
```

peer 依赖：插件用到的全部 `@deepseek-ai/*` 包——`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-default-model`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。它们声明为 peer 是有意为之：harness 安装目录已经提供这些包，若再往 profile 里装一份副本会让整个进程出问题——工具调度器在共享的 `tools` 服务上按模块私有 Symbol 查找，重复的 `@deepseek-ai/dsh-tools` 实例会让查找返回 `undefined`，导致所有会话第一次调用工具就崩（`Cannot read properties of undefined (reading 'prepare')`）。真正随插件安装的依赖只有 `@modelcontextprotocol/sdk` 和 `zod`。

### 在运行中的 DSH 实例上启用

假设实例的 profile 目录为 `$DSH_HOME/profiles/web`（`DSH_HOME` 默认为 `~/.dsh`）。

插件通过 harness 的 **profile 组合**加载：组合树 = 官方 bundle 层（`dsh-base`、`dsh-web-app`，由 profile 的 `package.json` 里 `dsh.profile.bundles` 声明）→ 你的 `cordis.patch.yml` → 启动时的 `--patch` 覆盖层。标准 web profile 已经提供插件需要的全部服务，**无需额外挂载**：

| 插件需要的服务 | 由谁提供 | 位置 |
|---|---|---|
| `agents` / `sessions` | `@deepseek-ai/dsh-agent` / `dsh-session` | dsh-base bundle |
| `agentDefaultModel` | `@deepseek-ai/dsh-agent-default-model`（模型在 `settings.yaml` 配置） | dsh-base bundle |
| `sessionPersistence` | `@deepseek-ai/dsh-session-persistence-jsonl` | dsh-base bundle |
| `storageDomain`（游标） | `@deepseek-ai/dsh-storage-domain` + `dsh-storage-json` 后端 | dsh-web-app bundle |

**1. 安装 GitHub MCP server**（官方 Go 版，工具名与守卫匹配）：

```sh
# Linux x86_64；其他架构替换资产名
curl -sL https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_x86_64.tar.gz \
  | tar -xz -C ~/.local/bin github-mcp-server
github-mcp-server --version
```

也可以用容器运行（`ghcr.io/github/github-mcp-server`），此时 `mcp.command` 用 `docker`，见下文注释。

**2. 把插件装进 profile**：

```sh
# 官方方式：dsh CLI 转发给 pnpm（在 profile 目录里安装）
dsh plugin --profile web add @xinlongwu/dsh-github-reviewer

# 等价手写方式：
cd "$DSH_HOME/profiles/web"
npx pnpm add @xinlongwu/dsh-github-reviewer
ls node_modules/@xinlongwu/dsh-github-reviewer/lib/index.js   # 确认安装成功
```

profile 的 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`，pnpm 只会安装插件本身及其真实依赖（`@modelcontextprotocol/sdk`、`zod`）；所有 `@deepseek-ai/*` peer 都从 harness 安装目录解析，进程内每个包只有一份，不会出现副本崩溃（见上文 peer 依赖说明）。

**3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里声明插件**。

注意 patch 文件的语法：顶层数组里的**普通行是按 id 覆盖组合树中已有行**的（目标 id 不存在会报 `patch: entry "<id>" not found`）；**新增插件必须包在 `- insert:` 列表里**：

```yaml
- insert:
    - id: github-reviewer
      name: '@xinlongwu/dsh-github-reviewer'
      config:
        name: personal
        # 二选一：GitHub App 三件套（appId/installationId/privateKeyPath）
        # 或个人访问令牌。避免在文件里写明文令牌，可用 !!js 表达式从环境变量读取：
        # personalAccessToken: !!js process.env.GITHUB_PAT
        personalAccessToken: 'github_pat_...'
        repositories:
          - 'owner/repo'
        mcp:
          command: 'github-mcp-server'
          args: ['stdio', '--tools=pull_request_read,get_file_contents,pull_request_review_write,add_comment_to_pending_review']
          # 容器方案则为（-e 只写变量名，值由插件自动注入进程环境，docker 再透传给容器）：
          # command: 'docker'
          # args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '-e', 'GITHUB_HOST',
          #        'ghcr.io/github/github-mcp-server', 'stdio',
          #        '--tools=pull_request_read,get_file_contents,pull_request_review_write,add_comment_to_pending_review']
```

多账户 = 在同一个 `- insert:` 列表里再放一行相同 `name` 的实例（id 不同），各自独立轮询。

**4. 创建 PAT**（PAT 模式）：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，仅授权目标仓库，权限：Contents: Read、Pull requests: Read & Write、Issues: Read & Write、Checks: Read（Metadata 自动附带）。

**5. 重启实例并验证**：

```sh
dsh web
dsh --profile web --dump-config   # 打印组合后的完整插件树，确认 github-reviewer 行在列
```

启动日志应出现 `starting github account=personal repos=1`；开放 PR 会在下一个轮询周期收到 COMMENT 评审，PR 下评论 `/bot <问题>` 可与评审器对话。`--dump-config` 若报 `patch: entry "..." not found`，说明该行被当作「覆盖已有行」处理了——检查是否漏了 `- insert:` 包装。

启用后，评审/对话会话会归入自动注册的 `GithubReviewer` 工作区（需要 `workspace` 服务，web profile 自带）；可用 `workspaceDir` / `workspaceTitle` 调整。已存在的旧会话仍留在原工作区，只有新会话使用新目录。

## 配置

在 profile 的 `cordis.patch.yml` 中以 `- insert:` 挂载插件（见上文「在运行中的 DSH 实例上启用」），**每个账户一个插件实例**（扁平配置、多实例模式）。以下是单个实例的完整配置字段：

```yaml
- id: github-reviewer-org
  name: '@xinlongwu/dsh-github-reviewer'
  config:
    name: org                             # 账户标签：日志与游标记录键
    appId: '123456'
    installationId: '987654'
    privateKeyPath: '/etc/dsh/github-app.pem'
    # 或者用个人访问令牌代替上面三个 App 字段（两者互斥）：
    # personalAccessToken: 'github_pat_...'
    baseUrl: 'https://api.github.com'      # 可选
    webUrl: 'https://github.com'           # 可选
    pollIntervalMs: 120000                 # 可选，默认 2 分钟
    repositories:
      - 'owner/repo'
    review:                                # 全部可选
      maxToolCalls: 30
      toolTimeoutMs: 30000
      toolResultLimit: 60000
      timeoutMs: 900000
      defaultInstructions: |
        Review this pull request for correctness, regressions, security issues,
        and missing tests. Leave concise inline comments where useful.
    mcp:
      command: 'github-mcp-server'
      args:
        - 'stdio'
        - '--tools=pull_request_read,get_file_contents,pull_request_review_write,add_comment_to_pending_review'
      env: {}                              # 可选；GitHub 令牌自动注入
      cwd: ''                              # 可选
```

多账户 = 再挂一行相同 `name` 的插件实例，各自独立轮询。

### 配置参考

| 字段 | 默认值 | 说明 |
|---|---|---|
| `name` | `default` | 账户标签，用于日志与游标记录键 |
| `appId` | — | GitHub App ID（App 模式必填） |
| `installationId` | — | 用于生成安装令牌的 GitHub App 安装 ID（App 模式必填） |
| `privateKeyPath` | — | 用于签名 GitHub App JWT 的本地 PEM 私钥路径（App 模式必填） |
| `personalAccessToken` | — | 个人访问令牌（classic `ghp_` 或 fine-grained `github_pat_`）；设置后与 App 三件套互斥，无需再填 App 字段 |
| `baseUrl` | `https://api.github.com` | GitHub REST API 基础 URL |
| `webUrl` | `https://github.com` | GitHub web URL 及 MCP 的 `GITHUB_HOST` 值 |
| `pollIntervalMs` | `120000` | PR 轮询间隔 |
| `repositories` | — | `owner/repo` 形式的仓库白名单；至少一个（必填） |
| `workspaceDir` | `$DSH_HOME/github-reviewer/<name>` | 评审/对话会话目录；挂载 `workspace` 服务（web profile 自带）时注册为 harness 工作区，PR 会话归入该工作区而非"未分组" |
| `workspaceTitle` | `GithubReviewer` | 上述工作区的显示标题 |
| `review.maxToolCalls` | `30` | 单次评审回合的工具调用预算；超限被守卫拒绝 |
| `review.toolTimeoutMs` | `30000` | 单次工具调用超时 |
| `review.toolResultLimit` | `60000` | 每次调用返回给模型的最大工具结果字符数 |
| `review.timeoutMs` | `900000` | 单回合总截止时间；超时后取消 agent |
| `review.defaultInstructions` | — | 仅当基础仓库缺少 `.github/review_instructions.md` 时使用的兜底指令 |
| `review.commandAuthorAssociations` | `['OWNER','MEMBER','COLLABORATOR']` | 允许触发 `/review`、`/bot` 命令的评论作者身份（GitHub `author_association` 值，大小写不敏感）；`['*']` 允许所有人，空数组禁止所有人 |
| `mcp.command` | — | 启动每回合 GitHub MCP server 的命令（必填） |
| `mcp.args` | — | server 参数；请显式包含 `--tools=...`（强烈建议；守卫会过滤未列出的工具） |
| `mcp.env` | `{}` | 额外的 MCP server 环境变量；GitHub 令牌自动注入 |
| `mcp.cwd` | — | server 的可选工作目录 |

### MCP server 环境变量自动注入

插件在启动**每个回合**的 MCP server 时自动注入两个环境变量——**不需要、也不应该**在 `mcp.args` 或 `mcp.env` 里自己传：

| 变量 | 值 | 说明 |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 当前回合生效的令牌：PAT 模式为 `personalAccessToken`；App 模式为每回合现铸造的安装令牌 | 在 `mcp.env` 合并之后写入，覆盖同名条目 |
| `GITHUB_HOST` | `webUrl`（默认 `https://github.com`） | 同上 |

- **二进制方式**：server 进程直接拿到这两个变量，无需任何配置。
- **容器方式（docker）**：用 `-e GITHUB_PERSONAL_ACCESS_TOKEN`、`-e GITHUB_HOST`（**只写变量名**），让 docker 从进程环境继承——不要用 `-e NAME=值` 硬编码：token 会进入 docker 命令行（`ps` / `docker inspect` 可见），而且 App 模式的安装令牌是运行时铸造的，配置加载时根本不存在。
- 想改 `GITHUB_HOST` 默认值，配置 `webUrl` 即可，不必在 args 里传。

### 在配置文件里写 JS 表达式（`!!js`）

patch 文件（`cordis.patch.yml`、`--patch` 覆盖层、bundle）里的配置值支持 YAML `!!js` 标签，在**启动加载时**同步求值，可用于任意字段（包括 `disabled`）：

```yaml
- insert:
    - id: github-reviewer
      name: '@xinlongwu/dsh-github-reviewer'
      config:
        # 从环境变量读，避免把令牌明文写进文件：
        personalAccessToken: !!js process.env.GITHUB_PAT
        # 带默认值回退：
        # personalAccessToken: !!js process.env.GITHUB_PAT ?? ''
        # 含空格/操作符/引号的表达式整体加引号：
        # pollIntervalMs: !!js "process.env.DSH_GHR_POLL_MS ? Number(process.env.DSH_GHR_POLL_MS) : 120000"
        # 路径拼到 $DSH_HOME（默认 ~/.dsh）下：
        # privateKeyPath: !!js dshHomePath('secrets', 'github-app.pem')
        # 平台条件禁用：
        # disabled: !!js process.platform === 'win32'
```

- **求值作用域**：表达式在 loader 上下文中以 `with(ctx)` 求值——可直接用 `process`（`process.env.X`、`process.cwd()`、`process.platform` 等）和 `dshHomePath(...segments)`（把片段拼到 `$DSH_HOME` 下）；`??`、三元、模板字符串等 JS 语法都可用。
- **引号规则**：简单标量不用引号（`!!js process.env.X`）；**含空格/操作符/引号的表达式要整体包一层引号**（`!!js "a ?? b"`）。
- **时机与信任**：求值发生在每次启动的配置树加载阶段（同步、一次，不是热更新）；按 `eval` 语义执行，只放可信表达式。

配置错误会在加载时响亮失败：缺少凭证、无效的仓库名、无法读取的私钥、缺少 MCP command/args 都会在激活时报错，而不是静默跳过评审。

## 工作原理

### 轮询与游标状态

每个账户运行自己的轮询循环（先立即跑一次，之后每 `pollIntervalMs` 一次）。各轮询不会重叠。对每个 PR，轮询器决定：

- 新 PR 或 `head.sha` 变化 → 执行评审。
- 已评审或 `missing_instructions` 且 SHA 未变化 → 轮询评论中的 `/review` 与 `/bot` 命令。

游标状态存放在 harness 的存储域中（`dsh_github_reviewer` 域、`accounts` 表、每账户一条记录），由部署路由到的后端持久化——挂 `dsh-storage-json` 时是 JSON 文件，挂 `dsh-storage-sqlite` 时就是真正的 SQLite 数据库。

### 每 PR 的 Agent 与会话

首次接触某个 PR 时，runner 向 agent 注册表请求一个 Agent，其会话 id 由账户与 PR 派生（`github:<account>:<owner>:<repo>:pr:<number>`）：

- 若该 PR 会话已存在于 `sessionPersistence`，则以相同的 setup 世界 **恢复（resume）**（world = agent 创建时在其作用域上下文上注册的系统提示段与作用域工具的集合）。
- 否则创建全新的 agent 与会话；会话 id 稳定，因此后续重启会恢复同一个 PR 对话。

agent setup 在未发布的 agent 上下文上注册「评审世界」：一个 `complete` 系统提示段（按回合在评审/聊天提示之间切换）、四个被守卫的 GitHub 工具（作用域工具定义），以及一条把**所有全局工具**从该 agent 隐藏的工具限制——模型只能看到封闭的评审工具集，与 LingoBridge 的「仅守卫工具」handler 一致。会话日志就是持久的每 PR 历史——后续回合经主循环重放它，检查点/压缩与交互式会话完全相同。

### 评审流程

1. 从基础仓库（base 分支，再 base SHA）或配置的默认值读取可信指令。
2. 用全新的安装令牌与注入的 `GITHUB_HOST` 启动每回合 GitHub MCP server。工具 schema 每进程发现一次并缓存（不依赖 PR 或令牌），一堆新 PR 出现时不会重复连接。
3. 装配回合槽（turn slot = 每回合的可变上下文：当前 PR、流程、指令、活动 MCP host、守卫状态），用评审用户提示通过 `agent.followup` 唤醒 PR agent。用户提示携带结构化 PR 元数据（仓库/编号/标题/URL/base/head）与 diff 规模（`size: N files (+X/-Y)`，来自列表响应，模型据此选择 `get_diff` 还是分页 `get_files`）；正文截断至 8k 字符并标注 `[truncated, use pull_request_read method=get]`——需要全文时模型自己再读。
4. 等待 `agent.whenIdle()`：主循环驱动模型步骤与工具调用；守卫工具在每次调用上执行评审规则。
5. 将会话 flush 到持久化，仅当被守卫的 `submit_pending` 调用以 `event=COMMENT` 成功时才把该 PR 标记为 `reviewed`。

### 工具守卫

四个工具（`mcp_github_pull_request_read`、`mcp_github_get_file_contents`、`mcp_github_pull_request_review_write`、`mcp_github_add_comment_to_pending_review`）只注册在 PR agent 的作用域上、绑定该 PR，且该作用域隐藏所有全局工具——其他 agent 永远看不到它们，评审 agent 也永远看不到全局工具：

- `pull_request_read`：只允许 `get`、`get_diff`、`get_files`、`get_status`、`get_check_runs`；必须指向当前 PR。
- `get_file_contents`：只允许 base/head 仓库；`sha` 必须是当前 base 或 head SHA；`ref` 必须是 base/head 分支、`refs/heads/<branch>`、base 仓库上的 `refs/pull/<number>/head`，或这些 SHA 之一；`sha` 与 `ref` 不能同时给出，都不给时默认 head SHA。
- `pull_request_review_write`：`create` 不得携带 `event`/`body`，`commitID` 会校验（或注入）为 head SHA，多余字段被丢弃；`submit_pending` 仅允许 `event=COMMENT`。
- `add_comment_to_pending_review`：仅相对路径；`FILE` 或 `LINE` 评论，`line`/`side` 与成对的 `startLine`/`startSide` 校验。

批准、请求变更、解决线程、更新 PR、合并、仓库写入都在到达 MCP server 之前被拒绝。工具调用预算（`maxToolCalls`）、单次超时、结果截断与回合截止时间由守卫和 runner 在主循环之上强制执行。

### 信任模型

评审系统提示注册为 agent 的完整系统提示，只携带来自 base 仓库文件或配置默认值的可信指令。PR 元数据、标题/正文、diff、变更文件与工具输出都是不可信上下文；标题/正文在放入提示词前会清洗，提示词明确要求模型不遵循不可信上下文中的指令。

- 评审会话日志（含 diff 与文件内容）会经 `sessionPersistence` 落盘；仓库含机密时，注意这些日志的存储位置。
- `complete` 系统提示段只替换提示段，不抑制 harness 的 runtime contexts；若部署挂载了 workspace-context 类插件，非可信文本仍会进入模型输入。

### 个人访问令牌（PAT）模式

设置 `personalAccessToken`（classic `ghp_` 或 fine-grained `github_pat_`）后无需 App 三件套，两者互斥。注意与 App 模式的语义差异：

- 评审与评论以**你本人的身份**发出，没有 `[bot]` 标识。
- 建议使用 fine-grained PAT 并按需收窄：Contents: Read、Pull requests: Read & Write、Issues: Read & Write、Checks: Read（Metadata 自动附带）。
- PAT 发出的回复 `user.type` 是 `User` 而非 `Bot`，不会被机器人过滤器拦截：若回复内容以 `/bot` 开头会被再次当作命令（本插件的正常回复不会），与其他以用户身份运行的机器人共用仓库时需留意。
- 你自己的评论 `author_association` 是 `OWNER`，默认就在命令白名单内。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run coverage
npm run build
```

## 已知限制与待办

- 游标存在 harness 存储域中；当后端是单机 JSON 文件时，两台主机跑同一账户仍会重复轮询。PR 会话经 harness 持久化，但评审*触发*状态没有（LingoBridge 把两者都放在其账户 store 中）。
- 插件要求完整的 agent-loop 部署（`agents` + `sessions`）；在没有它们的裸组合里不再激活。没有 `sessionPersistence` provider 时，PR 会话跨重启只是内存态。
- PR 会话与交互式会话共用会话存储；在那里可见、可回放，但除了会话 id 之外没有标记它们是评审器会话。
- GitHub API 限流会以错误形式呈现，下一轮询继续；除轮询间隔外没有退避。
- 评论轮询以游标时间戳作为 `since` 边界，因此在下一次轮询前被删除的评论不会被看到。
