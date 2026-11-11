# qwen-usage

Pi Coding Agent extension for monitoring **Qwen / Alibaba Cloud Model Studio (百炼) Token Plan** usage — remaining **Credits** plus every quota window (5h / weekly / monthly) in the pi footer. Works for both mainland (`cn-beijing`) and international (`ap-southeast-1`, Qwen Cloud) personal plans.

## Install

```bash
pi install git:github.com/inouemoby/pi-qwen-usage
```

## Setup

Register your Token Plan key in pi as usual (e.g. `qwen-token-plan-individual-cn`). The footer activates automatically for any `qwen-token-plan*` provider or any model whose base URL is `token-plan.<region>.maas.aliyuncs.com`.

**Why a login is needed:** the `sk-sp-…` key only authorizes model calls. Alibaba exposes plan usage solely through the console gateway (the documented `/api/v1/tokenplan/*` routes return 404; the gateway answers `BailianGateway.Login.NotLogined` to the key; model responses carry no quota headers). So the console session has to be obtained once. Pick whichever is easiest:

| Method | How | Re-auth |
|---|---|---|
| Browser (default) | `/qwen-login` → pick browser. Edge/Chrome opens with a dedicated profile; log in and the window closes itself | Rare: when the ticket expires the extension silently renews it with a headless browser on the same profile. Only when Alibaba's long-term session also ends do you need `/qwen-login` again |
| AccessKey | `/qwen-login ak <AccessKeyId> <Secret>` | Never. Console tokens are minted via `GenerateCLIAccessToken` and refreshed automatically. Needs RAM permission `modelstudio:GenerateCLIAccessToken` (a main-account key already has it) |
| Official CLI | `bl auth login --console` or `bl auth login --open-api` ([@modelstudio/cli](https://github.com/modelstudioai/cli)) | Picked up automatically from `~/.bailian/config.json` |
| Paste | `/qwen-login <login_aliyunid_ticket or full Cookie header>` | Manual |

Environment variables are also honoured: `QWEN_TOKEN_PLAN_COOKIE` / `QWEN_TOKEN_PLAN_CN_COOKIE`, `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` / `ALIBABA_CLOUD_SECURITY_TOKEN`, and `QWEN_USAGE_BROWSER` (browser path).

## Commands

| Command | Description |
|---|---|
| `/qwen-usage` | Refresh and show plan, per-window bars, remaining credits, add-on packs, subscription days |
| `/qwen-login` | Log in (browser / AccessKey / pasted cookie). Append `intl` when the current model is not a Token Plan model |
| `/qwen-logout` | Remove the saved ticket, AccessKey and the dedicated browser profile — the next `/qwen-login` is a clean login (can switch accounts) |

## Footer

```
↑3.2k ↓1.1k 12.5%/1M (auto) mo:23% cr:61.6k/80k    (qwen-token-plan-individual-cn) qwen3.8-max • high
```

- `mo:23%` / `5h:` / `wk:` — used percentage of each window the console reports; `!` above expected pace, `!!` above 1.5× pace
- `cr:61.6k/80k` — remaining credits (plan window remaining + add-on packs) / total
- `cr:/qwen-login` — not logged in yet; `⚠` — showing cached data after a failed refresh
- When the line is too narrow, parts are dropped in order: provider name → cache counts → cost → cumulative tokens → quota collapses to `cr:61.6k`

## Caching

- 60 s cache, single in-flight request, refresh after every assistant message (rate-limited by the cache) and every 30 min when idle
- Exponential backoff for transient errors, 5 min cooldown for auth errors; the last good value stays visible with `⚠`
- Last result persisted to `~/.pi/agent/qwen-usage-cache.json`; credentials in `~/.pi/agent/qwen-usage.json` (mode 600); browser profile in `~/.pi/agent/qwen-usage-browser/`

## How credits are computed

Console APIs (`zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/*`):

- `usage` — `per{N}{Hour|Week|Month}Percentage` (0–1 ratio) and `…ResetTime`; windows are discovered from whatever fields are present
- `subscription` — `specCode` (lite / essential / standard / pro), status, remaining days
- `quota-config` — credits per window for each tier; for mainland monthly plans falls back to the published limits (Lite 20,000 / Essential 45,000 / Standard 80,000 / Pro 200,000)
- `addon/summary` — add-on pack remaining / total credits

Remaining = window limit × (1 − used%) + add-on remaining. The APIs are undocumented and may change; parsing is defensive.

## Limitations

- Team edition (seat / shared-pack) quotas are not supported yet.

## Related

- [pi-kimi-usage](https://github.com/inouemoby/pi-kimi-usage), [pi-claude-usage](https://github.com/inouemoby/pi-claude-usage), [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — same footer for other providers
- References: [modelstudioai/cli](https://github.com/modelstudioai/cli), [CodexBar](https://github.com/steipete/CodexBar), [tracking-llm-plan-usage](https://github.com/KS-OTO/tracking-llm-plan-usage)
