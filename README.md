# Delta-Mem MLX for OpenClaw

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-111827)](https://openclaw.ai)
[![Apple Silicon](https://img.shields.io/badge/platform-Apple%20Silicon-0f766e)](#requirements)

Give OpenClaw agents a local Apple Silicon memory sidecar.

This plugin connects OpenClaw to a local delta-mem MLX sidecar: an
OpenAI-compatible chat-completions service that runs MLX models and can preload
retrieved memory into a compact neural state before generation. It is for people
running local agents on macOS who want memory behavior that is more interesting
than simply pasting old context into the prompt.

The provider config intentionally does not emit a session-key header. That route
did not work reliably through Sidecad. For stateful delta-mem research runs, call
the sidecar directly with `X-Delta-Mem-Session-Key`.

## Stack

| Layer | What it uses |
|---|---|
| Agent runtime | OpenClaw model provider config |
| Sidecar API | FastAPI, OpenAI-compatible `/v1/chat/completions` |
| Inference | MLX / mlx-lm on Apple Silicon |
| Default backbone | `mlx-community/Qwen3-4B-Instruct-2507-4bit` |
| Delta-mem adapter | `ofthetrees/delta-mem-qwen3-4b-instruct-mlx-adapter` |
| Optional memory shaping | Explicit `attention_state` snippets |

Sidecar and benchmark repo:

https://github.com/elimaine/delta-mem-mlx

Delta-mem paper:

https://arxiv.org/abs/2605.12357

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| Host | macOS on Apple Silicon | MLX is the intended local runtime |
| Python | 3.11+ | Used by the sidecar |
| Node | Current LTS | Used by plugin helper scripts |
| OpenClaw | `2026.3.24-beta.2` or newer | Required for plugin install/use |
| Storage | Several GB | Model downloads are gated and explicit |
| Hugging Face | Network access | Needed for model/adapter downloads |

The plugin can emit provider config for an already-running sidecar. Managed
install is optional.

## Install

From ClawHub:

```sh
openclaw plugins install clawhub:@elimaine/openclaw-delta-mem-mlx
```

From GitHub:

```sh
git clone https://github.com/elimaine/openclaw-delta-mem-mlx-plugin.git
openclaw plugins install -l ./openclaw-delta-mem-mlx-plugin
```

## Quick Start

Check whether the sidecar route is reachable:

```sh
curl -fsS http://127.0.0.1:8765/health
```

Then use the plugin inside OpenClaw:

- Human path: ask OpenClaw to run `delta_mem_mlx_status`, then
  `delta_mem_mlx_provider_config`.
- Agent path: call `delta_mem_mlx_provider_config` with
  `sidecarBaseUrl: "http://127.0.0.1:8765"` and
  `modelId: "delta-mem-qwen3-4b-mlx"`, then add the returned provider block to
  the model configuration.

## Sidecar Setup

Managed install:

```sh
npm run install-sidecar
```

The installer checks platform assumptions first. It asks before downloading
model artifacts and starts the sidecar only after a completed managed install.

Install without starting:

```sh
npm run install-sidecar-only
```

Non-interactive install:

```sh
npm run install-sidecar -- --mode clone --root ~/.delta-mem/delta-mem-mlx --model-preset qwen3-delta --download-model yes
```

Start an existing sidecar checkout:

```sh
npm run start-sidecar -- --root /path/to/delta-mem-mlx
```

## Model Presets

| Preset | Purpose |
|---|---|
| `qwen3-delta` | Qwen3 4B MLX backbone plus converted delta-mem adapter |
| `smoke` | Small Qwen2.5 MLX model for cheap setup checks |
| `custom` | User-supplied MLX model and optional adapter directory |

The Qwen3 delta preset validates that `delta_mem_config.json` and
`delta_mem_adapter_mlx.npz` exist before startup, so partial adapter downloads
fail early with a clear error.

## How Memory Reaches The Model

OpenClaw calls the sidecar like a normal OpenAI-compatible provider:

- `baseUrl`: sidecar `/v1` root
- `transportProtocol`: `openai-chat-completions`
- `endpoint`: `/v1/chat/completions`

Retrieved memory should not be appended to the visible chat unless the operator
explicitly wants that behavior. The sidecar accepts hidden memory-shaping input
as:

- request body: `attention_state`, `attentionState`, or `delta_attention_state`
- request header: `X-Delta-Attention-State`

The sidecar then preloads those snippets into the per-session delta state before
the real assistant response. This is attention shaping, not guaranteed verbatim
recall.

## Agent Integration Notes

Agents configuring this plugin should preserve these invariants:

- Route to `/v1/chat/completions`, not legacy completions.
- Keep retrieved snippets in `attention_state`; do not copy them into
  user-visible prompt text unless explicitly requested.
- Verify integration with `X-Delta-Attention-State-Count` and
  `X-Delta-Attention-State-Source`.
- Treat install/download actions as operator-approved; do not silently fetch
  model weights.

Minimal provider hook:

```diff
 const body = {
   model,
   messages,
   temperature,
   max_tokens: maxTokens
 };
+body.attention_state = snippets.map((item) => ({
+  text: item.text || item.content || item.snippet,
+  source: item.source,
+  score: item.score
+})).filter((item) => item.text);
```

## Tools

The plugin registers two optional tools:

- `delta_mem_mlx_status`: checks host assumptions and sidecar health.
- `delta_mem_mlx_provider_config`: generates the model-provider config block.

## Benchmarks

The sidecar repo keeps current benchmark notes in:

https://github.com/elimaine/delta-mem-mlx/blob/main/docs/benchmark-findings.md

Retrieved-memory preload tests improved from `0.5625` plain to `0.7292`
delta-mem (`1.30x`) in the strongest local runs. Broader strict transcript
replay showed weaker exact-recall recovery (`+0.0391`) with effectively flat
latency (`1.01x`).

## ClawHub Publish

Dry run first:

```sh
clawhub package publish . --family code-plugin --dry-run
```

Publish:

```sh
clawhub package publish . --family code-plugin
```

## Links

- Plugin repo: https://github.com/elimaine/openclaw-delta-mem-mlx-plugin
- Sidecar repo: https://github.com/elimaine/delta-mem-mlx
- Benchmark findings: https://github.com/elimaine/delta-mem-mlx/blob/main/docs/benchmark-findings.md
- Delta-mem paper: https://arxiv.org/abs/2605.12357
