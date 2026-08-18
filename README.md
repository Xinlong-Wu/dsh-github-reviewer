# dsh-github-reviewer

[English](README.en.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：轮询配置的 GitHub 仓库中开放的 pull request，并自动发布 `COMMENT` 评审。它是 [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge) 内置 GitHub reviewer 的 TypeScript 移植，并且每次评审和 `/bot` 对话都通过 **harness agent 主循环**驱动：每个 PR 一个常驻 Agent、每个 PR 一条会话日志，通过 harness 的 session-persistence 机制持久化。

## 功能特性

- 轮询配置的仓库中的开放 PR；跳过 draft PR。
- 以 GitHub App 身份认证：签名 RS256 应用 JWT，换取短期安装访问令牌（临近过期前缓存复用）。
- PR 首次出现或 `head.sha` 变化时触发评审；未变化的 PR 记录在每账户的游标文件中，不会重复评审。
- 只从基础仓库的 `.github/review_instructions.md` 读取可信评审指令（先按 base 分支，再按 base SHA）。文件缺失且配置了 `defaultInstructions` 时使用该默认文本；否则该 PR 被标记为 `missing_instructions`，仅当 head SHA 变化后才重试。
- **每个 PR 一个 harness Agent 与会话。** 同一 PR 的评审和 `/bot` 对话在同一个会话中进行，主循环会重放该 PR 的完整对话历史——模型记得之前的发现和讨论。挂载了持久化 provider 时，会话跨重启保留，评审器恢复既有会话而非新建。
- 评审走真实 agent 主循环：评审系统提示以 `complete` 系统提示段注册在 PR agent 上，被守卫的 GitHub 工具以作用域工具形式注册——主循环的日志、检查点、压缩全部生效。
- 每个回合启动一个全新的 `github-mcp-server`（stdio），注入安装令牌为 `GITHUB_PERSONAL_ACCESS_TOKEN`，配置的 web URL 为 `GITHUB_HOST`。
- 守卫每一次工具调用：调用必须指向当前 PR，读取被限制在允许的方法和 ref，写入被限制在 `create` → 行内评论 → `submit_pending(event=COMMENT)` 的 pending-review 工作流。
- 处理已处理 PR 上的评论命令：`/review` 触发重新评审，`/bot <消息>` 继续 PR 对话并把回复发回对应的 issue 线程或 review 线程。
- 在把不可信 PR 标题/正文放入提示词前做清洗（HTML 注释/隐藏属性、不可见/控制字符、markdown 图片 alt 文本、markdown 链接标题、类 GitHub 令牌字符串）。

## 部署要求

插件注入 harness 的 `agents` 与 `sessions` 服务，因此部署必须挂载 agent-loop 家族。除 `github-reviewer` 外，最小可用组合至少需要以下条目（完整带注释示例见 [cordis.yml.example](./cordis.yml.example)）：

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
```

- **没有 `sessionPersistence`**：评审器仍可用，但 PR 会话只在内存中——重启后每个 PR 从全新会话开始。
- **有 `sessionPersistence`**：每个回合都会被检查点化，重启后评审器恢复已持久化的 PR 会话（同一个 PR 不会创建第二个会话）。
- PR 会话与交互式会话共用同一个会话存储，因此评审在 harness 会话界面里可见、可回放。

## 安装

```sh
npm install @lingobridge/dsh-github-reviewer
```

peer 依赖：`@deepseek-ai/cordis`（harness 的 Cordis 运行时）。

## 配置

在 harness 的 `cordis.yml` 中挂载插件：

```yaml
plugins:
  github-reviewer:
    config:
      accounts:
        reviewer:
          appId: '123456'
          installationId: '987654'
          privateKeyPath: '/etc/dsh/github-app.pem'
          baseUrl: 'https://api.github.com'      # 可选
          webUrl: 'https://github.com'           # 可选
          pollIntervalMs: 120000                 # 可选，默认 2 分钟
          repositories:
            - 'owner/repo'
          provider: 'deepseek'                   # llm provider 路由
          model: 'deepseek-chat'                 # 模型 id
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
          statePath: ''                          # 可选；默认 ./.dsh-github-reviewer/<account>.json
```

多个账户各自运行独立的轮询循环。

### 配置参考

| 字段 | 默认值 | 说明 |
|---|---|---|
| `accounts.<name>.appId` | — | GitHub App ID（必填） |
| `accounts.<name>.installationId` | — | 用于生成安装令牌的 GitHub App 安装 ID（必填） |
| `accounts.<name>.privateKeyPath` | — | 用于签名 GitHub App JWT 的本地 PEM 私钥路径（必填） |
| `accounts.<name>.baseUrl` | `https://api.github.com` | GitHub REST API 基础 URL |
| `accounts.<name>.webUrl` | `https://github.com` | GitHub web URL 及 MCP 的 `GITHUB_HOST` 值 |
| `accounts.<name>.pollIntervalMs` | `120000` | PR 轮询间隔 |
| `accounts.<name>.repositories` | — | `owner/repo` 形式的仓库白名单；至少一个（必填） |
| `accounts.<name>.provider` | `deepseek` | 该账户评审使用的 harness LLM provider 路由 |
| `accounts.<name>.model` | — | 该账户评审使用的模型 id（必填） |
| `accounts.<name>.review.maxToolCalls` | `30` | 单次评审回合的工具调用预算；超限被守卫拒绝 |
| `accounts.<name>.review.toolTimeoutMs` | `30000` | 单次工具调用超时 |
| `accounts.<name>.review.toolResultLimit` | `60000` | 每次调用返回给模型的最大工具结果字符数 |
| `accounts.<name>.review.timeoutMs` | `900000` | 单回合总截止时间；超时后取消 agent |
| `accounts.<name>.review.defaultInstructions` | — | 仅当基础仓库缺少 `.github/review_instructions.md` 时使用的兜底指令 |
| `accounts.<name>.mcp.command` | — | 启动每回合 GitHub MCP server 的命令（必填） |
| `accounts.<name>.mcp.args` | — | server 参数；请显式包含 `--tools=...`（必填） |
| `accounts.<name>.mcp.env` | `{}` | 额外的 MCP server 环境变量；GitHub 令牌自动注入 |
| `accounts.<name>.mcp.cwd` | — | server 的可选工作目录 |
| `accounts.<name>.statePath` | `./.dsh-github-reviewer/<name>.json` | 游标状态文件路径 |

配置错误会在加载时响亮失败：缺少凭证、无效的仓库名、无法读取的私钥、缺少 MCP command/args 都会在激活时报错，而不是静默跳过评审。

## 工作原理

### 轮询与游标状态

每个账户运行自己的轮询循环（先立即跑一次，之后每 `pollIntervalMs` 一次）。各轮询不会重叠。对每个 PR，轮询器决定：

- 新 PR 或 `head.sha` 变化 → 执行评审。
- 已评审或 `missing_instructions` 且 SHA 未变化 → 轮询评论中的 `/review` 与 `/bot` 命令。

游标状态是每账户一个 JSON 文件（`prs` 以 `owner/repo#number` 为键，记录 head SHA、终态状态、评论检查时间戳），通过临时文件改名原子写入。

### 每 PR 的 Agent 与会话

首次接触某个 PR 时，runner 向 agent 注册表请求一个 Agent，其会话 id 由账户与 PR 派生（`github:<account>:<owner>:<repo>:pr:<number>`）：

- 若该 PR 会话已存在于 `sessionPersistence`，则以相同的 setup 世界 **恢复（resume）**。
- 否则创建全新的 agent 与会话；会话 id 稳定，因此后续重启会恢复同一个 PR 对话。

agent setup 在未发布的 agent 上下文上注册「评审世界」：一个 `complete` 系统提示段（按回合在评审/聊天提示之间切换）、四个被守卫的 GitHub 工具（作用域工具定义），以及一条把**所有全局工具**从该 agent 隐藏的工具限制——模型只能看到封闭的评审工具集，与 LingoBridge 的「仅守卫工具」handler 一致。会话日志就是持久的每 PR 历史——后续回合经主循环重放它，检查点/压缩与交互式会话完全相同。

### 评审流程

1. 从基础仓库（base 分支，再 base SHA）或配置的默认值读取可信指令。
2. 用全新的安装令牌与注入的 `GITHUB_HOST` 启动每回合 GitHub MCP server。
3. 装配回合槽（PR、流程、指令、活动 host、守卫状态），用评审用户提示通过 `agent.followup` 唤醒 PR agent。
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

## 开发

```sh
npm install
npm run typecheck
npm test
npm run coverage
npm run build
```

## 已知限制与待办

- 游标文件属于进程主机本地；同一账户跑两台主机仍会重复轮询。PR 会话经 harness 持久化，但评审*触发*状态没有（LingoBridge 把两者都放在其账户 store 中）。
- 插件要求完整的 agent-loop 部署（`agents` + `sessions`）；在没有它们的裸组合里不再激活。没有 `sessionPersistence` provider 时，PR 会话跨重启只是内存态。
- PR 会话与交互式会话共用会话存储；在那里可见、可回放，但除了会话 id 之外没有标记它们是评审器会话。
- GitHub API 限流会以错误形式呈现，下一轮询继续；除轮询间隔外没有退避。
- 评论轮询以游标时间戳作为 `since` 边界，因此在下一次轮询前被删除的评论不会被看到。
