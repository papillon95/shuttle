// 国内大模型厂商配置。它们都提供 OpenAI 兼容接口，所以只需换 baseUrl / model。
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
  custom: {
    name: '自定义接口', nameEn: 'Custom endpoint',
    baseUrl: '',
    models: [],
    keyUrl: '',
  },
};
