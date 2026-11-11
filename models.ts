/**
 * 临时补齐 pi 内置模型表里还没有的 Token Plan 新模型(如 qwen4-max-preview)。
 *
 * - 不写 pi 的任何配置文件,只在运行时通过 pi.registerProvider 注入;
 * - 用 provider 已注册的 sk-sp Key 读取服务端 /models,只补服务端确实开放、pi 又不认识的文本模型;
 * - 参数套用同系列最接近的已知模型(qwen4-max-preview → qwen3.8-max);
 * - pi 以后内置了同名模型时自动不再注入。
 *
 * 注意:扩展传入 models 时 pi 会整表替换,所以必须带上该 provider 现有的全部模型。
 */

/** 非文本对话模型(图片/视频/语音等),不注入到聊天模型列表。 */
const NON_CHAT = /(audio|tts|asr|realtime|image|video|wan\d|embedding|rerank)/i;

export function prettifyModelName(id: string): string {
  return id
    .split("-")
    .map((part) => {
      const qwen = /^qwen(\d.*)$/i.exec(part);
      if (qwen) return `Qwen${qwen[1]}`;
      if (/^glm$/i.test(part)) return "GLM";
      if (/^deepseek$/i.test(part)) return "DeepSeek";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/**
 * 为新模型挑一个参数模板:优先同家族且同级别(max/plus/flash/pro)、版本号最高的模型,
 * 找不到同家族模型时返回 undefined。
 */
export function pickTemplate<T extends { id: string }>(id: string, known: T[]): T | undefined {
  if (known.length === 0) return undefined;
  const family = /^[a-z]+/i.exec(id)?.[0]?.toLowerCase() ?? "";
  const tier = /(max|plus|flash|pro|turbo|lite)/i.exec(id)?.[1]?.toLowerCase();
  const version = (value: string) => Number(/(\d+(?:\.\d+)?)/.exec(value)?.[1] ?? 0);
  const sameFamily = known.filter((m) => m.id.toLowerCase().startsWith(family));
  const sameTier = tier ? sameFamily.filter((m) => m.id.toLowerCase().includes(tier)) : [];
  const pool = sameTier.length > 0 ? sameTier : sameFamily;
  // 没有同家族模型(如 auto、decision-model-preview)时参数无从参考,不注入。
  if (pool.length === 0) return undefined;
  // 版本号最高者优先;同版本时取名字最短的正式型号(不带日期/预览后缀)。
  return [...pool].sort((a, b) => version(b.id) - version(a.id) || a.id.length - b.id.length)[0];
}

/**
 * 按官方文档对模板参数的修正(help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
 * 的 reasoning_effort 说明,以及 Token Plan 个人版概述的模型能力表)。
 * qwen4-max-preview 与 qwen3.8-max 规则相同(low / medium / xhigh),无需修正。
 */
const OFFICIAL_OVERRIDES: Record<string, Partial<ModelLike>> = {
  // reasoning_effort:low / high(默认)/ max;概述页标注支持视觉理解。
  "deepseek-v4.1-flash": {
    input: ["text", "image"],
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  },
  // 概述页标注支持视觉理解;思考档位文档未单列,沿用模板(high / max)。
  "deepseek-v4.1-flash-1017": { input: ["text", "image"] },
};

export interface ModelLike {
  id: string;
  name?: string;
  provider: string;
  baseUrl?: string;
  type?: string;
  [key: string]: unknown;
}

/** 计算需要注入的模型(纯函数,便于测试)。 */
export function planInjection(remoteIds: string[], existing: ModelLike[]): ModelLike[] {
  const chatModels = existing.filter((m) => (m.type ?? "chat") === "chat");
  const known = new Set(existing.map((m) => m.id));
  const additions: ModelLike[] = [];
  for (const id of remoteIds) {
    if (known.has(id) || NON_CHAT.test(id)) continue;
    const template = pickTemplate(id, chatModels);
    if (!template) continue;
    additions.push({ ...template, ...OFFICIAL_OVERRIDES[id], id, name: prettifyModelName(id) });
    known.add(id);
  }
  return additions;
}

export async function fetchRemoteModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) return [];
  const json: any = await response.json().catch(() => null);
  return Array.isArray(json?.data)
    ? json.data.map((m: any) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
    : [];
}
