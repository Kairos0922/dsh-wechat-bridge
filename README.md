# dsh-wechat-bridge

**Control your DSH agents from WeChat** — the iLink gateway plus a conversation
bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
with features the ecosystem lacks:

1. **Dynamic mode routing** — every agent preset is discovered at runtime via
   the DSH `agentPresets` service, listed with `/modes` (Chinese name +
   description + copyable `/new <id>` + tap-a-number shortcut), selected per
   session with `/new <mode>`. No hardcoded roles.
2. **Mobile-first conversation UX** — Markdown rendering policy for the WeChat
   client, thinking digests, native tool-progress cards, todo snapshots,
   numbered choice menus — all through one rate-limit-aware outbound queue.
3. **Image-in-session** — inbound WeChat images are downloaded (CDN decrypt),
   stored in the local workspace, and handed to the agent session.
4. **Web settings panel** — QR pairing, allowlist, mode list, bridge prefs
   (model/workspace), queue/rate-limit status — no CLI QR juggling.

## Architecture

```
You (WeChat) ⇄ iLink gateway ⇄ wechat-gateway (ctx.wechat) ⇄ wechat-bridge-node ⇄ DSH session
```

Two separable Cordis plugins:

| Plugin | Role |
|---|---|
| `wechat-gateway` | iLink service: QR login, authenticated long-poll, reconnect/backoff, structured send results, typing-ticket cache, durable inbound dedup, CDN media |
| `wechat-bridge-node` | WeChat ⇄ DSH bridge: allowlist gate, per-peer session binding, commands, approvals, rate-limit-aware outbox, progress/answer outbound |

## Install

```sh
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
    cwd: /path/to/workspace           # default working dir for `/new` sessions
    approvalTimeoutSec: 600           # approval timeout (default deny)
    maxMessageChars: 2000             # max chars per WeChat bubble
    minSendIntervalMs: 5000           # min spacing between outbound sends
    rateLimitBackoffSecs: [10, 30, 60]  # escalating pause after errcode -12
    sessionExpiredPauseMin: 60        # outbound pause after errcode -14
    thinkingDigestSec: 10             # thinking-digest refresh while a turn runs
    menuTimeoutSec: 60                # numbered choice menus expire after this
    markdownMode: passthrough         # passthrough | filter | plain
    progressToolPrefixes: []          # tool-progress card prefixes ([] = off, backend not ready)
    fileThresholdChars: 1500          # longer answers ship as a .md attachment
    notifyOnComplete: false           # proactive completion push (long turns only)
    notifyMinTurnSec: 300             # min turn duration (sec) for completion push
    mediaRetentionDays: 30            # media/export file retention (days)
    allowGroups: []                   # group allowlist: [{roomId, allowFrom:[...]}]
    cardMode: off                     # long-image cards: off | long
    chromePath: ''                    # Chrome binary for card rendering (auto-detect)
```

`allowFrom` is **mandatory with no permissive default**: messages from
non-allowlisted senders are logged and ignored — never fed to the model.

> Breaking config change vs 0.1.x: `digestIntervalSec` and `sendChunkDelayMs`
> were removed — pacing is now `minSendIntervalMs` (queue) and progress
> visibility is `thinkingDigestSec`. See [CHANGELOG.md](CHANGELOG.md).

## Commands (in WeChat)

`/modes` · `/new [mode] <prompt>` · `/sessions` · `/use N` · `/stop` · `/status` ·
`/model` · `/workspace` · `/retry` · `/close` · `/thinking` · `/export` · `/card` ·
`/yes` · `/no` · `/help [cmd]`

- `/modes` lists **every** mode with a Chinese name/description and a copyable
  `/new <id>`; replying with a bare number creates the session directly
  (menu valid for `menuTimeoutSec`).
- `/model` / `/workspace` are bridge-local prefs persisted under
  `$DSH_HOME/storages/dsh-wechat-bridge/state.json`; they apply to `/new`
  sessions and never mutate the deployment defaults.
- `//`-prefixed text is forwarded to the agent verbatim (escape hatch for
  text that happens to start with `/`).
- Answers longer than `fileThresholdChars` ship as a digest text + `.md`
  attachment; `/export` sends the full transcript; `/thinking on` shows
  reasoning excerpts in the digest. Sessions created from WeChat carry a
  durable `origin: 'wechat'` header — DSH renders a 🟢 badge in the sidebar
  (harness patch, see docs/harness-patch.md).
- Group chats: `allowGroups` room-level two-tier allowlist; groups stay quiet
  (no digests/cards), only command results and final answers.

## Markdown policy

The WeChat client **renders Markdown for iLink bot messages** (headings h1–h4,
bold, lists, tables, code fences, inline code, rules, blockquotes — verified
end-to-end). Policies:

- `passthrough` (default): send model Markdown as-is; only `![alt](url)` becomes
  a tappable URL.
- `filter`: the official channel's streaming filter (field-for-field port —
  see [docs/porting-notes.md](docs/porting-notes.md)) — strips CJK italic,
  h5/h6 and inline images; the conservative cross-client choice.
- `plain`: strip every marker for clients that render nothing.

## Progress & rate limits

The WeChat channel rate-limits; there are no published numbers, so the outbox
adapts instead of assuming:

- one serial queue, priority-ordered (approvals > terminal notices > answers >
  progress), progress entries coalesce (newer digest replaces a queued one);
- minimum inter-send spacing (`minSendIntervalMs`);
- `-12` (rate limit) → escalating backoff; `-14` (session expired) → full pause
  (official session-guard semantics);
- thinking digests every `thinkingDigestSec` only while there is new progress;
- tool progress aggregates into the digest (anti-spam). Native
  `TOOL_CALL_START/RESULT` cards are **off by default**
  (`progressToolPrefixes: []`): send-only probes verified the current backend
  silently drops those items (no ack, no delivery). The protocol surface is
  fully aligned with the official client — set the prefixes (e.g.
  `[bash, fs, web]`) once the channel supports the cards.

> Known behavior: driving a WeChat session from the DSH Web UI also streams
> its progress and replies to WeChat (one session, one stream, visible on both
> ends). This is a feature; a "mute WeChat while Web drives" switch can be
> added on request.

## Safety notes

- iLink allows ONE authenticated poller per bot token; running another bridge
  on the same WeChat account causes 403s.
- This rides Tencent's WeChat bot gateway; Tencent could restrict the account.
- WeChat messages only enter the DSH session stream — never a shell.
- `allowFrom` is the security boundary: never widen it casually.

## Docs

- [CHANGELOG.md](CHANGELOG.md)
- [docs/porting-notes.md](docs/porting-notes.md) — field-by-field porting table
  vs Tencent/openclaw-weixin (upgrade diff checklist)

## License

MIT — see [LICENSE](LICENSE) for the full attribution (protocol client and
markdown filter derived from Tencent/openclaw-weixin; architecture informed by
dsh-chatnode-wechat).
