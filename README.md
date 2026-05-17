# Delta-Mem MLX for OpenClaw

This OpenClaw plugin connects agents to a local Apple Silicon δ-mem sidecar: an
OpenAI-compatible chat-completions service that runs MLX models and can preload
retrieved memory into a compact neural state before each response.

The exciting part is that this is not just another context-injection plugin.
δ-mem changes the attention path of a frozen model with a small online memory
state. That means an agent can be shaped by prior session state without stuffing
every remembered fact into the visible prompt. In local tests, the base model
consistently improved with the δ-mem adapter attached, while richer OpenClaw
memory-preload experiments are still being tuned.

The current public stack is:

- OpenClaw plugin: model-provider config, health checks, and sidecar helpers.
- FastAPI sidecar: OpenAI-compatible `/v1/chat/completions` endpoint.
- MLX / mlx-lm: Apple Silicon native inference.
- Qwen3 4B MLX backbone: `mlx-community/Qwen3-4B-Instruct-2507-4bit`.
- Converted δ-mem adapter: `ofthetrees/delta-mem-qwen3-4b-instruct-mlx-adapter`.
- Optional QMD lookup: retrieved snippets can be passed as `attention_state` for
  δ-state preloading instead of visible prompt context.

Sidecar and benchmark repo:

https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw

δ-mem paper:

https://arxiv.org/abs/2605.12357

## What This Plugin Does

- Checks whether the host looks like Apple Silicon.
- Checks the sidecar `/health` endpoint.
- Emits an OpenClaw model-provider config for the sidecar.
- Adds the stable session header needed for per-session δ-state.
- Requests QMD-backed attention-state lookup by default when OpenClaw supports
  that provider hook.
- Provides helper scripts to clone, install, and start the public sidecar.

It does not silently download model weights. The installer asks before running
`hf download`, and users can skip managed install entirely if they already have a
sidecar running.

## How It Works

OpenClaw talks to the sidecar as an OpenAI-compatible chat-completions provider:

- `baseUrl`: sidecar `/v1` root
- `transportProtocol`: `openai-chat-completions`
- `endpoint`: `/v1/chat/completions`
- stable header: `X-OpenClaw-Session-Key`

When retrieved memory is available, the sidecar accepts it as `attention_state`,
`attentionState`, `delta_attention_state`, or `X-Delta-Attention-State`. It then
warms the same per-session δ-state before generating the real assistant answer.
The goal is attention shaping, not direct fact parroting.

## Install From ClawHub

```sh
openclaw plugins install clawhub:@elimaine/openclaw-delta-mem-mlx
```

Local linked install:

```sh
git clone https://github.com/elimaine/openclaw-delta-mem-mlx-plugin.git
openclaw plugins install -l ./openclaw-delta-mem-mlx-plugin
```

## Sidecar Setup

Managed install:

```sh
npm run install-sidecar
```

The script checks assumptions first. If the host is not macOS arm64, or Python
3.11 is missing, it offers `abort` by default. A completed managed install
starts the sidecar automatically and waits for `/health`.

Install without starting:

```sh
npm run install-sidecar-only
```

Non-interactive install:

```sh
npm run install-sidecar -- --mode clone --root ~/.openclaw/delta-mem-mlx-sidecar --model-preset qwen3-delta --download-model yes
```

Model presets:

- `qwen3-delta`: default compatible public δ-mem path,
  `mlx-community/Qwen3-4B-Instruct-2507-4bit` plus the upstream
  `declare-lab/delta-mem_qwen3_4b-instruct` adapter converted locally to MLX.
- `smoke`: small toy runtime, `mlx-community/Qwen2.5-0.5B-Instruct-4bit`,
  exposed as `qwen2.5-0.5b-mlx-test`.
- `custom`: user-supplied MLX model path and optional adapter directory.

Downloads are gated. The Qwen3 δ preset validates that
`delta_mem_config.json` and `delta_mem_adapter_mlx.npz` are present before
startup, so a partial adapter snapshot fails early with a clear message.

Existing sidecar:

```sh
npm run start-sidecar -- --root /path/to/delta-mem-mlx-sidecar-w-openclaw
```

Start with the sidecar-local QMD attention-state fallback:

```sh
npm run start-sidecar -- \
  --root /path/to/delta-mem-mlx-sidecar-w-openclaw \
  --attention-state-source qmd \
  --qmd-mode vsearch \
  --qmd-limit 6
```

If QMD is missing, times out, or exits nonzero, the sidecar still answers
normally and reports `X-Delta-Attention-State-Count: 0`.

## Routing

Configure `sidecarBaseUrl` to whatever route OpenClaw has to the sidecar.

Same host:

```text
http://127.0.0.1:8765
```

VM/container to host:

```text
http://<host-route>:8765
```

## OpenClaw Tools

The plugin registers two optional tools:

- `delta_mem_mlx_status`: checks host assumptions and sidecar health.
- `delta_mem_mlx_provider_config`: generates the provider config block with a
  stable `X-OpenClaw-Session-Key` and QMD `vsearch` attention-state defaults.

## Provider Hook

Best behavior is for OpenClaw to retrieve QMD state before the provider call and
send it to the sidecar outside the visible prompt:

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
 const headers = {
   Authorization: `Bearer ${apiKey}`,
   "Content-Type": "application/json",
   "X-OpenClaw-Session-Key": sessionKey
 };
```

Verify the hook by checking response headers:

- `X-Delta-Attention-State-Count` greater than `0`
- `X-Delta-Attention-State-Source: request`

The sidecar-local QMD fallback reports `X-Delta-Attention-State-Source: qmd`
instead.

## Benchmarks

Current benchmark notes live in the sidecar wiki:

https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw/blob/main/wiki/Benchmark-Findings.md

The strongest OpenClaw-shaped QMD preload tests improved from `0.5625` plain to
`0.7292` δ-mem (`1.30x`) at `1.48x` to `1.63x` probe latency, using the older
lenient scorer. The stricter OpenClaw-16 replay showed weaker exact-recall
recovery (`+0.0391`) with effectively flat latency (`1.01x`).
