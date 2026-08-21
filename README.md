# dsh-github-reviewer

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-github-reviewer)](https://www.npmjs.com/package/dsh-github-reviewer)
[![CI](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-github-reviewer)](https://github.com/Xinlong-Wu/dsh-github-reviewer/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-github-reviewer)](https://nodejs.org)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：轮询配置的 GitHub 仓库中开放的 pull request，并自动发布 `COMMENT` 评审。它是 [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge) 内置 GitHub reviewer 的 TypeScript 移植，并且每次评审和 `/bot` 对话都通过 **harness agent 主循环**驱动：每个 PR 一个常驻 Agent、每个 PR 一条会话日志，通过 harness 的 session-persistence 机制持久化。

## 功能特性

- 轮询配置的仓库中的开放 PR；跳过 draft PR。
- 以 GitHub App 身份认证：签名 RS256 应用 JWT，换取短期安装访问令牌（临近过期前缓存复用）；也可用个人访问令牌（PAT）模式。
- PR 首次出现或 `head.sha` 变化时触发评审；未变化的 PR 记录在存储域的每账户游标记录中，不会重复评审。
- 只从基础仓库的 `.github/review_instructions.md` 读取可信评审指令（先按 base 分支，再按 base SHA）；文件缺失且配置了 `defaultInstructions` 时使用该默认文本，否则该 PR 被标记为 `missing_instructions`，仅当 head SHA 变化后才重试。
- **每个 PR 一个 harness Agent 与会话。** 同一 PR 的评审和 `/bot` 对话在同一个会话中进行，主循环会重放该 PR 的完整对话历史——模型记得之前的发现和讨论。挂载了持久化 provider 时，会话跨重启保留，评审器恢复既有会话而非新建。
- 评审走真实 agent 主循环：评审系统提示以 `complete` 系统提示段注册在 PR agent 上，被守卫的 GitHub 工具以作用域工具形式注册——主循环的日志、检查点、压缩全部生效。
- 每个回合启动一个全新的 `github-mcp-server`（stdio），注入安装令牌为 `GITHUB_PERSONAL_ACCESS_TOKEN`，配置的 web URL 为 `GITHUB_HOST`；工具 schema 每进程发现一次并缓存。
- 守卫每一次工具调用：调用必须指向当前 PR，读取被限制在允许的方法和 ref，写入被限制在 `create` → 行内评论 → `submit_pending(event=COMMENT)` 的 pending-review 工作流。
- 处理已处理 PR 上的评论命令：`/review` 触发重新评审，`/bot <消息>` 继续 PR 对话并把回复发回对应的 issue 线程或 review 线程。
- 评审中断可续跑：`reviewing` 游标状态在重启后重新触发评审，从持久化会话恢复剩余工作。
- 默认实例可启用 Web 设置卡片；保存后只热重启内部 reviewer runtime。settings、工作区与 Client UI 都是可选 inject 伴生能力，缺失时不影响 Host reviewer。
- 在把不可信 PR 标题/正文放入提示词前做清洗（HTML 注释/隐藏属性、不可见/控制字符、markdown 图片 alt 文本、markdown 链接标题、类 GitHub 令牌字符串）。

## 快速开始

```sh
dsh plugin --profile web add dsh-github-reviewer
```

安装会把 bundle 加入 web profile，并注册一个默认启用的 `github-reviewer` 实例；`uiSettings` 默认也是 `true`。在下一次重启前，必须在 profile 的 `cordis.patch.yml` 中按 `id` 为该实例补齐认证和 MCP server，并按需配置仓库（无需再写 `disabled: false` 或 `uiSettings: true`，完整步骤见[部署与挂载](docs/deploy.md)）。设置页的 **GitHub Reviewer** 卡片默认折叠，仓库以“所有者（组织或用户）/仓库”行编辑：聚焦后会使用当前配置的 GitHub 凭据加载可访问仓库，并提供可搜索、可自由输入的候选菜单；目录加载失败或手动值不在目录中都不会阻止编辑和保存。增删操作使用图标按钮；评审模型从 DSH 当前配置的 provider/model 下拉列表中选择，并按从上到下的优先级拖拽排序。仓库列表可以为空，此时 reviewer 保持运行但不轮询仓库。

## 文档

| 主题 | 中文 | English |
|---|---|---|
| 部署与挂载：要求、profile patch 语法、MCP server、验证 | [docs/deploy.md](docs/deploy.md) | [docs/deploy.en.md](docs/deploy.en.md) |
| 配置参考：字段表、环境变量注入、`!!js` 表达式 | [docs/config.md](docs/config.md) | [docs/config.en.md](docs/config.en.md) |
| 工作原理：轮询/游标、评审流程、工具守卫、信任模型 | [docs/architecture.md](docs/architecture.md) | [docs/architecture.en.md](docs/architecture.en.md) |
| 开发与已知限制 | [docs/development.md](docs/development.md) | [docs/development.en.md](docs/development.en.md) |

带注释的最小组合示例见 [cordis.yml.example](./cordis.yml.example)。

## License

[Apache-2.0](LICENSE)
