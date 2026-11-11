/**
 * Qwen / 阿里云百炼 Token Plan(个人版)用量查询核心逻辑。
 *
 * 背景:套餐专属的 `sk-sp-...` Key 只能调用模型,控制台网关会回 `BailianGateway.Login.NotLogined`。
 * 用量只能走百炼控制台网关(与官方 CLI `bl usage token-plan` 和控制台页面相同),鉴权方式有三种:
 *
 * 1. 控制台会话 Cookie(`login_aliyunid_ticket`),走 `/data/api.json`,无需 RAM 授权;
 * 2. 控制台 access token(`bl auth login --console` 写入 ~/.bailian/config.json),走 `/cli/api.json`;
 * 3. AccessKey(AK/SK):ACS3-HMAC-SHA256 签名调用 `GenerateCLIAccessToken` 换 token,再走 `/cli/api.json`。
 *    需要 RAM 权限 `modelstudio:GenerateCLIAccessToken`。
 *
 * 用到的控制台 API(`zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/*`):
 * - usage         → per5Hour / per1Week / per1Month 的 Percentage(0-1 比值)与 ResetTime
 * - subscription  → specCode(lite/essential/standard/pro)、status、remainingDays、endTime
 * - quota-config  → 各档位每个窗口的 Credits 上限,如 { standard: { monthly: 80000 } }
 * - addon/summary → 用量包 remainingCredits / totalCredits / activeCount
 *
 * 接口未公开,字段可能随版本变化,因此解析一律做防御性处理。
 * 参考:modelstudioai/cli、steipete/CodexBar、KS-OTO/tracking-llm-plan-usage、can1357/oh-my-pi。
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

export type QwenRegion = "cn" | "intl";
export type QwenSource = "cookie" | "console-token" | "aksk";

export const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
export const SUBSCRIPTION_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
export const QUOTA_CONFIG_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";
export const ADDON_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary";

const GATEWAY_PRODUCT = "sfm_bailian";
const ACCESS_TOKEN_PATH = "/modelstudio/cli/generateAccessToken";
const ACCESS_TOKEN_ACTION = "GenerateCLIAccessToken";
const ACCESS_TOKEN_VERSION = "2026-02-10";
const REQUEST_TIMEOUT_MS = 20_000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

interface RegionProfile {
  /** 控制台页面 origin(Cookie 通道的 Origin 头)。 */
  origin: string;
  /** 取 SEC_TOKEN 的会话地址。 */
  sessionUrl: string;
  /** Cookie 通道的 Referer。 */
  dashboardUrl: string;
  /** Cookie 通道的网关主机(/data/api.json)。 */
  cookieGatewayHost: string;
  /** CLI token 通道的网关主机(/cli/api.json)。 */
  cliGatewayHost: string;
  gatewayAction: string;
  /** 表单字段 region。 */
  consoleRegion: string;
  /** GenerateCLIAccessToken 的 OpenAPI 主机。 */
  modelStudioHost: string;
  /** 订阅详情要求携带的商品码。 */
  commodityCode: string;
  language: string;
  cookieCornerstone: Record<string, unknown>;
}

export const REGION_PROFILES: Record<QwenRegion, RegionProfile> = {
  cn: {
    origin: "https://bailian.console.aliyun.com",
    sessionUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
    dashboardUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
    cookieGatewayHost: "bailian-cs.console.aliyun.com",
    cliGatewayHost: "bailian-cs.console.aliyun.com",
    gatewayAction: "BroadScopeAspnGateway",
    consoleRegion: "cn-beijing",
    modelStudioHost: "modelstudio.cn-beijing.aliyuncs.com",
    commodityCode: "sfm_tokenplansolo_public_cn",
    language: "zh-CN",
    cookieCornerstone: {
      feURL: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      switchUserType: 3,
      domain: "bailian.console.aliyun.com",
      consoleSite: "BAILIAN_ALIYUN",
      userNickName: "",
      userPrincipalName: "",
      xsp_lang: "zh-CN",
    },
  },
  intl: {
    origin: "https://home.qwencloud.com",
    sessionUrl: "https://home.qwencloud.com/tool/user/info.json",
    dashboardUrl: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
    cookieGatewayHost: "cs-data.qwencloud.com",
    cliGatewayHost: "bailian-singapore-cs.alibabacloud.com",
    gatewayAction: "IntlBroadScopeAspnGateway",
    consoleRegion: "ap-southeast-1",
    modelStudioHost: "modelstudio.ap-southeast-1.aliyuncs.com",
    commodityCode: "sfm_tokenplansolo_public_intl",
    language: "en-US",
    cookieCornerstone: {
      domain: "home.qwencloud.com",
      consoleSite: "QWENCLOUD",
      console: "ONE_CONSOLE",
      xsp_lang: "en-US",
      protocol: "V2",
      productCode: "p_efm",
    },
  },
};

/** 控制台页面对应的「我的订阅」地址,供提示用户登录/复制 Cookie。 */
export function consoleUrl(region: QwenRegion): string {
  return REGION_PROFILES[region].dashboardUrl;
}

/**
 * 国内个人版官方公布的每月 Credits 限额(2026-11-09 调整后)。
 * 仅在 quota-config 接口没有返回数值时兜底使用。
 */
export const CN_MONTHLY_FALLBACK: Record<string, number> = {
  lite: 20_000,
  essential: 45_000,
  standard: 80_000,
  pro: 200_000,
};

// ─── 错误 ──────────────────────────────────────────────────────────

export type QwenErrorCode =
  | "NO_CREDENTIALS"
  | "LOGIN_EXPIRED"
  | "NO_PERMISSION"
  | "WORKSPACE_NOT_AUTHORISED"
  | "GATEWAY_ERROR"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "NO_USAGE_DATA";

export class QwenUsageError extends Error {
  readonly code: QwenErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: QwenErrorCode, message: string, retryable = false, status?: number) {
    super(message);
    this.name = "QwenUsageError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

// ─── 数据结构 ──────────────────────────────────────────────────────

export interface QwenWindow {
  /** 字段前缀,如 per1Month。 */
  key: string;
  /** 短标签,如 5h / wk / mo。 */
  label: string;
  /** 窗口长度(毫秒,月按 30 天估算)。 */
  durationMs: number;
  /** 已用百分比 0-100。 */
  usedPercent: number;
  /** 重置时间(毫秒时间戳,0 表示未知)。 */
  resetMs: number;
  /** 该窗口的 Credits 上限(未知为 null)。 */
  limitCredits: number | null;
}

export interface QwenPlan {
  specCode: string;
  displayName: string;
  status: string;
  remainingDays: number | null;
  startMs: number;
  endMs: number;
  autoRenew: boolean | null;
}

export interface QwenAddon {
  remainingCredits: number;
  totalCredits: number;
  activeCount: number;
}

export interface QwenUsageData {
  region: QwenRegion;
  source: QwenSource;
  plan: QwenPlan | null;
  /** 按窗口长度从短到长排序。 */
  windows: QwenWindow[];
  addon: QwenAddon | null;
  fetchedAtMs: number;
  stale: boolean;
  warning?: string;
}

// ─── 通用解析工具 ──────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** 接口里有些字段是 JSON 字符串(如 Data),展开后才能继续向下找。 */
function expandJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** 深度优先查找第一个含有任一指定键的对象(最多 8 层,防御异常结构)。 */
export function findObject(root: unknown, keys: readonly string[], depth = 0): JsonObject | null {
  if (depth > 8) return null;
  const value = expandJsonString(root);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = asObject(value);
  if (!obj) return null;
  if (keys.some((key) => key in obj && obj[key] !== null && obj[key] !== undefined)) return obj;
  for (const child of Object.values(obj)) {
    const found = findObject(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 已用比例 → 百分比(0-100)。
 * 接口通常返回 0-1 比值(0.2750906925 = 27.51%),个别网关会直接给百分数,因此 >1 视为百分数。
 */
export function toUsedPercent(value: unknown): number | null {
  const num = toNumber(value);
  if (num === null || num < 0) return null;
  return Math.min(100, num > 1 ? num : num * 100);
}

/** 时间戳归一化为毫秒:秒级(<1e12)×1000;也接受 ISO 字符串。 */
export function toTimestampMs(value: unknown): number {
  const num = toNumber(value);
  if (num !== null) {
    if (num <= 0) return 0;
    return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ─── 网关响应 ──────────────────────────────────────────────────────

/** 检查网关信封里的业务错误;HTTP 200 + success:false 是常态的失败形式。 */
export function checkGatewayEnvelope(json: unknown): void {
  const root = asObject(json);
  if (!root) throw new QwenUsageError("INVALID_RESPONSE", "控制台网关返回的不是 JSON 对象");
  const data = asObject(root.data);
  const rejected = data?.success === false || root.successResponse === false;
  if (!rejected) return;

  const errorCode = toText(data?.errorCode) || toText(root.code) || "UnknownError";
  const errorMsg = toText(data?.errorMsg) || toText(root.message) || errorCode;
  if (errorCode.includes("NotLogined") || errorCode.includes("NotLogin")) {
    throw new QwenUsageError("LOGIN_EXPIRED", "控制台登录态无效或已过期");
  }
  if (errorCode.includes("NotAuthorised") || errorCode.includes("NotAuthorized")) {
    throw new QwenUsageError(
      "WORKSPACE_NOT_AUTHORISED",
      `控制台拒绝访问(${errorCode}):该账号未加入百炼业务空间或无 Token Plan 权限`,
    );
  }
  throw new QwenUsageError("GATEWAY_ERROR", `控制台网关错误:${errorMsg}`);
}

/**
 * 解开网关信封,返回最内层业务负载。
 * 常见形态:`data.DataV2.data.data`;也兼容 `data.Data`(JSON 字符串)与 `data.data`。
 */
export function unwrapPayload(json: unknown): unknown {
  const root = asObject(json);
  if (!root) return json;
  let current: unknown = root.data ?? root;
  for (let i = 0; i < 4; i++) {
    const obj = asObject(expandJsonString(current));
    if (!obj) return expandJsonString(current);
    if (obj.DataV2 !== undefined) {
      current = obj.DataV2;
      continue;
    }
    if (obj.Data !== undefined && !("per1MonthPercentage" in obj)) {
      current = obj.Data;
      continue;
    }
    if (obj.data !== undefined) {
      current = obj.data;
      continue;
    }
    return obj;
  }
  return expandJsonString(current);
}

// ─── 业务字段解析 ──────────────────────────────────────────────────

const WINDOW_FIELD = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;
const UNIT_HOURS: Record<string, number> = { Hour: 1, Day: 24, Week: 24 * 7, Month: 24 * 30 };
const USAGE_KEYS = ["per5HourPercentage", "per1WeekPercentage", "per1MonthPercentage", "per1DayPercentage"];

function windowLabel(count: number, unit: string): string {
  if (count === 1 && unit === "Week") return "wk";
  if (count === 1 && unit === "Month") return "mo";
  if (count === 1 && unit === "Day") return "day";
  return `${count}${unit === "Hour" ? "h" : unit === "Day" ? "d" : unit === "Week" ? "w" : "mo"}`;
}

/** 从 per* 字段自动发现窗口,计量方式调整(5h/周/月)时无需改代码。 */
export function parseUsageWindows(payload: unknown): QwenWindow[] {
  const source = findObject(payload, USAGE_KEYS) ?? asObject(payload);
  if (!source) return [];
  const windows = new Map<string, QwenWindow & { hasPercent: boolean }>();
  for (const [field, value] of Object.entries(source)) {
    const match = WINDOW_FIELD.exec(field);
    if (!match) continue;
    const [, countText, unit, kind] = match;
    const count = Number(countText);
    const key = `per${count}${unit}`;
    const window = windows.get(key) ?? {
      key,
      label: windowLabel(count, unit),
      durationMs: count * UNIT_HOURS[unit] * 3_600_000,
      usedPercent: 0,
      resetMs: 0,
      limitCredits: null,
      hasPercent: false,
    };
    if (kind === "Percentage") {
      const percent = toUsedPercent(value);
      if (percent !== null) {
        window.usedPercent = percent;
        window.hasPercent = true;
      }
    } else {
      window.resetMs = toTimestampMs(value);
    }
    windows.set(key, window);
  }
  // 只有重置时间、没有百分比的窗口视为 0 用量(周期刚开始时官方会省略百分比)。
  return [...windows.values()]
    .filter((w) => w.hasPercent || w.resetMs > 0)
    .map(({ hasPercent: _hasPercent, ...w }) => w)
    .sort((a, b) => a.durationMs - b.durationMs);
}

const PLAN_NAMES: Record<string, string> = {
  lite: "Lite",
  essential: "Essential",
  standard: "Standard",
  pro: "Pro",
  max: "Max",
};

export function displayPlanName(specCode: string): string {
  const lower = specCode.toLowerCase();
  return PLAN_NAMES[lower] ?? specCode;
}

export function parseSubscription(payload: unknown): QwenPlan | null {
  const obj = findObject(payload, ["specCode", "spec_code"]);
  if (!obj) return null;
  const specCode = toText(obj.specCode ?? obj.spec_code);
  if (!specCode) return null;
  const remainingDays = toNumber(obj.remainingDays);
  return {
    specCode,
    displayName: displayPlanName(specCode),
    status: toText(obj.status),
    remainingDays: remainingDays === null ? null : Math.trunc(remainingDays),
    startMs: toTimestampMs(obj.startTime),
    endMs: toTimestampMs(obj.endTime),
    autoRenew: typeof obj.autoRenewFlag === "boolean" ? obj.autoRenewFlag : null,
  };
}

const QUOTA_FIELD_ALIASES: Record<string, string[]> = {
  per5Hour: ["five_hour", "fiveHour", "per5Hour", "5h"],
  per1Week: ["weekly", "week", "per1Week", "seven_day", "sevenDay"],
  per1Month: ["monthly", "month", "per1Month"],
  per1Day: ["daily", "day", "per1Day"],
};

function quotaForPlan(payload: unknown, specCode: string): JsonObject | null {
  const wanted = specCode.toLowerCase();
  const visit = (value: unknown, depth: number): JsonObject | null => {
    if (depth > 8) return null;
    const expanded = expandJsonString(value);
    if (Array.isArray(expanded)) {
      for (const item of expanded) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const obj = asObject(expanded);
    if (!obj) return null;
    // 形态一:{ standard: { monthly: 80000 } }
    for (const [key, child] of Object.entries(obj)) {
      if (key.toLowerCase() === wanted && asObject(expandJsonString(child))) {
        return asObject(expandJsonString(child));
      }
    }
    // 形态二:[{ specCode: "standard", monthly: 80000 }]
    const code = toText(obj.specCode ?? obj.spec_code ?? obj.planCode ?? obj.plan).toLowerCase();
    if (code === wanted) return obj;
    for (const child of Object.values(obj)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(payload, 0);
}

/** 给每个窗口填上 Credits 上限:优先 quota-config,其次国内月额度兜底表。 */
export function applyQuotaLimits(
  windows: QwenWindow[],
  plan: QwenPlan | null,
  quotaConfig: unknown,
  region: QwenRegion,
): QwenWindow[] {
  const specCode = plan?.specCode;
  const quota = specCode && quotaConfig !== undefined ? quotaForPlan(quotaConfig, specCode) : null;
  return windows.map((window) => {
    let limit: number | null = null;
    if (quota) {
      for (const alias of QUOTA_FIELD_ALIASES[window.key] ?? [window.key]) {
        const value = toNumber(quota[alias]);
        if (value !== null && value > 0) {
          limit = value;
          break;
        }
      }
    }
    if (limit === null && region === "cn" && window.key === "per1Month" && specCode) {
      limit = CN_MONTHLY_FALLBACK[specCode.toLowerCase()] ?? null;
    }
    return { ...window, limitCredits: limit };
  });
}

export function parseAddon(payload: unknown): QwenAddon | null {
  const obj = findObject(payload, ["remainingCredits", "totalCredits"]);
  if (!obj) return null;
  const remaining = toNumber(obj.remainingCredits);
  const total = toNumber(obj.totalCredits);
  if (remaining === null && total === null) return null;
  return {
    remainingCredits: Math.max(0, remaining ?? 0),
    totalCredits: Math.max(0, total ?? 0),
    activeCount: Math.max(0, Math.trunc(toNumber(obj.activeCount) ?? 0)),
  };
}

// ─── Credits 汇总 ──────────────────────────────────────────────────

export function windowRemainingCredits(window: QwenWindow): number | null {
  if (window.limitCredits === null) return null;
  return Math.max(0, window.limitCredits * (1 - window.usedPercent / 100));
}

/** 套餐主额度窗口:有月窗口用月窗口,否则取最长窗口(决定整个周期能用多少)。 */
export function primaryWindow(data: Pick<QwenUsageData, "windows">): QwenWindow | null {
  return data.windows.find((w) => w.key === "per1Month") ?? data.windows[data.windows.length - 1] ?? null;
}

export interface CreditSummary {
  /** 套餐剩余 + 用量包剩余;套餐上限未知时为 null。 */
  remaining: number | null;
  /** 套餐上限 + 用量包总量;未知时为 null。 */
  total: number | null;
  planRemaining: number | null;
  addonRemaining: number;
  /**
   * 当前最紧的限制:滚动窗口(5h/周)可能先于月额度触顶,
   * 这里给出所有已知上限窗口里剩余最少的那个,未知则为 null。
   */
  bottleneck: QwenWindow | null;
}

export function summarizeCredits(data: Pick<QwenUsageData, "windows" | "addon">): CreditSummary {
  const primary = primaryWindow(data);
  const planRemaining = primary ? windowRemainingCredits(primary) : null;
  const addonRemaining = data.addon?.remainingCredits ?? 0;
  const addonTotal = data.addon?.totalCredits ?? 0;
  let bottleneck: QwenWindow | null = null;
  let bottleneckRemaining = Infinity;
  for (const window of data.windows) {
    const remaining = windowRemainingCredits(window);
    if (remaining !== null && remaining < bottleneckRemaining) {
      bottleneck = window;
      bottleneckRemaining = remaining;
    }
  }
  return {
    remaining: planRemaining === null ? (data.addon ? addonRemaining : null) : planRemaining + addonRemaining,
    total: primary?.limitCredits != null ? primary.limitCredits + addonTotal : data.addon ? addonTotal || null : null,
    planRemaining,
    addonRemaining,
    bottleneck: bottleneck && bottleneck !== primary ? bottleneck : null,
  };
}

// ─── Cookie 处理 ───────────────────────────────────────────────────

/**
 * 归一化用户粘贴的 Cookie:
 * - 接受整段 Cookie 头(可带 `Cookie:` 前缀);
 * - 接受单独的 `login_aliyunid_ticket` 值(不含 `=`),自动补上名字。
 */
export function normalizeCookie(raw: string): string {
  let value = raw.trim().replace(/^cookie\s*:\s*/i, "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return "";
  return value.includes("=") ? value : `login_aliyunid_ticket=${value}`;
}

export function cookieValue(header: string, name: string): string | undefined {
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index < 0) continue;
    if (segment.slice(0, index).trim() !== name) continue;
    const value = segment.slice(index + 1).trim();
    return value || undefined;
  }
  return undefined;
}

// ─── ACS3-HMAC-SHA256 签名(换取控制台 token 用) ────────────────────

export interface Acs3SignOptions {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  action: string;
  version: string;
  host: string;
  pathname: string;
  method?: string;
  body?: string;
  queryString?: string;
  /** 测试注入用;默认当前时间。 */
  date?: string;
  /** 测试注入用;默认随机 UUID。 */
  nonce?: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 与官方 CLI `packages/core/src/client/acs.ts` 相同的 ACS3 签名。 */
export function signAcs3(opts: Acs3SignOptions): Record<string, string> {
  const body = opts.body ?? "";
  const hashedBody = sha256Hex(body);
  const headers: Record<string, string> = {
    host: opts.host,
    "x-acs-action": opts.action,
    "x-acs-version": opts.version,
    "x-acs-date": opts.date ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": opts.nonce ?? randomUUID(),
    "x-acs-content-sha256": hashedBody,
    "content-type": "application/json",
  };
  if (opts.securityToken) headers["x-acs-security-token"] = opts.securityToken;

  const signedNames = Object.keys(headers)
    .filter((name) => name === "host" || name === "content-type" || name.startsWith("x-acs-"))
    .sort();
  const canonicalHeaders = `${signedNames.map((name) => `${name}:${headers[name]}`).join("\n")}\n`;
  const signedHeaders = signedNames.join(";");
  const canonicalRequest = [
    opts.method ?? "POST",
    opts.pathname,
    opts.queryString ?? "",
    canonicalHeaders,
    signedHeaders,
    hashedBody,
  ].join("\n");
  const signature = createHmac("sha256", opts.accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`, "utf8")
    .digest("hex");
  headers.authorization =
    `ACS3-HMAC-SHA256 Credential=${opts.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}

// ─── 传输层 ────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface QwenCredentials {
  /** 控制台会话 Cookie(已归一化或原始粘贴值均可)。 */
  cookie?: string;
  /** 控制台 access token(如 `bl auth login --console` 的 access_token)。 */
  consoleToken?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
}

export interface FetchOptions {
  region: QwenRegion;
  credentials: QwenCredentials;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** AK/SK 换到的 token 缓存(由调用方持有,跨次刷新复用)。 */
  tokenCache?: Map<string, { token: string; expiresAt: number }>;
  now?: () => number;
  /** usage 返回空窗口时的重试间隔(测试时设为 0)。 */
  retryDelayMs?: number;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

async function doFetch(fetchImpl: FetchLike, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: requestSignal(signal) });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new QwenUsageError("NETWORK_ERROR", `请求失败:${message}`, true);
  }
}

async function readGatewayResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    if (response.status === 401 || response.status === 403) {
      throw new QwenUsageError("LOGIN_EXPIRED", `控制台网关拒绝访问(HTTP ${response.status})`, false, response.status);
    }
    throw new QwenUsageError(
      "HTTP_ERROR",
      `控制台网关返回 HTTP ${response.status}${text ? `:${text.slice(0, 160)}` : ""}`,
      retryable,
      response.status,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const lower = text.toLowerCase();
    if (lower.includes("<html") && (lower.includes("login") || lower.includes("signin") || lower.includes("登录"))) {
      throw new QwenUsageError("LOGIN_EXPIRED", "控制台返回了登录页,登录态已失效");
    }
    throw new QwenUsageError("INVALID_RESPONSE", `控制台网关返回了非 JSON 内容:${text.slice(0, 120)}`);
  }
  checkGatewayEnvelope(json);
  return unwrapPayload(json);
}

/** 一个可调用控制台 API 的通道。 */
interface ConsoleChannel {
  source: QwenSource;
  call(api: string, data?: JsonObject): Promise<unknown>;
}

/** 从控制台页面取 SEC_TOKEN(国内站在 HTML 里,国际站在 info.json 里)。取不到返回 undefined。 */
async function fetchSecToken(
  fetchImpl: FetchLike,
  region: QwenRegion,
  cookie: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const profile = REGION_PROFILES[region];
  let response: Response;
  try {
    response = await doFetch(fetchImpl, profile.sessionUrl, {
      method: "GET",
      headers: {
        Accept: region === "cn"
          ? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
          : "application/json, text/plain, */*",
        Cookie: cookie,
        Referer: `${profile.origin}/`,
        "User-Agent": BROWSER_USER_AGENT,
      },
      redirect: "manual",
    }, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
  if (!response.ok) return undefined;
  const text = await response.text().catch(() => "");
  if (region === "cn") {
    return /\bSEC_TOKEN\s*[:=]\s*["']([^"']+)["']/.exec(text)?.[1]
      ?? /\bsec_token\s*[:=]\s*["']([^"']+)["']/.exec(text)?.[1];
  }
  try {
    const json = asObject(JSON.parse(text));
    const data = asObject(json?.data);
    return typeof data?.secToken === "string" && data.secToken ? data.secToken : undefined;
  } catch {
    return undefined;
  }
}

function cookieChannel(fetchImpl: FetchLike, region: QwenRegion, rawCookie: string, signal?: AbortSignal): ConsoleChannel {
  const cookie = normalizeCookie(rawCookie);
  if (!cookie) throw new QwenUsageError("NO_CREDENTIALS", "控制台 Cookie 为空");
  const profile = REGION_PROFILES[region];
  const csrf = cookieValue(cookie, "login_aliyunid_csrf") ?? cookieValue(cookie, "csrf");
  const anonymousId = cookieValue(cookie, "cna");
  let secTokenPromise: Promise<string | undefined> | null = null;

  const post = async (api: string, data: JsonObject, secToken: string | undefined): Promise<unknown> => {
    const cornerstoneParam: JsonObject = { ...profile.cookieCornerstone };
    if (region === "cn") cornerstoneParam.feTraceId = randomUUID();
    if (anonymousId) cornerstoneParam["X-Anonymous-Id"] = anonymousId;
    const form = new URLSearchParams({
      product: GATEWAY_PRODUCT,
      action: profile.gatewayAction,
      region: profile.consoleRegion,
      language: profile.language,
      params: JSON.stringify({ Api: api, V: "1.0", Data: { ...data, cornerstoneParam } }),
    });
    if (secToken) form.set("sec_token", secToken);
    const query = new URLSearchParams({ action: profile.gatewayAction, product: GATEWAY_PRODUCT, api });
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Origin: profile.origin,
      Referer: profile.dashboardUrl,
      "User-Agent": BROWSER_USER_AGENT,
      "X-Requested-With": "XMLHttpRequest",
    };
    if (csrf) {
      headers["x-xsrf-token"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    const response = await doFetch(
      fetchImpl,
      `https://${profile.cookieGatewayHost}/data/api.json?${query.toString()}`,
      { method: "POST", headers, body: form.toString(), redirect: "manual" },
      signal,
    );
    return readGatewayResponse(response);
  };

  return {
    source: "cookie",
    async call(api, data = {}) {
      secTokenPromise ??= fetchSecToken(fetchImpl, region, cookie, signal);
      const secToken = await secTokenPromise;
      try {
        return await post(api, data, secToken);
      } catch (error) {
        // 带 SEC_TOKEN 被拒时,旧版「仅 Cookie」请求仍可能有效(国内站实测),再试一次。
        if (secToken && error instanceof QwenUsageError && error.code === "LOGIN_EXPIRED") {
          return post(api, data, undefined);
        }
        throw error;
      }
    },
  };
}

function tokenChannel(fetchImpl: FetchLike, region: QwenRegion, getToken: (force: boolean) => Promise<string>,
  source: QwenSource, signal?: AbortSignal): ConsoleChannel {
  const profile = REGION_PROFILES[region];
  const post = async (api: string, data: JsonObject, token: string): Promise<unknown> => {
    const form = new URLSearchParams({
      params: JSON.stringify({
        Api: api,
        V: "1.0",
        Data: {
          ...data,
          cornerstoneParam: {
            protocol: "V2",
            console: "ONE_CONSOLE",
            productCode: "p_efm",
            switchUserType: 3,
            consoleSite: "BAILIAN_ALIYUN",
          },
        },
      }),
      region: profile.consoleRegion,
    });
    const url = `https://${profile.cliGatewayHost}/cli/api.json?action=${profile.gatewayAction}`
      + `&product=${GATEWAY_PRODUCT}&api=${encodeURIComponent(api)}`;
    const response = await doFetch(fetchImpl, url, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: form.toString(),
    }, signal);
    return readGatewayResponse(response);
  };
  return {
    source,
    async call(api, data = {}) {
      try {
        return await post(api, data, await getToken(false));
      } catch (error) {
        // token 过期:只有 AK/SK 通道能重新换取,刷新一次后重试。
        if (source === "aksk" && error instanceof QwenUsageError && error.code === "LOGIN_EXPIRED") {
          return post(api, data, await getToken(true));
        }
        throw error;
      }
    },
  };
}

/** 用 AK/SK 调 GenerateCLIAccessToken 换控制台 token。 */
export async function generateConsoleToken(
  fetchImpl: FetchLike,
  region: QwenRegion,
  credentials: Required<Pick<QwenCredentials, "accessKeyId" | "accessKeySecret">> & Pick<QwenCredentials, "securityToken">,
  signal?: AbortSignal,
): Promise<string> {
  const host = REGION_PROFILES[region].modelStudioHost;
  const headers = signAcs3({
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    securityToken: credentials.securityToken,
    action: ACCESS_TOKEN_ACTION,
    version: ACCESS_TOKEN_VERSION,
    host,
    pathname: ACCESS_TOKEN_PATH,
    method: "POST",
    body: "",
  });
  const response = await doFetch(fetchImpl, `https://${host}${ACCESS_TOKEN_PATH}`, { method: "POST", headers }, signal);
  const text = await response.text();
  let json: JsonObject | null = null;
  try {
    json = asObject(JSON.parse(text));
  } catch {
    /* 下面统一报错 */
  }
  const token = toText(json?.cliAccessToken);
  if (response.ok && token) return token;

  const code = toText(json?.Code) || `HTTP_${response.status}`;
  const message = toText(json?.Message);
  const authAction = toText(asObject(json?.AccessDeniedDetail)?.AuthAction);
  if (authAction || code === "NoPermission" || code.startsWith("Forbidden") || code === "AccessDenied") {
    throw new QwenUsageError(
      "NO_PERMISSION",
      `AccessKey 缺少 RAM 权限 ${authAction || "modelstudio:GenerateCLIAccessToken"}(可授予 AliyunTokenPlanReadOnlyAccess 或自定义策略)`,
    );
  }
  if (code.includes("InvalidAccessKeyId") || code.includes("SignatureDoesNotMatch")) {
    throw new QwenUsageError("NO_CREDENTIALS", `AccessKey 无效:${code}`);
  }
  const retryable = response.status === 429 || response.status >= 500;
  throw new QwenUsageError("HTTP_ERROR", `GenerateCLIAccessToken 失败:${message || code}`, retryable, response.status);
}

const AKSK_TOKEN_TTL_MS = 30 * 60 * 1000;

/** 依次列出可用通道:Cookie → 控制台 token → AK/SK。 */
function buildChannels(opts: FetchOptions, fetchImpl: FetchLike): ConsoleChannel[] {
  const { region, credentials, signal } = opts;
  const channels: ConsoleChannel[] = [];
  if (credentials.cookie?.trim()) channels.push(cookieChannel(fetchImpl, region, credentials.cookie, signal));
  if (credentials.consoleToken?.trim()) {
    const token = credentials.consoleToken.trim();
    channels.push(tokenChannel(fetchImpl, region, async () => token, "console-token", signal));
  }
  if (credentials.accessKeyId?.trim() && credentials.accessKeySecret?.trim()) {
    const cache = opts.tokenCache ?? new Map<string, { token: string; expiresAt: number }>();
    const now = opts.now ?? Date.now;
    const accessKeyId = credentials.accessKeyId.trim();
    const cacheKey = `${region}:${accessKeyId}`;
    const getToken = async (force: boolean) => {
      const cached = cache.get(cacheKey);
      if (!force && cached && cached.expiresAt > now()) return cached.token;
      const token = await generateConsoleToken(fetchImpl, region, {
        accessKeyId,
        accessKeySecret: credentials.accessKeySecret!.trim(),
        securityToken: credentials.securityToken?.trim() || undefined,
      }, signal);
      cache.set(cacheKey, { token, expiresAt: now() + AKSK_TOKEN_TTL_MS });
      return token;
    };
    channels.push(tokenChannel(fetchImpl, region, getToken, "aksk", signal));
  }
  return channels;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithChannel(channel: ConsoleChannel, opts: FetchOptions): Promise<QwenUsageData> {
  const { region } = opts;
  const profile = REGION_PROFILES[region];
  const optional = (promise: Promise<unknown>) => promise.then((value) => value, () => undefined);

  // usage 是必需项;官方网关偶尔返回不含窗口字段的空成功体,重试两次。
  let windows: QwenWindow[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(opts.retryDelayMs ?? 600);
    windows = parseUsageWindows(await channel.call(USAGE_API));
    if (windows.length > 0) break;
  }

  const [subscriptionRaw, quotaRaw, addonRaw] = await Promise.all([
    optional(channel.call(SUBSCRIPTION_API, {
      commodityCode: profile.commodityCode,
      queryInstanceInfoRequest: { commodityCode: profile.commodityCode },
    })),
    optional(channel.call(QUOTA_CONFIG_API)),
    optional(channel.call(ADDON_API)),
  ]);

  const plan = parseSubscription(subscriptionRaw);
  if (windows.length === 0) {
    throw new QwenUsageError(
      "NO_USAGE_DATA",
      plan
        ? "控制台没有返回用量窗口(可能刚开始新周期或网关暂时异常)"
        : "控制台没有返回个人版用量:该账号可能没有有效的 Token Plan 个人版订阅(团队版暂不支持)",
      Boolean(plan),
    );
  }
  return {
    region,
    source: channel.source,
    plan,
    windows: applyQuotaLimits(windows, plan, quotaRaw, region),
    addon: parseAddon(addonRaw),
    fetchedAtMs: (opts.now ?? Date.now)(),
    stale: false,
  };
}

/**
 * 拉取个人版 Token Plan 用量。按 Cookie → 控制台 token → AK/SK 顺序尝试,
 * 前一个通道因登录态/权限失败时自动换下一个;全部失败时抛出最先遇到的有意义错误。
 */
export async function fetchQwenUsage(opts: FetchOptions): Promise<QwenUsageData> {
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const channels = buildChannels(opts, fetchImpl);
  if (channels.length === 0) {
    throw new QwenUsageError("NO_CREDENTIALS", "未配置控制台凭据(Cookie 或 AccessKey)");
  }
  const errors: QwenUsageError[] = [];
  for (const channel of channels) {
    try {
      return await fetchWithChannel(channel, opts);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (!(error instanceof QwenUsageError)) throw error;
      errors.push(error);
      const fallThrough = ["LOGIN_EXPIRED", "NO_PERMISSION", "NO_CREDENTIALS", "WORKSPACE_NOT_AUTHORISED"];
      if (!fallThrough.includes(error.code)) break;
    }
  }
  if (errors.length === 1) throw errors[0];
  const first = errors[0];
  const detail = errors.map((e, i) => `${channels[i]?.source ?? "?"}: ${e.message}`).join(";");
  throw new QwenUsageError(first.code, detail, first.retryable, first.status);
}

// ─── 显示工具 ──────────────────────────────────────────────────────

export function formatCredits(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1)}M`;
}

export function formatCreditsExact(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatPercent(value: number): string {
  if (value >= 10 || Number.isInteger(value)) return value.toFixed(0);
  return value.toFixed(1);
}

export function humanDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** 根据模型 baseUrl / provider id 判断国内站还是国际站。 */
export function detectRegion(provider: string | undefined, baseUrl: string | undefined): QwenRegion | null {
  const host = (() => {
    try {
      return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : "";
    } catch {
      return "";
    }
  })();
  if (/^token-plan\.cn-[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(host)) return "cn";
  if (/^token-plan\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(host)) return "intl";
  const id = (provider ?? "").toLowerCase();
  if (!id.includes("token-plan") && !id.includes("tokenplan")) return null;
  if (!(id.includes("qwen") || id.includes("alibaba") || id.includes("bailian") || id.includes("aliyun"))) return null;
  return /(^|-)cn($|-)/.test(id) ? "cn" : "intl";
}
