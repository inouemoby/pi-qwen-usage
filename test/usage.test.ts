import assert from "node:assert/strict";
import test from "node:test";
import { buildCookieHeader } from "../login.ts";
import {
  detectRegion, fetchQwenUsage, normalizeCookie, parseUsageWindows, signAcs3, summarizeCredits,
  toUsedPercent, unwrapPayload, USAGE_API, SUBSCRIPTION_API, QUOTA_CONFIG_API, ADDON_API, QwenUsageError,
} from "../usage.ts";

const envelope = (inner: unknown) => ({ code: "200", data: { success: true, DataV2: { data: { code: "200", data: inner } } } });

test("unwrap DataV2 envelope and parse windows", () => {
  const payload = unwrapPayload(envelope({ per1MonthPercentage: 0.2750906925, per1MonthResetTime: 1795000000000 }));
  const windows = parseUsageWindows(payload);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].label, "mo");
  assert.ok(Math.abs(windows[0].usedPercent - 27.50906925) < 1e-6);
  assert.equal(windows[0].resetMs, 1795000000000);
});

test("ratio vs percent normalisation", () => {
  assert.equal(toUsedPercent(0.5), 50);
  assert.equal(toUsedPercent(42), 42);
  assert.equal(toUsedPercent("1"), 100);
  assert.equal(toUsedPercent(-1), null);
});

test("windows sorted short to long, seconds reset converted", () => {
  const w = parseUsageWindows({ per1WeekPercentage: 0.1, per5HourPercentage: 0.2, per5HourResetTime: 1795000000 });
  assert.deepEqual(w.map((x) => x.label), ["5h", "wk"]);
  assert.equal(w[0].resetMs, 1795000000000);
});

test("credit summary includes add-on packs and bottleneck", () => {
  const s = summarizeCredits({
    windows: [
      { key: "per5Hour", label: "5h", durationMs: 1, usedPercent: 90, resetMs: 0, limitCredits: 3000 },
      { key: "per1Month", label: "mo", durationMs: 2, usedPercent: 25, resetMs: 0, limitCredits: 80000 },
    ],
    addon: { remainingCredits: 5000, totalCredits: 20000, activeCount: 1 },
  });
  assert.equal(s.planRemaining, 60000);
  assert.equal(s.remaining, 65000);
  assert.equal(s.total, 100000);
  assert.equal(s.bottleneck?.label, "5h");
});

test("cookie normalisation", () => {
  assert.equal(normalizeCookie("abc$def"), "login_aliyunid_ticket=abc$def");
  assert.equal(normalizeCookie("Cookie: a=b; c=d"), "a=b; c=d");
  assert.equal(normalizeCookie('"x"'), "login_aliyunid_ticket=x");
});

test("cookie header from CDP cookies requires ticket", () => {
  const cookies = [
    { name: "cna", value: "1", domain: ".aliyun.com" },
    { name: "other", value: "2", domain: ".example.com" },
  ];
  assert.equal(buildCookieHeader(cookies, "cn"), null);
  cookies.push({ name: "login_aliyunid_ticket", value: "T", domain: ".aliyun.com" });
  assert.equal(buildCookieHeader(cookies, "cn"), "cna=1; login_aliyunid_ticket=T");
});

test("region detection", () => {
  assert.equal(detectRegion("qwen-token-plan-individual-cn", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"), "cn");
  assert.equal(detectRegion("qwen-token-plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/v1"), "intl");
  assert.equal(detectRegion("qwen-token-plan-cn", undefined), "cn");
  assert.equal(detectRegion("anthropic", "https://api.anthropic.com"), null);
});

test("ACS3 signature is deterministic", () => {
  const opts = { accessKeyId: "id", accessKeySecret: "secret", action: "A", version: "V", host: "h", pathname: "/p",
    date: "2026-01-01T00:00:00Z", nonce: "n" };
  const a = signAcs3(opts);
  assert.equal(a.authorization, signAcs3(opts).authorization);
  assert.match(a.authorization, /^ACS3-HMAC-SHA256 Credential=id,SignedHeaders=content-type;host;x-acs-action;/);
});

function fakeFetch(handler: (api: string, url: string) => unknown) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    if (url.includes("tab=plan")) return new Response('<script>SEC_TOKEN: "s1"</script>', { status: 200 });
    const api = new URL(url).searchParams.get("api") ?? "";
    return new Response(JSON.stringify(handler(api, url)), { status: 200 });
  };
  return { impl, calls };
}

test("end-to-end cookie fetch computes remaining credits", async () => {
  const { impl } = fakeFetch((api) => {
    if (api === USAGE_API) return envelope({ per1MonthPercentage: 0.1 });
    if (api === SUBSCRIPTION_API) return envelope({ specCode: "standard", status: "VALID", remainingDays: 20 });
    if (api === QUOTA_CONFIG_API) return envelope({});
    if (api === ADDON_API) return envelope({ remainingCredits: 0, totalCredits: 0, activeCount: 0 });
    return {};
  });
  const data = await fetchQwenUsage({ region: "cn", credentials: { cookie: "T" }, fetch: impl, retryDelayMs: 0 });
  assert.equal(data.plan?.displayName, "Standard");
  assert.equal(data.windows[0].limitCredits, 80000); // 国内兜底表
  assert.equal(summarizeCredits(data).remaining, 72000);
});

test("NotLogined maps to LOGIN_EXPIRED", async () => {
  const { impl } = fakeFetch(() => ({ code: "200", data: { success: false, errorCode: "BailianGateway.Login.NotLogined" } }));
  await assert.rejects(
    fetchQwenUsage({ region: "cn", credentials: { cookie: "T" }, fetch: impl, retryDelayMs: 0 }),
    (e: unknown) => e instanceof QwenUsageError && e.code === "LOGIN_EXPIRED",
  );
});

test("no credentials", async () => {
  await assert.rejects(fetchQwenUsage({ region: "cn", credentials: {} }), (e: unknown) => e instanceof QwenUsageError && e.code === "NO_CREDENTIALS");
});
