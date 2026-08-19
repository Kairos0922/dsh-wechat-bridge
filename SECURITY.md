# Security Policy

## Reporting a Vulnerability

**Please do not open a public issue, or disclose an unpatched vulnerability in
any public channel (issue tracker, chat groups, social media), before a fix is
released.** This project bridges an agent to a live messaging channel — a
disclosed-but-unpatched hole can be exploited against real accounts.

Preferred reporting channels, in order:

1. **GitHub Security Advisories** — use the repository's
   ["Report a vulnerability"](https://github.com/Kairos0922/dsh-wechat-bridge/security/advisories/new)
   flow. The report stays private until a fix is published.
2. **Private issue** — if the advisory flow is unavailable, file a GitHub
   issue and mark it private (where supported), or reach the maintainers
   privately with the details.

Please include in your report:

- Affected version(s)
- Steps to reproduce (minimal, if possible)
- Impact assessment — which trust boundary is crossed (e.g. WeChat trust set,
  `/api/dsh-wechat-bridge/*` endpoint fence, media download path)
- A suggested fix, if you have one

## Supported Versions

| Version | Supported |
|---|---|
| 0.2.x | ✅ actively patched |
| < 0.2 | ❌ unsupported (upgrade to 0.2.x) |

## Response Expectations

- **Acknowledgement**: within 5 business days of receiving a report.
- **Triage / severity assessment**: within 10 business days.
- **Fix**: a patched release of a supported version is published as soon as a
  fix is available; high/critical issues are prioritized.
- **Disclosure**: coordinated disclosure — details are published after a fix
  is released; reporters may request credit or an embargo period.

Low-severity or documentation-level issues may be filed as normal (public)
issues, but when in doubt prefer the private channels above.

---

## 中文摘要

- 漏洞请通过 **GitHub Security Advisories** 私密上报，其次私有 issue；修复
  发布前请勿在任何公开渠道披露未修复漏洞。
- 当前支持版本：**0.2.x**（更早版本不维护，请升级）。
- 响应预期：5 个工作日内确认收到，10 个工作日内完成评估与定级；修复随受支持
  版本发布，采用协调披露（修复发布后公开细节）。
