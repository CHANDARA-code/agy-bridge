const THIRD_PARTY_CLAUDE_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1'
};

const SERVICES = [
  {
    id: 'anthropic',
    name: 'Anthropic API',
    engine: 'claude',
    region: 'Global',
    baseUrl: null,
    keyVar: 'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-…',
    keyPage: 'https://console.anthropic.com/settings/keys',
    docs: 'https://code.claude.com/docs/en/authentication',
    models: { main: '', fast: '' },
    check: { url: 'https://api.anthropic.com/v1/models', header: 'x-api-key', listsModels: true }
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    engine: 'claude',
    region: 'Global',
    baseUrl: 'https://api.deepseek.com/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'sk-…',
    keyPage: 'https://platform.deepseek.com/api_keys',
    docs: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code',
    models: { main: 'deepseek-flash[1m]', fast: 'deepseek-flash' },
    check: { url: 'https://api.deepseek.com/models', listsModels: true }
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot AI)',
    engine: 'claude',
    region: 'International',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'sk-…',
    keyPage: 'https://platform.kimi.ai/console/api-keys',
    docs: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    models: { main: 'kimi-k3[1m]', fast: 'kimi-k2.7-code' },
    check: { url: 'https://api.moonshot.ai/v1/models', listsModels: true }
  },
  {
    id: 'kimi-cn',
    name: 'Kimi (Moonshot AI, China)',
    engine: 'claude',
    region: 'China',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'sk-…',
    keyPage: 'https://platform.kimi.com',
    docs: 'https://platform.kimi.com/docs/guide/claude-code-kimi.md',
    models: { main: '', fast: '' },
    check: null
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    engine: 'claude',
    region: 'International',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: '',
    keyPage: 'https://z.ai/manage-apikey/apikey-list',
    docs: 'https://docs.z.ai/devpack/tool/claude',
    models: { main: 'glm-5.3[1m]', fast: 'glm-5.3-flash[1m]' },
    env: { API_TIMEOUT_MS: '3000000' },
    check: null
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM (China)',
    engine: 'claude',
    region: 'China',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: '',
    keyPage: 'https://open.bigmodel.cn/usercenter/apikeys',
    docs: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude',
    models: { main: 'glm-5.3[1m]', fast: 'glm-5.3-flash[1m]' },
    env: { API_TIMEOUT_MS: '3000000' },
    check: null
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    engine: 'claude',
    region: 'International',
    baseUrl: 'https://api.minimax.io/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: '',
    keyPage: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docs: 'https://platform.minimax.io/docs/m-plan/claude-code.md',
    models: { main: 'MiniMax-M3.1-Flash[1m]', fast: 'MiniMax-M3.1-Flash[1m]' },
    check: { url: 'https://api.minimax.io/v1/models', listsModels: true }
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax (China)',
    engine: 'claude',
    region: 'China',
    baseUrl: 'https://api.minimax.cn/anthropic',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: '',
    keyPage: 'https://platform.minimaxi.com',
    docs: 'https://platform.minimaxi.com/docs/m-plan/claude-code.md',
    models: { main: 'MiniMax-M3.1-Flash[1m]', fast: 'MiniMax-M3.1-Flash[1m]' },
    check: null
  },
  {
    id: 'alibaba',
    name: 'Alibaba Cloud Model Studio (Qwen)',
    engine: 'claude',
    region: 'Global',
    baseUrl: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    baseUrlHelp: 'Replace {WorkspaceId} and the region (ap-southeast-1, cn-beijing or us-east-1) with yours. A Coding Plan key uses https://coding-intl.dashscope.aliyuncs.com/apps/anthropic.',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'sk-…',
    keyPage: 'https://modelstudio.console.alibabacloud.com',
    docs: 'https://www.alibabacloud.com/help/en/model-studio/claude-code',
    models: { main: 'qwen3.7-max', fast: 'qwen3.6-flash' },
    check: null
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    engine: 'claude',
    region: 'Global',
    baseUrl: 'https://openrouter.ai/api',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'sk-or-…',
    keyPage: 'https://openrouter.ai/settings/keys',
    docs: 'https://openrouter.ai/docs/guides/guides/claude-code-integration',
    models: { main: '~anthropic/claude-sonnet-latest[1m]', fast: '~anthropic/claude-haiku-latest' },
    env: { ANTHROPIC_API_KEY: '' },
    check: { url: 'https://openrouter.ai/api/v1/key', listsModels: false }
  },
  {
    id: 'volcengine',
    name: 'Volcengine Ark (Agent Plan)',
    engine: 'claude',
    region: 'China',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: '',
    keyPage: 'https://console.volcengine.com/ark',
    docs: 'https://docs.volcengine.com/docs/82379/2373740',
    models: { main: 'ark-code-latest', fast: '' },
    check: null
  },
  {
    id: 'custom-anthropic',
    name: 'Other Anthropic-compatible API',
    engine: 'claude',
    region: 'Any',
    baseUrl: '',
    baseUrlHelp: 'The endpoint your provider gives for Claude Code (ANTHROPIC_BASE_URL), for example a LiteLLM gateway.',
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: '',
    keyPage: null,
    docs: 'https://code.claude.com/docs/en/llm-gateway',
    models: { main: '', fast: '' },
    check: null
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    engine: 'codex',
    region: 'Global',
    baseUrl: null,
    keyVar: 'CODEX_API_KEY',
    keyHint: 'sk-…',
    keyPage: 'https://platform.openai.com/api-keys',
    docs: 'https://learn.chatgpt.com/docs/non-interactive-mode',
    models: { main: '', fast: '' },
    check: { url: 'https://api.openai.com/v1/models', listsModels: true }
  },
  {
    id: 'kimi-codex',
    name: 'Kimi (Moonshot AI)',
    engine: 'codex',
    region: 'International',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyVar: 'A2A_PROVIDER_API_KEY',
    keyHint: 'sk-…',
    keyPage: 'https://platform.kimi.ai/console/api-keys',
    docs: 'https://platform.kimi.ai/docs/guide/codex-kimi',
    models: { main: 'kimi-k3.1-pro', fast: '' },
    check: { url: 'https://api.moonshot.ai/v1/models', listsModels: true }
  },
  {
    id: 'minimax-codex',
    name: 'MiniMax',
    engine: 'codex',
    region: 'International',
    baseUrl: 'https://api.minimax.io/v1',
    keyVar: 'A2A_PROVIDER_API_KEY',
    keyHint: '',
    keyPage: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docs: 'https://platform.minimax.io/docs/m-plan/codex.md',
    models: { main: '', fast: '' },
    check: { url: 'https://api.minimax.io/v1/models', listsModels: true }
  },
  {
    id: 'openrouter-codex',
    name: 'OpenRouter',
    engine: 'codex',
    region: 'Global',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyVar: 'A2A_PROVIDER_API_KEY',
    keyHint: 'sk-or-…',
    keyPage: 'https://openrouter.ai/settings/keys',
    docs: 'https://openrouter.ai/docs/api/reference/responses/overview',
    models: { main: '', fast: '' },
    check: { url: 'https://openrouter.ai/api/v1/key', listsModels: false }
  },
  {
    id: 'groq',
    name: 'Groq',
    engine: 'codex',
    region: 'Global',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyVar: 'A2A_PROVIDER_API_KEY',
    keyHint: 'gsk_…',
    keyPage: 'https://console.groq.com/keys',
    docs: 'https://console.groq.com/docs/responses-api',
    models: { main: '', fast: '' },
    check: null
  },
  {
    id: 'custom-openai',
    name: 'Other OpenAI Responses-compatible API',
    engine: 'codex',
    region: 'Any',
    baseUrl: '',
    baseUrlHelp: 'The base URL that ends before /responses, for example https://api.example.com/v1. Codex only speaks the Responses API.',
    keyVar: 'A2A_PROVIDER_API_KEY',
    keyHint: '',
    keyPage: null,
    docs: 'https://learn.chatgpt.com/docs/config-file/config-reference',
    models: { main: '', fast: '' },
    check: null
  }
];

const BY_ID = new Map(SERVICES.map((service) => [service.id, service]));

const getService = (id) => BY_ID.get(id) || null;

function publicService(service) {
  return {
    id: service.id,
    name: service.name,
    engine: service.engine,
    region: service.region,
    baseUrl: service.baseUrl,
    baseUrlHelp: service.baseUrlHelp || null,
    baseUrlRequired: service.baseUrl === '' || /\{/.test(service.baseUrl || ''),
    keyHint: service.keyHint || '',
    keyPage: service.keyPage,
    docs: service.docs,
    models: service.models,
    needsModel: service.engine === 'codex' ? service.id !== 'openai' : service.id !== 'anthropic',
    checksKey: Boolean(service.check)
  };
}

const listServices = () => SERVICES.map(publicService);

const MANAGED_CLAUDE_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BETAS'
];
const MANAGED_CODEX_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'A2A_PROVIDER_API_KEY'];

function taskEnv(account, key, env) {
  const service = getService(account.apiKey.service);
  if (!service) throw new Error(`Unknown API service "${account.apiKey.service}"`);
  const baseUrl = account.apiKey.baseUrl || service.baseUrl;
  const main = account.model || service.models.main;
  const fast = account.apiKey.fastModel || service.models.fast || main;
  if (service.engine === 'claude') {
    for (const name of MANAGED_CLAUDE_ENV) delete env[name];
    if (baseUrl) {
      env.ANTHROPIC_BASE_URL = baseUrl;
      Object.assign(env, THIRD_PARTY_CLAUDE_ENV);
    }
    if (main) {
      env.ANTHROPIC_MODEL = main;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = main;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = main;
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = main;
      env.CLAUDE_CODE_SUBAGENT_MODEL = main;
    }
    if (fast) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
    Object.assign(env, service.env || {});
    env[service.keyVar] = key;
    return env;
  }
  for (const name of MANAGED_CODEX_ENV) delete env[name];
  env[service.keyVar] = key;
  return env;
}

const tomlString = (value) => JSON.stringify(String(value));

function codexConfig(account) {
  const service = getService(account.apiKey.service);
  if (!service || service.engine !== 'codex' || service.id === 'openai') return null;
  const lines = ['model_provider = "a2a"'];
  const main = account.model || service.models.main;
  if (main) lines.push(`model = ${tomlString(main)}`);
  lines.push(
    '',
    '[model_providers.a2a]',
    `name = ${tomlString(service.name)}`,
    `base_url = ${tomlString(account.apiKey.baseUrl || service.baseUrl)}`,
    `env_key = "${service.keyVar}"`,
    'wire_api = "responses"',
    ''
  );
  return lines.join('\n');
}

const LOCAL_TEST_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\//;

const checkUrl = (service) => (LOCAL_TEST_URL.test(process.env.A2A_API_CHECK_URL || '') ? process.env.A2A_API_CHECK_URL : service.check.url);

async function checkKey(account, key) {
  const service = getService(account.apiKey.service);
  if (!service) return { state: 'error', detail: `Unknown API service "${account.apiKey.service}"` };
  const ending = `ending in ${account.apiKey.last4}`;
  if (!key) return { state: 'signed-out', detail: 'No API key saved. Add one with Change key.' };
  if (account.apiKey.baseUrl) return { state: 'signed-in', detail: `${service.name} key ${ending} is saved for ${account.apiKey.baseUrl}. The first task proves it.` };
  if (!service.check) return { state: 'signed-in', detail: `${service.name} key ${ending} is saved. ${service.name} has no free check, so the first task proves it.` };
  const headers = service.check.header === 'x-api-key'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` };
  let res;
  try {
    res = await fetch(checkUrl(service), { headers, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    return { state: 'error', detail: `Could not reach ${service.name} to check the key.` };
  }
  if (res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch (err) {}
    return { state: 'signed-in', detail: `${service.name} accepted the key ${ending}.`, body };
  }
  if (res.status === 401 || res.status === 403) return { state: 'signed-out', detail: `${service.name} rejected the key ${ending}. Replace it with Change key.` };
  return { state: 'error', detail: `${service.name} answered HTTP ${res.status} while checking the key.` };
}

function modelsFrom(service, body) {
  const suggested = [service.models.main, service.models.fast].filter(Boolean).map((id) => ({ id, name: id, description: `Suggested in the ${service.name} guide` }));
  const listed = service.check && service.check.listsModels && body && Array.isArray(body.data)
    ? body.data.filter((model) => model && typeof model.id === 'string').map((model) => ({ id: model.id, name: model.display_name || model.id }))
    : [];
  const seen = new Set();
  return [...suggested, ...listed].filter((model) => !seen.has(model.id) && seen.add(model.id));
}

module.exports = { SERVICES, getService, listServices, taskEnv, codexConfig, checkKey, modelsFrom };
