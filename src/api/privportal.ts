/**
 * @deprecated 请使用 `@/sdk/llm-proxy`。本文件保留兼容 re-export。
 */
export {
  LLM_PROXY_BASE,
  LLM_PROXY_PORT,
  LLM_PROXY_V1,
  createLLMClient,
  getLLMClient,
  chatCompletion,
  listModels,
  isPrivPortalHealthy,
  type ChatMessage,
  type ChatOptions,
  type LLMProxyClient,
} from '@/sdk/llm-proxy'
