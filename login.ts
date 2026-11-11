/**
 * 通过本机 Edge / Chrome 的 DevTools 协议(CDP)读取控制台登录态。
 *
 * 使用插件专属的浏览器配置目录(不碰用户日常浏览器的配置),因此:
 * - 首次 `/qwen-login` 弹出窗口,用户登录一次;
 * - 之后 ticket 过期时可用同一目录无头启动,依靠阿里云的长期会话静默拿到新 ticket。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { consoleUrl, type QwenRegion } from "./usage.ts";

const INTERACTIVE_TIMEOUT_MS = 5 * 60 * 1000;
const SILENT_TIMEOUT_MS = 30 * 1000;

const COOKIE_DOMAINS: Record<QwenRegion, RegExp> = {
  cn: /(^|\.)aliyun\.com$/i,
  intl: /(^|\.)(qwencloud\.com|alibabacloud\.com)$/i,
};

function browserCandidates(): string[] {
  const env = process.env;
  if (process.platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((root) => [
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

export function findBrowser(): string | null {
  const override = process.env.QWEN_USAGE_BROWSER;
  if (override && existsSync(override)) return override;
  return browserCandidates().find((path) => existsSync(path)) ?? null;
}

/** 浏览器配置目录里是否已有过登录(用于判断能否静默续期)。 */
export function hasBrowserProfile(profileDir: string): boolean {
  return existsSync(join(profileDir, "Default"));
}

export function removeBrowserProfile(profileDir: string): void {
  rmSync(profileDir, { recursive: true, force: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待浏览器写出 DevToolsActivePort,得到 browser 级 WebSocket 地址。 */
async function waitForDevTools(profileDir: string, child: ChildProcess, deadline: number): Promise<string> {
  const file = join(profileDir, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("浏览器启动后立即退出(该配置目录可能正被另一个窗口占用)");
    try {
      const [port, path] = readFileSync(file, "utf8").trim().split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      /* 尚未写出 */
    }
    await sleep(200);
  }
  throw new Error("等待浏览器调试端口超时");
}

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const waiter = msg.id ? this.pending.get(msg.id) : undefined;
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
      else waiter.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("浏览器已关闭"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("无法连接浏览器调试端口")), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 从 CDP cookie 列表里拼出控制台域名的 Cookie 头;没有登录 ticket 时返回 null。 */
export function buildCookieHeader(cookies: Array<{ name: string; value: string; domain: string; expires?: number }>,
  region: QwenRegion, nowSec = Date.now() / 1000): string | null {
  const relevant = cookies.filter((c) => COOKIE_DOMAINS[region].test(c.domain.replace(/^\./, ""))
    && (!c.expires || c.expires <= 0 || c.expires > nowSec));
  const hasTicket = relevant.some((c) => /^login_.*ticket$/i.test(c.name) && c.value);
  if (!hasTicket) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const cookie of relevant) {
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join("; ");
}

/**
 * 打开控制台并等待登录 ticket 出现。
 * silent=true:无头启动,只依靠已有的长期会话;拿不到时返回 null,不打扰用户。
 */
export async function captureConsoleCookie(region: QwenRegion, profileDir: string,
  options: { silent?: boolean } = {}): Promise<string | null> {
  const browser = findBrowser();
  if (!browser) throw new Error("未找到 Edge / Chrome,可设置环境变量 QWEN_USAGE_BROWSER 指定浏览器路径");
  mkdirSync(profileDir, { recursive: true });
  try {
    unlinkSync(join(profileDir, "DevToolsActivePort"));
  } catch {
    /* 不存在 */
  }

  const silent = options.silent === true;
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...(silent ? ["--headless=new", "--disable-gpu"] : ["--new-window"]),
    consoleUrl(region),
  ];
  const child = spawn(browser, args, { stdio: "ignore", detached: false, windowsHide: silent });
  child.on("error", () => { /* 由下面的等待逻辑报错 */ });

  const deadline = Date.now() + (silent ? SILENT_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS);
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(await waitForDevTools(profileDir, child, deadline));
    // 静默模式下至少等页面跑完一次跳转,让服务端有机会续发 ticket。
    if (silent) await sleep(4000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        if (silent) return null;
        throw new Error("浏览器窗口已关闭,登录未完成");
      }
      const result = await cdp.send("Storage.getCookies").catch(() => null);
      const header = result?.cookies ? buildCookieHeader(result.cookies, region) : null;
      if (header) return header;
      await sleep(1500);
    }
    if (silent) return null;
    throw new Error("等待登录超时(5 分钟)");
  } finally {
    try {
      await cdp?.send("Browser.close");
    } catch {
      /* 已关闭 */
    }
    cdp?.close();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 3000).unref?.();
  }
}
