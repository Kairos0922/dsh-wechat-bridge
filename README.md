# dsh-wechat-bridge

**Control your DSH agents from WeChat** — the iLink gateway plus a conversation
bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
with three features the ecosystem lacks:

1. **Dynamic mode routing** — agent presets are discovered at runtime from
   `$DSH_HOME/.agent-presets/`, listed with `/modes`, selected per session with
   `/new <mode>`. No hardcoded roles.
2. **Image-in-session** — inbound WeChat images are downloaded (CDN decrypt),
   stored in the local workspace, and handed to the agent session.
3. **Web settings panel** — QR pairing, allowlist management and gateway status
   in the DSH Web settings (no CLI QR juggling).

## Architecture

```
你 (WeChat) ⇄ iLink gateway ⇄ wechat-gateway (ctx.wechat) ⇄ wechat-bridge-node ⇄ DSH session
```

Two separable Cordis plugins:

| Plugin | Role |
|---|---|
| `wechat-gateway` | iLink service: QR login, authenticated long-poll, reconnect/backoff, send retry, typing indicator, CDN media |
| `wechat-bridge-node` | WeChat ⇄ DSH bridge: allowlist gate, preset registry, commands, approvals, digest outbound |

## Install

```sh
git clone <this-repo>
cd plugins/dsh-wechat-bridge
pnpm install && pnpm build
dsh plugin --profile <your-profile> add .
```

Credentials are stored through the **dsh credentials service** — never in the
patch file. Pair your WeChat account once:

```sh
pnpm login          # prints a QR URL; scan it with WeChat and confirm
```

## Configuration

```yaml
# profile patch (cordis.patch.yml)
plugins:
  dsh-wechat-bridge:
    allowFrom: ["<your-wechat-id>"]   # hard allowlist, REQUIRED, no default
    defaultMode: life-butler          # default agent preset for `/new`
    digestIntervalSec: 300
    approvalTimeoutSec: 600
    maxMessageChars: 2000
    sendChunkDelayMs: 1500
```

`allowFrom` is **mandatory with no permissive default**: messages from
non-allowlisted senders are logged and ignored — never fed to the model.

## Commands (in WeChat)

`/modes` · `/new [mode]` · `/use <session>` · `/sessions` · `/stop` · `/status` · `/yes` · `/no`

## Safety notes

- iLink allows ONE authenticated poller per bot token; running another bridge
  on the same WeChat account causes 403s.
- This rides Tencent's WeChat bot gateway; Tencent could restrict the account.
- WeChat messages only enter the DSH session stream — never a shell.

## License

MIT — see [LICENSE](LICENSE) for the full attribution (protocol client derived
from Tencent/openclaw-weixin; architecture informed by dsh-chatnode-wechat).
