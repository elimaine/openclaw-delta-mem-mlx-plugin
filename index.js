import os from "node:os";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const DEFAULT_MODEL_ID = "delta-mem-qwen3-4b-mlx";
const DEFAULT_SESSION_KEY = "agent:<agent-id>:<session-id>";
const DEFAULT_ATTENTION_ADAPTER = "qmd";
const DEFAULT_ATTENTION_MODE = "vsearch";
const DEFAULT_ATTENTION_QUERY_SOURCE = "outgoing-message";
const DEFAULT_ATTENTION_LIMIT = 6;

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function providerConfig({
  baseUrl,
  modelId,
  sessionKeyTemplate,
  attentionStateEnabled,
  attentionAdapter,
  attentionMode,
  attentionQuerySource,
  attentionLimit
}) {
  const cleanBaseUrl = normalizeBaseUrl(baseUrl);
  const model = modelId || DEFAULT_MODEL_ID;
  const sessionKey = sessionKeyTemplate || DEFAULT_SESSION_KEY;
  const contextInjection = {
    sessionContext: {
      enabled: false,
      source: "openclaw-session-context"
    },
    attentionState: {
      enabled: attentionStateEnabled !== false,
      adapter: attentionAdapter || DEFAULT_ATTENTION_ADAPTER,
      mode: attentionMode || DEFAULT_ATTENTION_MODE,
      querySource: attentionQuerySource || DEFAULT_ATTENTION_QUERY_SOURCE,
      fallbackMode: "none",
      limit: attentionLimit ?? DEFAULT_ATTENTION_LIMIT
    }
  };
  const providerParams = {
    transportProtocol: "openai-chat-completions",
    endpoint: "/v1/chat/completions",
    contextInjection
  };
  return {
    models: {
      providers: {
        "delta-mem-mlx": {
          baseUrl: `${cleanBaseUrl}/v1`,
          apiKey: "local",
          auth: "api-key",
          api: "openai-completions",
          request: {
            allowPrivateNetwork: true
          },
          headers: {
            "X-OpenClaw-Session-Key": sessionKey
          },
          params: providerParams,
          models: [
            {
              id: model,
              name: "Delta-Mem MLX sidecar model",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 4096,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0
              },
              params: {
                experimental: true,
                requiredSessionHeader: "X-OpenClaw-Session-Key",
                ...providerParams
              },
              headers: {
                "X-OpenClaw-Session-Key": sessionKey
              }
            }
          ]
        }
      },
      aliases: {
        [`delta-mem-mlx/${model}`]: {
          alias: "delta-mem-mlx"
        }
      }
    }
  };
}

async function fetchHealth(baseUrl) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/health`, {
    method: "GET",
    signal: AbortSignal.timeout(2500)
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep non-JSON health responses readable.
  }
  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

export default definePluginEntry({
  id: "delta-mem-mlx",
  name: "Delta-Mem MLX",
  description: "Connects OpenClaw to a local Apple Silicon delta-mem MLX sidecar.",
  register(api) {
    api.registerTool({
      name: "delta_mem_mlx_status",
      description:
        "Check Apple Silicon assumptions and the delta-mem MLX sidecar health endpoint.",
      parameters: Type.Object({
        sidecarBaseUrl: Type.Optional(Type.String({
          default: DEFAULT_BASE_URL,
          description: "Reachable sidecar base URL without /v1."
        }))
      }),
      async execute(_id, params) {
        const baseUrl = normalizeBaseUrl(params?.sidecarBaseUrl);
        const platform = os.platform();
        const arch = os.arch();
        const assumptions = {
          appleSilicon: platform === "darwin" && arch === "arm64",
          platform,
          arch,
          expectedRuntime: "macOS on Apple Silicon with Python 3.11+ and mlx-lm"
        };

        let health;
        try {
          health = await fetchHealth(baseUrl);
        } catch (error) {
          health = {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ assumptions, sidecarBaseUrl: baseUrl, health }, null, 2)
            }
          ]
        };
      }
    });

    api.registerTool({
      name: "delta_mem_mlx_provider_config",
      description:
        "Generate the OpenClaw model-provider config block for the delta-mem MLX sidecar.",
      parameters: Type.Object({
        sidecarBaseUrl: Type.Optional(Type.String({
          default: DEFAULT_BASE_URL,
          description: "Reachable sidecar base URL without /v1."
        })),
        modelId: Type.Optional(Type.String({
          default: DEFAULT_MODEL_ID,
          description: "Model id exposed by the sidecar."
        })),
        sessionKeyTemplate: Type.Optional(Type.String({
          default: DEFAULT_SESSION_KEY,
          description: "Stable X-OpenClaw-Session-Key template."
        })),
        attentionStateEnabled: Type.Optional(Type.Boolean({
          default: true,
          description: "Request QMD attention-state lookup before each outgoing message."
        })),
        attentionAdapter: Type.Optional(Type.String({
          default: DEFAULT_ATTENTION_ADAPTER,
          description: "Attention lookup adapter name."
        })),
        attentionMode: Type.Optional(Type.String({
          default: DEFAULT_ATTENTION_MODE,
          description: "Attention lookup mode. Default is QMD vector search."
        })),
        attentionQuerySource: Type.Optional(Type.String({
          default: DEFAULT_ATTENTION_QUERY_SOURCE,
          description: "Message text OpenClaw should use as the QMD lookup query."
        })),
        attentionLimit: Type.Optional(Type.Number({
          default: DEFAULT_ATTENTION_LIMIT,
          minimum: 1,
          description: "Maximum retrieved attention snippets to pass to the sidecar."
        }))
      }),
      async execute(_id, params) {
        const config = providerConfig({
          baseUrl: params?.sidecarBaseUrl,
          modelId: params?.modelId,
          sessionKeyTemplate: params?.sessionKeyTemplate,
          attentionStateEnabled: params?.attentionStateEnabled,
          attentionAdapter: params?.attentionAdapter,
          attentionMode: params?.attentionMode,
          attentionQuerySource: params?.attentionQuerySource,
          attentionLimit: params?.attentionLimit
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(config, null, 2)
            }
          ]
        };
      }
    });
  }
});
