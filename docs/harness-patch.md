# Harness 补丁记录（origin='wechat' 结构化徽标）

> 位置：`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/`（DSH 部署 checkout）。
> profile 的 `node_modules/@deepseek-ai/*` 是符号链接指向这里，补丁直接生效。
> **升级 DSH 会覆盖这些文件**——升级后按下表逐项重新打补丁（每项都极小，纯加法）。

## 补丁清单（P2，2026-08-15）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `@deepseek-ai/dsh-session/lib/index.js`（header 校验） | `origin` 允许 `'wechat'` |
| 2 | `@deepseek-ai/dsh-session/lib/types/index.js`（运行时类型校验） | 同上 |
| 3 | `@deepseek-ai/dsh-session/lib/types/types.d.ts` | `origin?: 'subagent' \| 'wechat'`（两处） |
| 4 | `@deepseek-ai/dsh-agent/lib/types/index.d.ts` | `meta.origin` 联合类型放宽 |
| 5 | `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | header 行校验允许 `'wechat'` |
| 6 | `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` | 两处：① `sessionNode()` 增加 `origin` 字段透传（行节点白名单拷贝原本丢弃 origin——**徽标不显示的根因**）；② 会话行 `origin === 'wechat'` 渲染 🟢 徽标（title="来自微信"） |
| 7 | `@deepseek-ai/dsh-host-apiproxy/lib/index.js` | **Zod schema**：`sessionSummarySchema` 与 `hostFrameSchema` 的 `literal("subagent").optional()` → `.or(literal("wechat")).optional()`（共 2 处；审查补漏——漏了会让 session.list 整体校验失败、侧栏会话列表损坏） |
| 8 | `@deepseek-ai/dsh-client-connection/lib/client.js` | 客户端镜像 schema 同 7（共 2 处） |

## 补丁完整性自查（升级后重打时的核对方法）

```sh
# 拒载性校验点（必须全部允许 'wechat'，即匹配行含 wechat 或不存在）
grep -rn 'origin !== "subagent"\|origin !== .subagent.\|literal("subagent")' \
  node_modules/@deepseek-ai --include=*.js | grep -v '\.map$'
# 期望输出为空（补丁打全后）
```

## 语义

- 桥在 `createSession` 写 `meta.origin = 'wechat'`（不再写 `🟢 微信 ·` 标题前缀，标题回归干净的首句）。
- 所有既有 `=== 'subagent'` 判断都是精确匹配，`'wechat'` 自然落入"顶层普通会话"分支——纯加法，无行为回归。
- 兼容性：旧会话 header 无 origin 字段，正常加载；新会话被旧版本 DSH 读取会拒载（版本 0 无迁移约定），因此**升级前先升级本补丁**。

## 验证方法

重启后：微信 `/new` 建会话 → DSH Web 侧栏该会话行出现 🟢 图标（悬停提示"来自微信"）；`$DSH_HOME/sessions/…/wechat-*/` header 行含 `"origin":"wechat"`。
