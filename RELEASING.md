# 发布检查清单

每次发版前逐项确认。本清单来自 2026-08-15/16 的微信桥复盘（tsc 覆盖产物入库、
file: 快照过期、生产通道试探封禁），目的是让坑变成检查项，不靠记忆。

## 每次发版必查

1. **files 白名单**：`package.json` 的 `files` 包含 bundle 全部必需文件：
   `lib`、`cordis.patch.yml`、`scripts`、`README.md`、`LICENSE`
2. **bundle 声明**：`package.json` 的 `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`
3. **语法与测试**：`pnpm verify`（build → bundle → `node --check lib/client.js`
   与 `lib/index.js` → `node --test test/*.test.ts`，退出码显式校验，全绿才继续）；
   隔离干跑 `scripts/dry-run.sh --check`（临时 DSH_HOME，不动生产）
4. **CHANGELOG**：顶部新版本条目，Added / Removed / Changed / Fixed 分类完整
5. **DSH 安装验证**（本机）：
   - 移走旧快照：`rm -rf ~/.dsh/profiles/web/node_modules/dsh-wechat-bridge`
     （`file:` 依赖是打包快照，不自动刷新）
   - 重装：`dsh plugin --profile web add file:/path/to/dsh-wechat-bridge`
     （或正式分发地址）
   - 组合验证：`dsh --profile web --dump-config` 输出包含 `dsh-wechat-bridge` row
   - 服务验证：重启 DSH 后 `tail ~/Library/Logs/dsh-web.log` 无 Error
6. **生产通道门**：协议/媒体形状实验只在 Kairos 明确同意的测试窗口内做
   （`scripts/probe-media.mjs` 带 `--consent` 门），异常立即终止并复盘
7. **打 tag 推送**：`git tag vX.Y.Z && git push origin main --tags`

## 已知陷阱备忘

- pnpm 的 `file:` 依赖是打包快照，不是软链。改源码不重装，boot 用的是旧代码
- 没有 `dsh.bundle` 声明时 `dsh plugin add` 会静默装成普通依赖（警告提示），
  boot 时 bundle 不生效
- **版本号影响生产通道**：iLink 用 `App-ClientVersion` 头（0.1.0→256，0.2.0→512），
  升版本前先做只读通道健康检查，动生产通道需受控窗口
- DSH 是 launchd 托管（`com.deepseek.dsh-web`），裸 kill 会触发 keepalive 重启循环；
  用 `launchctl kickstart -k`
