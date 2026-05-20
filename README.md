# Delta-Mem MLX for OpenClaw

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-111827)](https://openclaw.ai)
[![Apple Silicon](https://img.shields.io/badge/platform-Apple%20Silicon-0f766e)](#requirements)

Give OpenClaw agents a local Apple Silicon memory sidecar.

This plugin connects OpenClaw to a local δ-mem MLX sidecar: an OpenAI-compatible
chat-completions service that runs MLX models and can preload retrieved memory
into a compact neural state before generation. It is for people running local
agents on macOS who want memory behavior that is more interesting than simply
pasting old context into the prompt.

δ-mem is exciting because it changes how attention is shaped in a frozen model.
Instead of fine-tuning a new model or appending a long transcript, the sidecar
keeps a small per-session memory state and applies it through the model's
attention path. In local tests, the Qwen3 4B backbone improved consistently when
the δ-mem adapter was attached; OpenClaw-specific memory preload experiments are
still being tuned and benchmarked.

## Stack

| Layer | What it uses |
|---|---|
| Agent runtime | OpenClaw model provider config |
| Sidecar API | FastAPI, OpenAI-compatible `/v1/chat/completions` |
| Inference | MLX / mlx-lm on Apple Silicon |
| Default backbone | `mlx-community/Qwen3-4B-Instruct-2507-4bit` |
| δ-mem adapter | `ofthetrees/delta-mem-qwen3-4b-instruct-mlx-adapter` |
| Optional retrieval | QMD `vsearch` snippets passed as `attention_state` |

Sidecar and benchmark repo:

https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw

δ-mem paper:

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

The plugin can still emit provider config for an already-running sidecar. Managed
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

Start an existing sidecar checkout:

```sh
npm run start-sidecar -- --root /path/to/delta-mem-mlx-sidecar-w-openclaw
```

Use the QMD fallback when OpenClaw is not yet passing `attention_state` itself:

```sh
npm run start-sidecar -- \
  --root /path/to/delta-mem-mlx-sidecar-w-openclaw \
  --attention-state-source qmd \
  --qmd-mode vsearch \
  --qmd-limit 6
```

If QMD is missing, times out, or exits nonzero, the sidecar still answers
normally and reports `X-Delta-Attention-State-Count: 0`.

## Model Presets

| Preset | Purpose |
|---|---|
| `qwen3-delta` | Qwen3 4B MLX backbone plus converted δ-mem adapter |
| `smoke` | Small Qwen2.5 MLX model for cheap setup checks |
| `custom` | User-supplied MLX model and optional adapter directory |

The Qwen3 δ preset validates that `delta_mem_config.json` and
`delta_mem_adapter_mlx.npz` exist before startup, so partial adapter downloads
fail early with a clear error.

## How Memory Reaches The Model

OpenClaw calls the sidecar like a normal OpenAI-compatible provider:

- `baseUrl`: sidecar `/v1` root
- `transportProtocol`: `openai-chat-completions`
- `endpoint`: `/v1/chat/completions`
- stable session header: `X-OpenClaw-Session-Key`

Retrieved memory should not be appended to the visible chat unless the operator
explicitly wants that behavior. The sidecar accepts hidden memory-shaping input
as:

- request body: `attention_state`, `attentionState`, or `delta_attention_state`
- request header: `X-Delta-Attention-State`

The sidecar then preloads those snippets into the per-session δ-state before the
real assistant response. This is attention shaping, not guaranteed verbatim
recall.

## Agent Integration Notes

Agents configuring this plugin should preserve these invariants:

- Use one stable `X-OpenClaw-Session-Key` per logical agent/session.
- Route to `/v1/chat/completions`, not legacy completions.
- Keep QMD snippets in `attention_state`; do not copy them into user-visible
  prompt text unless explicitly requested.
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
+const query = latestUserText(messages);
+const snippets = await qmd.vsearch(query, { limit: 6 });
+body.attention_state = snippets.map((item) => ({
+  text: item.text || item.content || item.snippet,
+  source: item.source || "qmd:vsearch",
+  score: item.score
+})).filter((item) => item.text);
```

## Benchmarks

Current findings live in the sidecar wiki:

https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw/blob/main/wiki/Benchmark-Findings.md

High-level summary:

| Test shape | Result |
|---|---|
| Qwen3 4B + δ-mem adapter | Consistent response-quality lift over the plain backbone |
| Strongest OpenClaw-shaped QMD preload tests | `0.5625` plain to `0.7292` δ-mem, about `1.30x` |
| Stricter OpenClaw-16 replay | Small exact-recall recovery, `+0.0391` absolute |
| Latency | Usually slower with memory enabled; exact ratio depends on path |

These are early local benchmarks, not a claim that the plugin perfectly recalls
session history. The practical goal is to measure when δ-state improves agent
behavior enough to justify the latency and setup cost.

## When Not To Use This

- You are not on Apple Silicon and need an efficient local runtime today.
- You want guaranteed transcript recall rather than attention shaping.
- You need a zero-setup hosted model provider.
- You cannot allocate disk space for local model artifacts.

## Documentation

- Sidecar repo: https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw
- Benchmark findings: https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw/blob/main/wiki/Benchmark-Findings.md
- δ-mem paper: https://arxiv.org/abs/2605.12357
- Upstream adapter: https://huggingface.co/declare-lab/delta-mem_qwen3_4b-instruct
- MLX adapter artifact: https://huggingface.co/ofthetrees/delta-mem-qwen3-4b-instruct-mlx-adapter

## License

[MIT](LICENSE)
