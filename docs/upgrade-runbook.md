# 升级上线手册（M4 → 生产 web profile）

> 纪律：一次改对、一次重启。重启 dsh web 会中断所有会话（含 KeepAlive 会话），
> 动手前必须完成全部离线验证。本手册 = 离线验证 → 重启 → 端到端验收 → 回滚。

## 0. 前提（全部通过才能重启）

```sh
cd dsh-wechat-bridge
pnpm verify                   # 期望：VERIFY_EXIT=0，全部测试全绿
scripts/dry-run.sh --check    # 期望：状态端点健康、全部模式、白名单正确
```

## 1. 重启

```sh
# 由维护者选定时间窗执行（会话会断）
dsh --profile web   # 重启 dsh web（或按部署习惯重启服务）
```

重启后先看两个观测面：

```sh
# 1) 桥挂载行（两行：gateway mounted / wechat-bridge-node mounted，含 markdownMode）
# 2) 状态端点
curl -s http://127.0.0.1:3080/api/dsh-wechat-bridge/status | python3 -m json.tool
#   期待：status=polling、paired=true、modes 为对象数组（全部项）、outbox.pending=0
```

## 2. 微信端验收清单（按顺序发，每项核对回复）

| # | 操作 | 期待 |
|---|---|---|
| 1 | `/modes` | 全部模式，中文名+说明，每项下有一行 `/new <id>`；`life-butler（当前默认）` 带标记；底部有偏好行与 /help 提示 |
| 2 | 回复编号 `6`（life-butler） | 直接创建会话并回 `✅ 已创建新会话 wechat-…` |
| 3 | 发普通任务（如「帮我看下今天的日期」） | `⏳ 收到，开始处理…` → 思考心跳（有进展才发）→ 工具卡片（若后端支持）→ 正文 Markdown 渲染 |
| 4 | `/status` | 会话 id、agent 状态、模型/工作区偏好（跟随默认）、出站正常、token 行 |
| 5 | `/model` | 供应商编号列表 → 回复编号 → 模型列表 → 回复编号 → `✅ 模型已设为 …` |
| 6 | `/workspace` | 工作区列表 → 回复编号 → `✅ 工作区已设为 …` |
| 7 | `/new life-finance 你好` | 新会话带模式标签 |
| 8 | `/help` 与 `/help model` | 全部命令总览 / 单命令详情 |
| 9 | `/retry` | `🔁 已重新提交上次任务` |
| 10 | `//你好` | 文本原样进入会话（不被当命令） |
| 11 | `/close` | `🗂 已归档会话 …` |
| 12 | 审批场景（触发一个需要确认的工具） | 审批文案含工具名+**参数摘要**；`/yes`/`/no` 生效 |
| 13 | 发一张图片 | 微信端回 `✅ 已收到 N 张图片`（不再回显本地路径） |
| 14 | Web 设置 → 插件 → 微信桥 | 面板显示模式中文名、偏好、出站队列状态 |

观察文件：`$DSH_HOME/storages/dsh-wechat-bridge/debug.log`（全链路 JSONL：gate/inbound/session-event/send）。
新状态文件：`state.json`（偏好+peer 绑定）、`seen.json`（持久化去重）。

## 3. 已知边界（预期行为，不是 bug）

- **工具进度卡片（type 11/12）**：**默认关闭**（`progressToolPrefixes: []`）。send-only 探针 +
  手机核对已确认当前微信后端对卡片 item 静默丢弃（不投递不报错）。后端支持后把工具前缀
  （如 `[bash, fs, web]`）填回配置即可启用；聚合心跳不受影响。
- **Web 端驱动微信会话**：进度与回复会同步推送微信（一条流两端可见）。
- **重启后旧会话**：微信端发消息会提示「已绑定会话 X，请先在 DSH Web 打开一次」——打开即恢复。
- **`/model` `/workspace`**：只影响之后 `/new` 的会话，运行中会话不热切换。

## 4. 回滚

```sh
# 回滚 = 恢复旧 lib（git checkout 上次提交的 lib/ 产物）后重启 web profile；
# 或 git revert 本次提交后重新 pnpm verify + 重启。
# 状态文件向后兼容：旧代码忽略 state.json/seen.json，无迁移负担。
```

## 5. 升级后清理

- 确认 `pnpm verify` 与干跑绿后，把 `dsh-wechat-bridge/` 全部改动（src/lib/test/docs）一并提交；
  提交信息建议：`dsh-wechat-bridge: M4 移动端体验 + 限流感知出站（P0 验收通过）`。
- P1 排期：FILE 附件通道（CDN 上传移植，见 docs/porting-notes.md §6）、`/thinking` 开关、完成主动推送。
- P2（待办）：图片长图、群聊（origin 徽标方案已废弃——宿主不支持即不做，禁止补丁实现）。
