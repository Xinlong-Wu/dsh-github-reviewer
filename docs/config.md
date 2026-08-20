# 配置参考

[English](config.en.md) | 中文

安装 bundle 后，在 profile 的 `cordis.patch.yml` 中覆盖默认的 `github-reviewer` 行并启用它（见[部署与挂载](./deploy.md)）。**每个账户一个插件实例**（扁平配置、多实例模式）；额外账户仍用 `- insert:` 添加。以下是默认实例的完整配置字段：

```yaml
- id: github-reviewer
  disabled: false
  config:
    name: org                             # 账户标签：日志与游标记录键
    uiSettings: true                      # 仅默认实例开启 Web 设置卡片
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

多账户 = 再挂一行相同 `name` 的插件实例，各自独立轮询。当前 Web 设置卡片只管理一个明确开启 `uiSettings: true` 的默认实例；额外账户继续由 composition 管理并设置 `uiSettings: false`。

Web 卡片只覆盖 `repositories`、`pollIntervalMs`、工作区字段和 `review.*`。认证、GitHub URL 与 MCP 进程配置仍由 `cordis.patch.yml` 管理。保存时只写 settings 用户覆盖层，不改写 profile；清除字段后重新继承 profile 值。保存成功表示“已持久化并请求异步重启 reviewer runtime”，不是整个 DSH 进程重启完成。

`settings`、`workspaceRegistry` 与 Client UI 都通过可选注入挂载：缺少或稍后卸载任一依赖时，Host reviewer 仍继续工作；settings 卸载后会回退到 composition 配置并只重启内部 reviewer runtime。

## 配置参考

| 字段 | 默认值 | 说明 |
|---|---|---|
| `name` | `default` | 账户标签，用于日志与游标记录键 |
| `uiSettings` | `false`（bundle 默认行设为 `true`） | 注册固定的 `github-reviewer` Web 设置命名空间；仅一个实例可开启，额外账户保持 `false` |
| `appId` | — | GitHub App ID（App 模式必填） |
| `installationId` | — | 用于生成安装令牌的 GitHub App 安装 ID（App 模式必填） |
| `privateKeyPath` | — | 用于签名 GitHub App JWT 的本地 PEM 私钥路径（App 模式必填） |
| `personalAccessToken` | — | 个人访问令牌（classic `ghp_` 或 fine-grained `github_pat_`）；设置后与 App 三件套互斥，无需再填 App 字段 |
| `baseUrl` | `https://api.github.com` | GitHub REST API 基础 URL |
| `webUrl` | `https://github.com` | GitHub web URL 及 MCP 的 `GITHUB_HOST` 值 |
| `pollIntervalMs` | `120000` | PR 轮询间隔 |
| `repositories` | — | `owner/repo` 形式的仓库白名单；至少一个（必填） |
| `workspaceDir` | `$DSH_HOME/github-reviewer/<name>` | 评审/对话会话目录；挂载 `@deepseek-ai/dsh-workspace`（web profile 自带，其服务名为 `workspaceRegistry`）时注册为 harness 工作区，PR 会话归入该工作区而非“未分组” |
| `workspaceTitle` | `GithubReviewer` | 上述工作区的显示标题 |
| `review.maxToolCalls` | `30` | 单次评审回合的工具调用预算；超限被守卫拒绝 |
| `review.toolTimeoutMs` | `30000` | 单次工具调用超时 |
| `review.toolResultLimit` | `60000` | 每次调用返回给模型的最大工具结果字符数 |
| `review.timeoutMs` | `900000` | 单回合总截止时间；超时后取消 agent |
| `review.defaultInstructions` | — | 仅当基础仓库缺少 `.github/review_instructions.md` 时使用的兜底指令 |
| `review.commandAuthorAssociations` | `['OWNER','MEMBER','COLLABORATOR']` | 允许触发 `/review`、`/bot` 命令的评论作者身份（GitHub `author_association` 值，大小写不敏感）；`['*']` 允许所有人，空数组禁止所有人 |
| `review.models` | `[]`（用部署默认模型） | 评审模型的候选列表 `[{provider, model}]`。**判断发生在首次创建 PR 会话时**（不在插件挂载时报错）：取第一个「provider 已注册且模型在该 provider 目录中」的候选；全部不可用时本次评审终止、游标记录失败（退避后重试）。「可用」= 目录判定（`llm.listModels`），不做真实连接探测。留空则用部署的 `agentDefaultModel` |
| `mcp.command` | — | 启动每回合 GitHub MCP server 的命令（必填） |
| `mcp.args` | — | server 参数；请显式包含 `--tools=...`（强烈建议；守卫会过滤未列出的工具） |
| `mcp.env` | `{}` | 额外的 MCP server 环境变量；GitHub 令牌自动注入 |
| `mcp.cwd` | — | server 的可选工作目录 |

## MCP server 环境变量自动注入

插件在启动**每个回合**的 MCP server 时自动注入两个环境变量——**不需要、也不应该**在 `mcp.args` 或 `mcp.env` 里自己传：

| 变量 | 值 | 说明 |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 当前回合生效的令牌：PAT 模式为 `personalAccessToken`；App 模式为每回合现铸造的安装令牌 | 在 `mcp.env` 合并之后写入，覆盖同名条目 |
| `GITHUB_HOST` | `webUrl`（默认 `https://github.com`） | 同上 |

- **二进制方式**：server 进程直接拿到这两个变量，无需任何配置。
- **容器方式（docker）**：用 `-e GITHUB_PERSONAL_ACCESS_TOKEN`、`-e GITHUB_HOST`（**只写变量名**），让 docker 从进程环境继承——不要用 `-e NAME=值` 硬编码：token 会进入 docker 命令行（`ps` / `docker inspect` 可见），而且 App 模式的安装令牌是运行时铸造的，配置加载时根本不存在。
- 想改 `GITHUB_HOST` 默认值，配置 `webUrl` 即可，不必在 args 里传。

## 在配置文件里写 JS 表达式（`!!js`）

patch 文件（`cordis.patch.yml`、`--patch` 覆盖层、bundle）里的配置值支持 YAML `!!js` 标签，在**启动加载时**同步求值，可用于任意字段（包括 `disabled`）：

```yaml
- insert:
    - id: github-reviewer
      name: 'dsh-github-reviewer'
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
