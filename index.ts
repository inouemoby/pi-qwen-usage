import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fetchRemoteModelIds, type ModelLike, planInjection } from "./models.ts";
import { captureConsoleCookie, hasBrowserProfile, removeBrowserProfile } from "./login.ts";
import {
  consoleUrl,
  detectRegion,
  fetchQwenUsage,
  formatCredits,
  formatCreditsExact,
  formatPercent,
  humanDuration,
  normalizeCookie,
  primaryWindow,
  type QwenCredentials,
  type QwenRegion,
  type QwenUsageData,
  QwenUsageError,
  summarizeCredits,
  windowRemainingCredits,
} from "./usage.ts";

/** 成功后 60 秒内只读缓存。 */
const CACHE_MS = 60 * 1000;
/** 非瞬时错误(未登录/无权限等)冷却。 */
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const INITIAL_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const IDLE_REFRESH_MS = 30 * 60 * 1000;
const DISPLAY_TICK_MS = 60 * 1000;
const POST_TURN_DELAY_MS = 2_000;

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(AGENT_DIR, "qwen-usage.json");
const CACHE_FILE = join(AGENT_DIR, "qwen-usage-cache.json");
const BROWSER_PROFILE_DIR = join(AGENT_DIR, "qwen-usage-browser");
/** 静默续期的最短间隔,避免会话真失效时反复启动无头浏览器。 */
const SILENT_RENEW_INTERVAL_MS = 30 * 60 * 1000;

interface StoredConfig {
  cookies?: Partial<Record<QwenRegion, string>>;
  accessKeyId?: string;
  accessKeySecret?: string;
}

function readJson(file: string): any {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

function readConfig(): StoredConfig {
  const raw = readJson(CONFIG_FILE);
  return raw && typeof raw === "object" ? raw : {};
}

/** 读取官方 CLI(bl)的登录信息:~/.bailian/config.json,支持命名 profile。 */
function readBailianCli(region: QwenRegion): QwenCredentials {
  const dir = process.env.BAILIAN_CONFIG_DIR || join(homedir(), ".bailian");
  const raw = readJson(join(dir, "config.json"));
  if (!raw || typeof raw !== "object") return {};
  const active = typeof raw.active_config === "string" && raw[raw.active_config] ? raw[raw.active_config] : raw;
  const consoleRegion = active.console_region ?? raw.console_region ?? "cn-beijing";
  const regionMatches = (consoleRegion === "cn-beijing") === (region === "cn");
  return {
    consoleToken: regionMatches && typeof active.access_token === "string" ? active.access_token : undefined,
    accessKeyId: active.access_key_id ?? raw.access_key_id,
    accessKeySecret: active.access_key_secret ?? raw.access_key_secret,
    securityToken: active.security_token ?? raw.security_token,
  };
}

/** 凭据合并:插件保存的 Cookie → 环境变量 → bl CLI。 */
function resolveCredentials(region: QwenRegion): QwenCredentials {
  const config = readConfig();
  const env = process.env;
  const cli = readBailianCli(region);
  const envCookie = region === "cn"
    ? env.QWEN_TOKEN_PLAN_CN_COOKIE || env.QWEN_TOKEN_PLAN_COOKIE
    : env.QWEN_TOKEN_PLAN_COOKIE;
  return {
    cookie: config.cookies?.[region] || envCookie || undefined,
    consoleToken: cli.consoleToken,
    accessKeyId: config.accessKeyId || env.ALIBABA_CLOUD_ACCESS_KEY_ID || cli.accessKeyId,
    accessKeySecret: config.accessKeySecret || env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || cli.accessKeySecret,
    securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN || cli.securityToken,
  };
}

function hasCredentials(c: QwenCredentials): boolean {
  return Boolean(c.cookie || c.consoleToken || (c.accessKeyId && c.accessKeySecret));
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fitLine(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, width >= 6 ? "..." : "");
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** 0=正常 1=快于预期 2=超过预期 1.5 倍 */
function usageSeverity(percent: number, windowMs: number, resetMs: number): number {
  if (resetMs <= 0) return 0;
  const elapsed = Math.max(0, windowMs - (resetMs - Date.now()));
  const expected = (elapsed / windowMs) * 100;
  if (percent > expected * 1.5) return 2;
  if (percent > expected) return 1;
  return 0;
}

function progressBar(percent: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 5);
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loginHint(_region: QwenRegion): string {
  return "运行 /qwen-login 登录一次控制台(浏览器或 AccessKey)";
}

export default function qwenUsageExtension(pi: ExtensionAPI) {
  // 按地域分别缓存,切换国内/国际模型互不影响。
  const usage = new Map<QwenRegion, QwenUsageData>();
  const inFlight = new Map<QwenRegion, Promise<QwenUsageData>>();
  const nextAttemptAt = new Map<QwenRegion, number>();
  const backoff = new Map<QwenRegion, number>();
  const lastError = new Map<QwenRegion, QwenUsageError | Error>();
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();
  let persistedLoaded = false;
  let hintShown = false;
  const lastSilentRenew = new Map<QwenRegion, number>();
  /** 本进程内已检查过新模型的 provider,避免每次会话都请求 /models。 */
  const modelsChecked = new Set<string>();

  /**
   * 临时补齐 pi 还没内置的 Token Plan 新模型(如 qwen4-max-preview)。
   * 只在运行时注入,不写任何配置;失败静默,不影响用量显示。
   */
  async function injectNewModels(ctx: ExtensionContext): Promise<void> {
    const all = safe<ModelLike[]>(() => (ctx.modelRegistry.getAll() as unknown as ModelLike[]), []);
    const providers = new Map<string, string>();
    for (const model of all) {
      if (providers.has(model.provider) || modelsChecked.has(model.provider)) continue;
      if (detectRegion(model.provider, model.baseUrl) && model.baseUrl) providers.set(model.provider, model.baseUrl);
    }
    for (const [provider, baseUrl] of providers) {
      try {
        const auth = await ctx.modelRegistry.getProviderAuth(provider);
        const apiKey = auth?.auth?.apiKey;
        if (!apiKey) continue; // 没注册 Key 的 provider 下次再查
        modelsChecked.add(provider);
        const existing = safe<ModelLike[]>(
          () => (ctx.modelRegistry.getAll() as unknown as ModelLike[]).filter((m) => m.provider === provider), []);
        const additions = planInjection(await fetchRemoteModelIds(baseUrl, apiKey), existing);
        if (additions.length === 0) continue;
        // 扩展的 models 会整表替换该 provider,所以带上现有全部模型。
        pi.registerProvider(provider, { models: [...existing, ...additions] as any });
      } catch {
        /* 网络或注册失败:保持 pi 原样 */
      }
    }
  }

  /**
   * ticket 过期时,用 /qwen-login 留下的浏览器配置目录无头打开控制台,
   * 阿里云长期会话仍有效时会自动拿到新 ticket。成功返回 true。
   */
  async function trySilentRenew(region: QwenRegion): Promise<boolean> {
    if (!hasBrowserProfile(BROWSER_PROFILE_DIR)) return false;
    if (Date.now() - (lastSilentRenew.get(region) ?? 0) < SILENT_RENEW_INTERVAL_MS) return false;
    lastSilentRenew.set(region, Date.now());
    try {
      const cookie = await captureConsoleCookie(region, BROWSER_PROFILE_DIR, { silent: true });
      if (!cookie || normalizeCookie(cookie) === readConfig().cookies?.[region]) return false;
      saveCookie(region, cookie);
      return true;
    } catch {
      return false;
    }
  }

  let latestCtx: ExtensionContext | null = null;
  let agentBusy = false;
  let thinkingLevel = "off";
  let footerOn = false;
  let footerGeneration = 0;
  let footerTui: { requestRender?: () => void } | null = null;
  let lastPublishedFooterUsage = "";
  let postTurnTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let displayTimer: ReturnType<typeof setInterval> | null = null;

  function regionOf(ctx: ExtensionContext | null): QwenRegion | null {
    if (!ctx) return null;
    return safe(() => detectRegion(ctx.model?.provider, (ctx.model as any)?.baseUrl), null);
  }

  // ── 持久化 ────────────────────────────────────────────
  function loadPersisted(): void {
    if (persistedLoaded) return;
    persistedLoaded = true;
    const raw = readJson(CACHE_FILE);
    for (const region of ["cn", "intl"] as const) {
      const entry = raw?.[region];
      if (entry && Array.isArray(entry.windows) && typeof entry.fetchedAtMs === "number" && !usage.has(region)) {
        usage.set(region, { ...entry, stale: false, warning: undefined });
      }
    }
  }

  function persist(): void {
    try {
      const out: Record<string, unknown> = {};
      for (const [region, data] of usage) {
        const { stale: _s, warning: _w, ...rest } = data;
        out[region] = rest;
      }
      writeJsonAtomic(CACHE_FILE, out);
    } catch {
      /* 只影响下次启动 */
    }
  }

  // ── 拉取:60 秒缓存 + 单飞 + 退避 ─────────────────────
  function getUsage(region: QwenRegion, force = false): Promise<QwenUsageData> {
    loadPersisted();
    const now = Date.now();
    const cached = usage.get(region);
    if (!force) {
      if (cached && !cached.stale && now - cached.fetchedAtMs < CACHE_MS) return Promise.resolve(cached);
      if (now < (nextAttemptAt.get(region) ?? 0)) {
        if (cached) return Promise.resolve(cached);
        return Promise.reject(lastError.get(region) ?? new Error("Qwen 用量暂不可用"));
      }
    }
    const running = inFlight.get(region);
    if (running) return running;
    const request = fetchAndStore(region).finally(() => inFlight.delete(region));
    inFlight.set(region, request);
    return request;
  }

  async function fetchAndStore(region: QwenRegion): Promise<QwenUsageData> {
    try {
      const credentials = resolveCredentials(region);
      if (!hasCredentials(credentials) && !hasBrowserProfile(BROWSER_PROFILE_DIR)) {
        throw new QwenUsageError("NO_CREDENTIALS", `未登录控制台,${loginHint(region)}`);
      }
      let fresh: QwenUsageData;
      try {
        fresh = await fetchQwenUsage({ region, credentials, tokenCache });
      } catch (error) {
        const expired = error instanceof QwenUsageError
          && (error.code === "LOGIN_EXPIRED" || error.code === "NO_CREDENTIALS");
        if (!expired || !(await trySilentRenew(region))) throw error;
        fresh = await fetchQwenUsage({ region, credentials: resolveCredentials(region), tokenCache });
      }
      usage.set(region, fresh);
      lastError.delete(region);
      nextAttemptAt.set(region, Date.now() + CACHE_MS);
      backoff.delete(region);
      persist();
      return fresh;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err instanceof QwenUsageError && err.code === "LOGIN_EXPIRED") {
        err.message = `${err.message},${loginHint(region)}`;
      }
      lastError.set(region, err);
      const retryable = err instanceof QwenUsageError && err.retryable;
      if (retryable) {
        const delay = backoff.get(region) ?? INITIAL_BACKOFF_MS;
        nextAttemptAt.set(region, Date.now() + delay);
        backoff.set(region, Math.min(MAX_BACKOFF_MS, delay * 2));
      } else {
        nextAttemptAt.set(region, Date.now() + ERROR_COOLDOWN_MS);
      }
      const cached = usage.get(region);
      if (cached) {
        const stale = { ...cached, stale: true, warning: err.message };
        usage.set(region, stale);
        return stale;
      }
      throw err;
    }
  }

  async function refresh(ctx: ExtensionContext | null): Promise<void> {
    try {
      const region = regionOf(ctx);
      if (!region) return;
      await getUsage(region);
    } catch (error) {
      // 首次发现没有凭据时提示一次,之后只在 footer 上显示提示。
      if (!hintShown && error instanceof QwenUsageError && error.code === "NO_CREDENTIALS") {
        hintShown = true;
        safe(() => ctx?.ui.notify(`Qwen Token Plan:sk-sp Key 无法查询额度,${loginHint(regionOf(ctx) ?? "cn")}`, "warning"), undefined);
      }
    } finally {
      trigger();
    }
  }

  // ── 重绘 / footer ─────────────────────────────────────
  function requestRenderSafe(): void {
    try {
      footerTui?.requestRender?.();
    } catch {
      /* footer 已释放 */
    }
  }

  function trigger(): void {
    setTimeout(requestRenderSafe, 0);
  }

  function mountFooter(ctx: ExtensionContext): void {
    const generation = ++footerGeneration;
    footerOn = true;
    try {
      ctx.ui.setFooter(createFooterFactory(generation));
    } catch {
      footerOn = false;
    }
  }

  function unmountFooter(ctx: ExtensionContext): void {
    footerGeneration++;
    footerTui = null;
    if (!footerOn) return;
    footerOn = false;
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      /* ctx 已失效 */
    }
  }

  function toggleFooter(ctx: ExtensionContext, force = false): void {
    if (!safe(() => ctx.hasUI, false)) return;
    if (regionOf(ctx)) {
      if (!footerOn || force) mountFooter(ctx);
    } else {
      unmountFooter(ctx);
    }
  }

  function createFooterFactory(generation: number) {
    return (tui: any, theme: any, footerData: any) => {
      if (generation === footerGeneration) footerTui = tui;
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = footerData?.onBranchChange?.(() => {
          if (generation === footerGeneration) requestRenderSafe();
        });
      } catch {
        /* 不支持分支通知 */
      }
      return {
        dispose: () => {
          try {
            unsubscribe?.();
          } catch {
            /* already disposed */
          }
          if (generation === footerGeneration) {
            footerTui = null;
            footerOn = false;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          const w = Math.max(0, Math.floor(finiteOr(width, 80)));
          if (generation !== footerGeneration || !latestCtx) return [fitLine("", w)];
          try {
            return renderFooter(latestCtx, theme, footerData, w);
          } catch {
            return [fitLine("Qwen usage: 显示异常", w)];
          }
        },
      };
    };
  }

  /** Qwen 额度片段;compact=true 时只保留剩余 Credits(宽度不足时使用)。 */
  function quotaParts(region: QwenRegion, compact: boolean): string[] {
    const data = usage.get(region);
    if (!data) {
      const err = lastError.get(region);
      if (err instanceof QwenUsageError && (err.code === "NO_CREDENTIALS" || err.code === "LOGIN_EXPIRED")) {
        return ["cr:/qwen-login"];
      }
      return err ? ["cr:?"] : [];
    }
    const parts: string[] = [];
    const summary = summarizeCredits(data);
    if (!compact) {
      for (const window of data.windows) {
        const severity = usageSeverity(window.usedPercent, window.durationMs, window.resetMs);
        const flag = severity === 2 ? "!!" : severity === 1 ? "!" : "";
        parts.push(`${flag}${window.label}:${formatPercent(window.usedPercent)}%`);
      }
    }
    if (summary.remaining !== null) {
      parts.push(compact || summary.total === null
        ? `cr:${formatCredits(summary.remaining)}`
        : `cr:${formatCredits(summary.remaining)}/${formatCredits(summary.total)}`);
    } else if (compact) {
      const primary = primaryWindow(data);
      if (primary) parts.push(`${primary.label}:${formatPercent(primary.usedPercent)}%`);
    }
    if (data.stale) parts.push("⚠");
    return parts;
  }

  function renderFooter(ctx: ExtensionContext, theme: any, footerData: any, width: number): string[] {
    const sm: any = safe(() => ctx.sessionManager, undefined);

    // 第 1 行:目录 / 分支 / 会话名 / 扩展状态
    const home = process.env.HOME || process.env.USERPROFILE || "";
    let pwd = String(safe(() => ctx.cwd, "") || safe(() => sm?.getCwd?.(), "") || "");
    if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
    const branch = safe<string | null>(() => footerData?.getGitBranch?.(), null);
    if (branch) pwd += ` (${branch})`;
    const sessionName = safe<string | undefined>(() => sm?.getSessionName?.(), undefined);
    if (sessionName) pwd += ` • ${sessionName}`;
    const statusText = [...((footerData?.getExtensionStatuses?.()?.values?.() ?? []) as Iterable<string>)]
      .filter(Boolean).join("  ");
    const statusWidth = statusText ? visibleWidth(statusText) : 0;
    let line1: string;
    if (statusWidth && statusWidth + 12 <= width) {
      const left = truncateToWidth(theme.fg("dim", pwd), width - statusWidth - 2, theme.fg("dim", "..."));
      line1 = left + " ".repeat(Math.max(2, width - visibleWidth(left) - statusWidth)) + theme.fg("dim", statusText);
    } else {
      line1 = fitLine(theme.fg("dim", pwd), width);
    }

    // 第 2 行:token / 上下文 / 额度 / 模型
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const entry of safe<any[]>(() => sm?.getEntries?.() ?? [], [])) {
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      const u = (entry.message as AssistantMessage).usage;
      if (!u) continue;
      input += finiteOr(u.input, 0);
      output += finiteOr(u.output, 0);
      cacheRead += finiteOr(u.cacheRead, 0);
      cacheWrite += finiteOr(u.cacheWrite, 0);
      cost += finiteOr(u.cost?.total, 0);
    }
    const groups: Record<"tokens" | "cache" | "cost", string[]> = { tokens: [], cache: [], cost: [] };
    if (input) groups.tokens.push(`↑${formatTokens(input)}`);
    if (output) groups.tokens.push(`↓${formatTokens(output)}`);
    if (cacheRead) groups.cache.push(`R${formatTokens(cacheRead)}`);
    if (cacheWrite) groups.cache.push(`W${formatTokens(cacheWrite)}`);
    if (cost) groups.cost.push(`$${cost.toFixed(3)}`);

    const cu: any = safe(() => ctx.getContextUsage(), undefined);
    const model: any = safe(() => ctx.model, undefined);
    const cw = finiteOr(cu?.contextWindow, finiteOr(model?.contextWindow, 0));
    const pct = typeof cu?.percent === "number" && Number.isFinite(cu.percent) ? cu.percent.toFixed(1) : "?";
    let contextText = pct === "?" ? `?/${formatTokens(cw)} (auto)` : `${pct}%/${formatTokens(cw)} (auto)`;
    if (pct !== "?" && Number(pct) > 90) contextText = theme.fg("error", contextText);
    else if (pct !== "?" && Number(pct) > 70) contextText = theme.fg("warning", contextText);

    const region = regionOf(ctx) ?? "cn";
    let quota = quotaParts(region, false);

    let modelText = String(model?.id || "no-model");
    if (model?.reasoning) modelText = thinkingLevel === "off" ? `${modelText} • thinking off` : `${modelText} • ${thinkingLevel}`;
    const withProvider = model ? `(${model.provider}) ${modelText}` : modelText;

    // 宽度不足时依次省略:供应商名 → 缓存 → 费用 → 累计 token → 额度压缩为仅剩余 Credits
    const leftOf = () => [...groups.tokens, ...groups.cache, ...groups.cost, contextText, ...quota].join(" ");
    let left = leftOf();
    let right = withProvider;
    const fits = () => visibleWidth(left) + 2 + visibleWidth(right) <= width;
    if (!fits()) right = modelText;
    for (const key of ["cache", "cost", "tokens"] as const) {
      if (fits()) break;
      groups[key].length = 0;
      left = leftOf();
    }
    if (!fits()) {
      quota = quotaParts(region, true);
      left = leftOf();
    }

    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    let line2: string;
    if (lw + 2 + rw <= width) line2 = left + " ".repeat(width - lw - rw) + right;
    else if (lw + 2 < width) line2 = truncateToWidth(`${left}  ${right}`, width, "");
    else line2 = truncateToWidth(left, width, width >= 6 ? "..." : "");

    if (line2 !== lastPublishedFooterUsage) {
      lastPublishedFooterUsage = line2;
      pi.events.emit("pi-footer:usage", { source: "pi-qwen-usage", text: line2 });
    }
    return [line1, fitLine(theme.fg("dim", line2), width)];
  }

  // ── 定时器 ────────────────────────────────────────────
  function startTimers(): void {
    stopTimers();
    idleTimer = setInterval(() => {
      if (!agentBusy && regionOf(latestCtx)) void refresh(latestCtx);
    }, IDLE_REFRESH_MS);
    displayTimer = setInterval(() => {
      if (footerOn) trigger();
    }, DISPLAY_TICK_MS);
    (idleTimer as any).unref?.();
    (displayTimer as any).unref?.();
  }

  function stopTimers(): void {
    if (idleTimer) clearInterval(idleTimer);
    if (displayTimer) clearInterval(displayTimer);
    if (postTurnTimer) clearTimeout(postTurnTimer);
    idleTimer = displayTimer = postTurnTimer = null;
  }

  // ── 事件 ──────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    try {
      latestCtx = ctx;
      agentBusy = false;
      thinkingLevel = safe(() => pi.getThinkingLevel?.() || "off", "off");
      loadPersisted();
      startTimers();
      toggleFooter(ctx, true);
      void refresh(ctx);
      void injectNewModels(ctx);
    } catch {
      /* 不影响 pi 启动 */
    }
  });

  pi.on("session_shutdown", async () => {
    stopTimers();
    footerGeneration++;
    footerOn = false;
    footerTui = null;
    latestCtx = null;
    agentBusy = false;
  });

  pi.on("agent_start", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = true;
  });

  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (postTurnTimer) clearTimeout(postTurnTimer);
    postTurnTimer = setTimeout(() => {
      postTurnTimer = null;
      void refresh(latestCtx);
    }, POST_TURN_DELAY_MS);
  });

  // 每条 assistant 消息结束都尝试刷新,实际请求频率由 60 秒缓存限制。
  pi.on("message_end", async (event: any, ctx) => {
    latestCtx = ctx;
    if (event?.message?.role !== "assistant") return;
    void refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (regionOf(ctx)) {
      // 延迟到下一个宏任务,让其他 usage 插件先卸载,避免互相覆盖 footer。
      setTimeout(() => {
        const current = latestCtx;
        if (!current || !regionOf(current)) return;
        toggleFooter(current, true);
        void refresh(current);
      }, 0);
    } else {
      unmountFooter(ctx);
    }
  });

  pi.on("thinking_level_select", async (event: any) => {
    thinkingLevel = event?.level || "off";
    trigger();
  });

  // ── /qwen 命令 ────────────────────────────────────────
  function saveCookie(region: QwenRegion, cookie: string): void {
    const config = readConfig();
    config.cookies = { ...(config.cookies ?? {}), [region]: normalizeCookie(cookie) };
    writeJsonAtomic(CONFIG_FILE, config);
    usage.delete(region);
    nextAttemptAt.delete(region);
    lastError.delete(region);
  }

  function renderDetails(data: QwenUsageData): string {
    const summary = summarizeCredits(data);
    const plan = data.plan;
    const title = plan
      ? `══ Qwen Token Plan ${plan.displayName}(${data.region === "cn" ? "国内" : "国际"})══`
      : `══ Qwen Token Plan(${data.region === "cn" ? "国内" : "国际"})══`;
    const lines = [title];
    for (const window of data.windows) {
      const remaining = windowRemainingCredits(window);
      const credit = window.limitCredits !== null && remaining !== null
        ? `  剩 ${formatCreditsExact(remaining)} / ${formatCreditsExact(window.limitCredits)} cr`
        : "";
      const reset = window.resetMs > 0 ? `  ${humanDuration(window.resetMs - Date.now())} 后重置` : "";
      lines.push(`${window.label.padEnd(4)}${progressBar(window.usedPercent)}  已用 ${formatPercent(window.usedPercent)}%${credit}${reset}`);
    }
    if (data.addon && (data.addon.totalCredits > 0 || data.addon.activeCount > 0)) {
      lines.push(`用量包  剩 ${formatCreditsExact(data.addon.remainingCredits)} / ${formatCreditsExact(data.addon.totalCredits)} cr(${data.addon.activeCount} 个)`);
    }
    if (summary.remaining !== null) {
      lines.push(`可用合计  ${formatCreditsExact(summary.remaining)} Credits`);
    }
    if (summary.bottleneck) {
      lines.push(`⚠ ${summary.bottleneck.label} 窗口剩余更少,会先触顶`);
    }
    if (plan) {
      const extra = [plan.status && `状态 ${plan.status}`, plan.remainingDays !== null && `剩 ${plan.remainingDays} 天`,
        plan.autoRenew !== null && (plan.autoRenew ? "自动续费" : "未开自动续费")].filter(Boolean).join(" · ");
      if (extra) lines.push(extra);
    }
    lines.push(`数据来源:${data.source === "cookie" ? "控制台登录态" : data.source === "aksk" ? "AccessKey" : "bl CLI 登录"}`);
    if (data.stale) lines.push(`⚠ 显示的是旧数据${data.warning ? `:${data.warning}` : ""}`);
    return lines.join("\n");
  }

  async function login(ctx: ExtensionContext, region: QwenRegion, pasted: string): Promise<void> {
    let cookie = pasted.trim();
    if (!cookie) {
      ctx.ui.notify(`正在打开浏览器,请在弹出的窗口里登录${region === "cn" ? "百炼控制台" : " Qwen Cloud"}(建议勾选保持登录),完成后窗口会自动关闭…`, "info");
      cookie = (await captureConsoleCookie(region, BROWSER_PROFILE_DIR)) ?? "";
      if (!cookie) throw new Error("没有读取到登录态");
    }
    lastSilentRenew.delete(region);
    saveCookie(region, cookie);
    const data = await getUsage(region, true);
    ctx.ui.notify(`Qwen 控制台已登录
${renderDetails(data)}`, "info");
  }

  /** 当前模型不是 Qwen Token Plan 时,参数里写 intl 可指定国际站,默认国内。 */
  function commandRegion(ctx: ExtensionContext, args: string): QwenRegion {
    return regionOf(ctx) ?? (/(^|\s)intl(\s|$)/i.test(args) ? "intl" : "cn");
  }

  /** AccessKey 登录:永久有效、无需网页,插件自动换取并续期控制台 token。 */
  async function loginWithAccessKey(ctx: ExtensionContext, region: QwenRegion, id: string, secret: string): Promise<void> {
    const config = readConfig();
    config.accessKeyId = id.trim();
    config.accessKeySecret = secret.trim();
    writeJsonAtomic(CONFIG_FILE, config);
    tokenCache.clear();
    usage.delete(region);
    lastError.delete(region);
    nextAttemptAt.delete(region);
    const data = await getUsage(region, true);
    if (data.stale) throw new Error(data.warning ?? "AccessKey 验证失败");
    ctx.ui.notify(`已用 AccessKey 登录(长期有效,无需再登录)\n${renderDetails(data)}`, "info");
  }

  pi.registerCommand("qwen-login", {
    description: "登录 Qwen Token Plan 控制台以读取剩余额度:浏览器登录,或 /qwen-login ak <AccessKeyId> <Secret>",
    getArgumentCompletions: (prefix: string) =>
      ["ak", "browser", "intl"].filter((s) => s.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const text = String(args ?? "").trim();
      const region = commandRegion(ctx, text);
      const tokens = text.split(/\s+/).filter((t) => t && !/^(cn|intl)$/i.test(t));
      try {
        let mode = tokens[0]?.toLowerCase();
        if (mode !== "ak" && mode !== "browser") {
          if (tokens.length > 0) {
            // 直接附上的 Cookie / ticket
            await login(ctx, region, tokens.join(" "));
            return;
          }
          const choice = await ctx.ui.select("选择 Qwen 控制台登录方式", [
            "浏览器登录(弹出窗口登录一次,之后自动续期)",
            "AccessKey(长期有效,不用网页;需要 AK/SK)",
          ]);
          if (!choice) return;
          mode = choice.startsWith("AccessKey") ? "ak" : "browser";
        }
        if (mode === "ak") {
          const id = tokens[1] || await ctx.ui.input("AccessKey ID", "LTAI...");
          if (!id?.trim()) return;
          const secret = tokens[2] || await ctx.ui.input("AccessKey Secret", "");
          if (!secret?.trim()) return;
          await loginWithAccessKey(ctx, region, id, secret);
        } else {
          await login(ctx, region, "");
        }
      } catch (error) {
        ctx.ui.notify(`Qwen 登录失败:${errorMessage(error)}`, "error");
      } finally {
        trigger();
      }
    },
  });

  pi.registerCommand("qwen-logout", {
    description: "清除保存的 Qwen Token Plan 控制台登录态",
    handler: async (args, ctx) => {
      const region = commandRegion(ctx, String(args ?? ""));
      const config = readConfig();
      if (config.cookies) delete config.cookies[region];
      delete config.accessKeyId;
      delete config.accessKeySecret;
      writeJsonAtomic(CONFIG_FILE, config);
      tokenCache.clear();
      // 同时删除浏览器配置目录,下次 /qwen-login 是全新登录(可换账号)。
      try {
        removeBrowserProfile(BROWSER_PROFILE_DIR);
      } catch {
        /* 浏览器仍占用时忽略 */
      }
      usage.delete(region);
      lastError.delete(region);
      nextAttemptAt.delete(region);
      persist();
      ctx.ui.notify("已退出 Qwen 控制台登录(保存的 ticket 与浏览器会话均已清除),重新登录请运行 /qwen-login", "info");
      trigger();
    },
  });

  pi.registerCommand("qwen-usage", {
    description: "查看 Qwen Token Plan 剩余 Credits 与各窗口用量(会立即刷新)",
    handler: async (args, ctx) => {
      const region = commandRegion(ctx, String(args ?? ""));
      try {
        const data = await getUsage(region, true);
        ctx.ui.notify(renderDetails(data), data.stale ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(`Qwen:${errorMessage(error)}`, "error");
      } finally {
        trigger();
      }
    },
  });
}
