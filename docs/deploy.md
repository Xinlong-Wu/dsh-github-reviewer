# 部署与挂载

[English](deploy.en.md) | 中文

本文说明如何把 `@xinlongwu/dsh-github-reviewer` 部署到 DeepSeek Harness。配置字段参考见[配置参考](./config.md)，工作原理见[工作原理](./architecture.md)。

## 部署要求

插件注入 harness 的 `agents`、`sessions` 与 `agentDefaultModel` 服务，因此部署必须挂载 agent-loop 家族。除 `github-reviewer` 外，最小可用组合至少需要以下条目（完整带注释示例见 [cordis.yml.example](../cordis.yml.example)）：

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

- **默认模型不由插件配置**：留空 `review.models` 时，每个评审 agent 使用部署的默认模型选择（`agentDefaultModel`），它由 `@deepseek-ai/dsh-agent-default-model` 单独提供（config 需 `{ provider, model }`），并非来自 agent-spine 家族。配置 `review.models` 可指定候选列表（见[配置参考](./config.md)）。
- **依赖不满足时插件不会激活**：cordis 依赖缺失时 fiber 会一直处于 PENDING、插件静默不激活——因此上面的 `agent-default-model` 行与整套存储行（`storage` hub、`storage-json` 后端、`storage-domain`）都是必需的。
- **游标需要存储域**：`dsh_github_reviewer` 域由 `@deepseek-ai/dsh-storage-domain` 提供，需要挂一个后端（`@deepseek-ai/dsh-storage-json` 或 `@deepseek-ai/dsh-storage-sqlite`）并在 storage-domain 配置里路由（例如 `backend: json` 或 `backend: sqlite`）。未挂载时插件在加载期报错。
- **没有 `sessionPersistence`**：评审器仍可用，但 PR 会话只在内存中——重启后每个 PR 从全新会话开始。
- **有 `sessionPersistence`**：每个回合都会被检查点化，重启后评审器恢复已持久化的 PR 会话（同一个 PR 不会创建第二个会话）。
- PR 会话与交互式会话共用同一个会话存储，因此评审在 harness 会话界面里可见、可回放。

## 安装与 peer 依赖

```sh
npm install @xinlongwu/dsh-github-reviewer
```

peer 依赖：插件用到的全部 `@deepseek-ai/*` 包——`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-default-model`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。它们声明为 peer 是有意为之：harness 安装目录已经提供这些包，若再往 profile 里装一份副本会让整个进程出问题——工具调度器在共享的 `tools` 服务上按模块私有 Symbol 查找，重复的 `@deepseek-ai/dsh-tools` 实例会让查找返回 `undefined`，导致所有会话第一次调用工具就崩（`Cannot read properties of undefined (reading 'prepare')`）。真正随插件安装的依赖只有 `@modelcontextprotocol/sdk` 和 `zod`。

## 在运行中的 DSH 实例上启用

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

启用后，评审/对话会话会归入自动注册的 `GithubReviewer` 工作区。插件会挂载一个伴生插件，它借 inject 机制在 `workspace` 服务**可用（挂载完成）的那一刻**自动激活：创建目录并注册工作区，无需轮询或重试。组合里没有该服务时伴生插件保持闲置、不做任何目录/注册工作，reviewer 本身不受影响。可用 `workspaceDir` / `workspaceTitle` 调整。已存在的旧会话仍留在原工作区，只有新会话使用新目录。
