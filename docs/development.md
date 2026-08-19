# 开发与已知限制

[English](development.en.md) | 中文

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
