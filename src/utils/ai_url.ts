// AI（OpenAI 兼容）接口地址规范化。
//
// 背景：用户填写 api_url 的习惯差异很大，可能是
//   https://host                     （裸域名）
//   https://host/v1                  （标准 OpenAI 兼容）
//   https://host/compatible-mode/v1  （阿里云 DashScope）
//   https://host/v1/                 （带尾斜杠）
// 各端点对「api_url 是否已含 /v1」的假设必须一致，否则会拼出重复前缀。
//
// 历史 bug：模型列表端点硬拼 `${api_url}/v1/models`，而对话端点用
// `${api_url}/chat/completions`——两者假设相反。按界面提示填写 `.../v1` 时，
// 模型请求变成 `.../v1/v1/models` → 404，并被笼统提示为「端点不存在」，
// 掩盖真实原因。

/** 归一化为「已包含 /v1 前缀、无尾斜杠」的 base URL。 */
export function normalizeAiBaseUrl(apiUrl: string): string {
  let u = (apiUrl || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  if (/\/v1$/i.test(u)) return u;
  return `${u}/v1`;
}

/** 模型列表端点：GET /v1/models */
export function aiModelsUrl(apiUrl: string): string {
  const base = normalizeAiBaseUrl(apiUrl);
  return base ? `${base}/models` : '';
}

/** 对话补全端点：POST /v1/chat/completions */
export function aiChatCompletionsUrl(apiUrl: string): string {
  const base = normalizeAiBaseUrl(apiUrl);
  return base ? `${base}/chat/completions` : '';
}

/**
 * 脱敏 URL：去掉 query 与 hash，仅保留「协议 + 主机 + 路径」。
 * api_key 走 Authorization 头，不在这类 URL 中，但用户可能把凭据写在 query 上。
 */
export function maskUrl(raw: string): string {
  return String(raw || '').split(/[?#]/)[0];
}
