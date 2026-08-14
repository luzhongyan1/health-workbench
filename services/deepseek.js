// =============================================================
// DeepSeek 深度思考模型调用服务
// =============================================================
// 环境变量：
//   DEEPSEEK_API_KEY  - 必填，DeepSeek API Key
//   DEEPSEEK_BASE_URL - 可选，默认 https://api.deepseek.com
//   DEEPSEEK_MODEL    - 可选，默认 deepseek-reasoner（深度思考）

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-reasoner';

function getConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

function isConfigured() {
  return Boolean(getConfig().apiKey);
}

async function chatCompletions(messages, options = {}) {
  const { apiKey, baseUrl, model } = getConfig();
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY，请在 .env 文件中添加 DeepSeek API Key');
  }

  const timeoutMs = options.timeoutMs || 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.1,
        max_tokens: options.maxTokens || 8192,
        response_format: { type: 'json_object' }
      })
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DeepSeek API 错误 [${res.status}]: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek 返回内容为空');
    }
    return content;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('DeepSeek 请求超时，请稍后重试');
    }
    throw err;
  }
}

module.exports = {
  isConfigured,
  getConfig,
  chatCompletions
};
