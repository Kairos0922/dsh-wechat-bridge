# 贡献指南（CONTRIBUTING）

## 环境要求

- **Node.js ≥ 22.6**：`node --test` 直接跑 TS 类型剥离所需的最低版本。
- **pnpm 10**：仓库声明 `packageManager: pnpm@10.34.5`，用 corepack 或同版本 pnpm 开发。

## 开发流

```sh
pnpm install
pnpm verify   # build → bundle → node --check → test
```

`pnpm verify` 是合并/提交前的必跑关卡：`build`（tsc）→ `bundle`（tsdown +
wrap-client）→ `node --check` 语法校验 → 全量测试，任一环节失败即终止。含构建
产物的改动必须跑插件级 `pnpm verify`，产物与源码同源重建，禁止手工改产物。

## 测试纪律

- 测试用 `node --test`（`test/*.test.ts`，TS 类型剥离直跑），新增/修改行为必须有
  对应测试覆盖，提交前 `pnpm test` 全绿。
- **协议常量禁止手写数字**：消息/媒体类型、错误码等一律引用 `src/gateway/types.ts`
  导出的 `ITEM_*` / `UPLOAD_MEDIA_*` / 错误码常量（历史教训：VIDEO 被手写成
  `3=VOICE`，服务器 ack 但客户端静默不显示）。
- 观察数据（捕获/日志）与发送代码必须交叉核对；未实测维度不得用"同构推断"充置信度。
- 协议移植（iLink / 上游 openclaw-weixin）逐字段、逐行为对齐官方源码，禁止"按需裁剪"。

## 提交信息风格

沿用 `git log` 现有风格：`<type>: <中文摘要>`，例如：

```
feat: 关键消息必达重推——DSH 事件全量分类，必须触达类通道恢复后自动补发
fix: 出站断流根因修复——stale context_token 自动 tokenless 恢复
docs: README 语法与语言整修——配置表拆表修复、测试数更新
ux: 产品评审 9 项打磨——去内部 id/完成用时/媒体失败反馈
refactor: 移除 origin 徽标与全部 DSH 部署补丁——零宿主依赖
release: v0.2.0 定版
```

type 常用取值：`feat` / `fix` / `docs` / `ux` / `refactor` / `test` / `release` / `chore`。

## 行为红线

- **生产通道禁试探**：微信等对外通道禁止无用户许可的试探性发送——连续对生产账号
  发畸形/实验报文可能触发服务端限流。协议/形状实验只能在用户明确同意的测试
  窗口内进行：单发、异常即停、实验前先只读确认通道健康；探针工具带显式同意门
  （`--consent`）。
- **禁止打补丁实现需求**：不修改宿主（DSH）部署文件/依赖树来实现插件功能；宿主不
  支持的能力如实告知，不做。
- **改前必读**：edit/write 前先 read 目标文件，禁止盲改盲试。
- **先报方案**：代码/文档/配置修改动手前，先把方案交维护者判断。
