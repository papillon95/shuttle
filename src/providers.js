// 大模型厂商配置（国内厂商 + OpenRouter）。它们都提供 OpenAI 兼容接口，所以只需换 baseUrl / model。
// 厂商会不断发布新模型；不在列表里的可以在「设置」里添加自定义模型名。
module.exports = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4 Flash（通用，便宜）', labelEn: 'DeepSeek V4 Flash (general, low cost)' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（更强）', labelEn: 'DeepSeek V4 Pro (more capable)' },
    ],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  qwen: {
    name: '通义千问', nameEn: 'Qwen (Alibaba)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus（写代码）', labelEn: 'Qwen3 Coder Plus (coding)' },
      { id: 'qwen-plus', label: 'Qwen Plus（通用）', labelEn: 'Qwen Plus (general)' },
      { id: 'qwen-max', label: 'Qwen Max（最强）', labelEn: 'Qwen Max (most capable)' },
    ],
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  kimi: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k2-0905-preview', label: 'Kimi K2' }],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  glm: {
    name: '智谱 GLM', nameEn: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4-plus', label: 'GLM-4 Plus' },
    ],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  doubao: {
    name: '豆包', nameEn: 'Doubao (ByteDance)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [{ id: 'doubao-seed-1-6-250615', label: '豆包 Seed 1.6', labelEn: 'Doubao Seed 1.6' }],
    keyUrl: 'https://console.volcengine.com/ark',
  },
  // 海外模型聚合平台：一个 Key 调 Gemini / Claude / GPT，由它在海外转发，国内能直连（不认地区限制）
  openrouter: {
    name: 'OpenRouter（海外模型）', nameEn: 'OpenRouter (Gemini, Claude, GPT)',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'openrouter/free', label: '免费模型（自动挑空闲的，限次数）', labelEn: 'Free models (auto-picks an available one, rate-limited)' },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B（免费，限次数）', labelEn: 'Gemma 4 31B (free, rate-limited)' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra（免费，较强）', labelEn: 'Nemotron 3 Ultra (free, capable)' },
      { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'Nemotron 3.5 Super VL（免费，能看图）', labelEn: 'Nemotron 3.5 Super VL (free, vision)' },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning（免费，快）', labelEn: 'Nemotron 3.5 Lightning (free, fast)' },
      { id: 'baidu/ernie-5.5-flash-preview:free', label: '文心 ERNIE 5.5 Flash（免费，中文好）', labelEn: 'ERNIE 5.5 Flash (free, strong Chinese)' },
      { id: 'inclusionai/ling-3.2-flash:free', label: '百灵 Ling 3.2 Flash（免费，能看图）', labelEn: 'Ling 3.2 Flash (free, vision)' },
      { id: 'dots-studio/dots-3-note-preview:free', label: 'dots 3 Note（免费，能看图）', labelEn: 'dots 3 Note (free, vision)' },
      { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite（便宜）', labelEn: 'Gemini 3.1 Flash Lite (low cost)' },
      { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5（便宜）', labelEn: 'Claude Haiku 5.5 (low cost)' },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5（更强）', labelEn: 'Claude Sonnet 5.5 (more capable)' },
      { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna（便宜）', labelEn: 'GPT-6 Luna (low cost)' },
      { id: 'openai/gpt-6.2-sol', label: 'GPT-6.2 Sol（更强）', labelEn: 'GPT-6.2 Sol (more capable)' },
    ],
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  custom: {
    name: '自定义接口', nameEn: 'Custom endpoint',
    baseUrl: '',
    models: [],
    keyUrl: '',
  },
};
