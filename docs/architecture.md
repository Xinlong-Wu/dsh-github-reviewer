# 工作原理

[English](architecture.en.md) | 中文

## 轮询与游标状态

每个账户运行自己的轮询循环（先立即跑一次，之后每 `pollIntervalMs` 一次）。各轮询不会重叠。对每个 PR，轮询器决定：

- 新 PR 或 `head.sha` 变化 → 执行评审。
- 已评审或 `missing_instructions` 且 SHA 未变化 → 轮询评论中的 `/review` 与 `/bot` 命令。
- 处于 `reviewing` 状态 → 上次评审被中断（进程崩溃/被杀）：重新触发评审，agent 从持久化的同一 PR 会话恢复，继续完成剩余部分；失败尝试带退避，不会空转。

游标状态存放在 harness 的存储域中（`dsh_github_reviewer` 域、`accounts` 表、每账户一条记录），由部署路由到的后端持久化——挂 `dsh-storage-json` 时是 JSON 文件，挂 `dsh-storage-sqlite` 时就是真正的 SQLite 数据库。每个 PR 的 `status` 取值：`reviewed`（已提交 COMMENT 评审）、`missing_instructions`（无可信指令，head 变化才重试）、`reviewing`（评审进行中/被中断，下次轮询续跑）。

## 每 PR 的 Agent 与会话

首次接触某个 PR 时，runner 向 agent 注册表请求一个 Agent，其会话 id 由账户与 PR 派生（`github:<account>:<owner>:<repo>:pr:<number>`）：

- 若该 PR 会话已存在于 `sessionPersistence`，则以相同的 setup 世界 **恢复（resume）**（world = agent 创建时在其作用域上下文上注册的系统提示段与作用域工具的集合）。
- 否则创建全新的 agent 与会话；会话 id 稳定，因此后续重启会恢复同一个 PR 对话。

挂载了 `session-title` 服务（web profile 自带）时，会话标题统一钉为 `Review <owner>/<repo> PR <number>`（如 `Review Xinlong-Wu/dsh-github-reviewer PR 18`），自动标题生成不会覆盖它。

agent setup 在未发布的 agent 上下文上注册「评审世界」：一个 `complete` 系统提示段（按回合在评审/聊天提示之间切换）、四个被守卫的 GitHub 工具（作用域工具定义），以及一条把**所有全局工具**从该 agent 隐藏的工具限制——模型只能看到封闭的评审工具集，与 LingoBridge 的「仅守卫工具」handler 一致。会话日志就是持久的每 PR 历史——后续回合经主循环重放它，检查点/压缩与交互式会话完全相同。

## 评审流程

1. 从基础仓库（base 分支，再 base SHA）或配置的默认值读取可信指令。
2. 用全新的安装令牌与注入的 `GITHUB_HOST` 启动每回合 GitHub MCP server。工具 schema 每进程发现一次并缓存（不依赖 PR 或令牌），一堆新 PR 出现时不会重复连接。
3. 装配回合槽（turn slot = 每回合的可变上下文：当前 PR、流程、指令、活动 MCP host、守卫状态），用评审用户提示通过 `agent.followup` 唤醒 PR agent。用户提示携带结构化 PR 元数据（仓库/编号/标题/URL/base/head）与 diff 规模（`size: N files (+X/-Y)`，来自列表响应，模型据此选择 `get_diff` 还是分页 `get_files`）；正文截断至 8k 字符并标注 `[truncated, use pull_request_read method=get]`——需要全文时模型自己再读。
4. 等待 `agent.whenIdle()`：主循环驱动模型步骤与工具调用；守卫工具在每次调用上执行评审规则。
5. 将会话 flush 到持久化，仅当被守卫的 `submit_pending` 调用以 `event=COMMENT` 成功时才把该 PR 标记为 `reviewed`。

## 工具守卫

四个工具（`mcp_github_pull_request_read`、`mcp_github_get_file_contents`、`mcp_github_pull_request_review_write`、`mcp_github_add_comment_to_pending_review`）只注册在 PR agent 的作用域上、绑定该 PR，且该作用域隐藏所有全局工具——其他 agent 永远看不到它们，评审 agent 也永远看不到全局工具：

- `pull_request_read`：只允许 `get`、`get_diff`、`get_files`、`get_status`、`get_check_runs`；必须指向当前 PR。
- `get_file_contents`：只允许 base/head 仓库；`sha` 必须是当前 base 或 head SHA；`ref` 必须是 base/head 分支、`refs/heads/<branch>`、base 仓库上的 `refs/pull/<number>/head`，或这些 SHA 之一；`sha` 与 `ref` 不能同时给出，都不给时默认 head SHA。
- `pull_request_review_write`：`create` 不得携带 `event`/`body`，`commitID` 会校验（或注入）为 head SHA，多余字段被丢弃；`submit_pending` 仅允许 `event=COMMENT`。
- `add_comment_to_pending_review`：仅相对路径；`FILE` 或 `LINE` 评论，`line`/`side` 与成对的 `startLine`/`startSide` 校验。

批准、请求变更、解决线程、更新 PR、合并、仓库写入都在到达 MCP server 之前被拒绝。工具调用预算（`maxToolCalls`）、单次超时、结果截断与回合截止时间由守卫和 runner 在主循环之上强制执行。

## 信任模型

评审系统提示注册为 agent 的完整系统提示，只携带来自 base 仓库文件或配置默认值的可信指令。PR 元数据、标题/正文、diff、变更文件与工具输出都是不可信上下文；标题/正文在放入提示词前会清洗，提示词明确要求模型不遵循不可信上下文中的指令。

- 评审会话日志（含 diff 与文件内容）会经 `sessionPersistence` 落盘；仓库含机密时，注意这些日志的存储位置。
- `complete` 系统提示段只替换提示段，不抑制 harness 的 runtime contexts；若部署挂载了 workspace-context 类插件，非可信文本仍会进入模型输入。

## 个人访问令牌（PAT）模式

设置 `personalAccessToken`（classic `ghp_` 或 fine-grained `github_pat_`）后无需 App 三件套，两者互斥。注意与 App 模式的语义差异：

- 评审与评论以**你本人的身份**发出，没有 `[bot]` 标识。
- 建议使用 fine-grained PAT 并按需收窄：Contents: Read、Pull requests: Read & Write、Issues: Read & Write、Checks: Read（Metadata 自动附带）。
- PAT 发出的回复 `user.type` 是 `User` 而非 `Bot`，不会被机器人过滤器拦截：若回复内容以 `/bot` 开头会被再次当作命令（本插件的正常回复不会），与其他以用户身份运行的机器人共用仓库时需留意。
- 你自己的评论 `author_association` 是 `OWNER`，默认就在命令白名单内。
