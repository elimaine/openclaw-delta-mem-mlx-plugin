# OpenClaw Delta-Mem MLX Plugin

Native OpenClaw helper plugin for the public delta-mem MLX sidecar. This is an
OpenClaw plugin, not a Codex plugin or Codex skill:

https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw

This plugin is Apple Silicon first. The sidecar uses MLX, so the expected host is macOS on arm64 with Python 3.11+. The plugin can help install/start the sidecar, but it keeps those actions explicit so users can bail out and manage the MLX runtime somewhere else.

## What It Does

- Checks whether the host looks like Apple Silicon.
- Checks the sidecar `/health` endpoint.
- Emits an optional OpenClaw model-provider config block for the sidecar.
- Provides helper scripts to clone/install/start the public sidecar repo.

It does not silently download model weights. The installer asks before running `hf download`.

The provider config uses OpenClaw's legacy `api: "openai-completions"` provider
label while setting `transportProtocol: "openai-chat-completions"` and endpoint
`/v1/chat/completions`. The important memory-routing contract is the stable
`X-OpenClaw-Session-Key` header.

The emitted provider config also requests attention-state lookup by default:
QMD `vsearch`, queried from the outgoing message, with up to six snippets. That
setting is a request to OpenClaw's provider layer. The sidecar accepts retrieved
snippets as `attention_state`, `attentionState`, `delta_attention_state`,
or `X-Delta-Attention-State`; when snippets arrive, it preloads them through
the same per-session δ-state before generating the real assistant response. The
goal is attention shaping, not direct fact parroting.

## Install

Local linked install:

```sh
git clone https://github.com/elimaine/openclaw-delta-mem-mlx-plugin.git
openclaw plugins install -l ./openclaw-delta-mem-mlx-plugin
```

After ClawHub publishing:

```sh
openclaw plugins install clawhub:@ofthetrees/openclaw-delta-mem-mlx
```

## Sidecar Setup

Managed install:

```sh
npm run install-sidecar
```

The script checks assumptions first. If the host is not macOS arm64, or Python 3.11 is missing, it offers `abort` by default. A completed managed install starts the sidecar automatically and waits for `/health`.

Install without starting:

```sh
npm run install-sidecar-only
```

Non-interactive install:

```sh
npm run install-sidecar -- --mode clone --root ~/.openclaw/delta-mem-mlx-sidecar --model-preset qwen3-delta --download-model yes
```

Model presets:

- `qwen3-delta`: default compatible public δ-mem path, `mlx-community/Qwen3-4B-Instruct-2507-4bit` plus the upstream `declare-lab/delta-mem_qwen3_4b-instruct` adapter converted locally to MLX.
- `smoke`: small toy runtime, `mlx-community/Qwen2.5-0.5B-Instruct-4bit`, exposed as `qwen2.5-0.5b-mlx-test`.
- `custom`: user-supplied MLX model path and optional adapter directory.

Downloads are gated. The installer asks before running `hf download`, even for the default smoke model. Custom adapter runs check Apple Silicon memory and the known released δ-mem adapter/backbone compatibility; incompatible combinations abort unless explicitly approved.
The Qwen3 δ preset validates that `delta_mem_config.json` and `delta_mem_adapter_mlx.npz` are present before startup, so a partial adapter snapshot fails early with a clear message instead of producing a later HTTP 500.

Examples:

```sh
npm run install-sidecar -- --mode clone --model-preset smoke --download-model no
npm run install-sidecar -- --mode clone --model-preset qwen3-delta --download-model yes
npm run install-sidecar -- --mode clone --model-preset custom --model-path mlx-community/Qwen3-4B-Instruct-2507-4bit --adapter-dir /path/to/adapter
```

Existing install:

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

This is a fallback for OpenClaw builds that do not yet pass an explicit
`attention_state` request field. If QMD is missing, times out, or exits nonzero,
the sidecar still answers normally and reports
`X-Delta-Attention-State-Count: 0`.

Configure `sidecarBaseUrl` to whatever route OpenClaw has to the sidecar. If
OpenClaw and the sidecar run on the same host, use:

```text
http://127.0.0.1:8765
```

If OpenClaw runs in a VM/container and the sidecar runs on the host, use the
host route provided by that environment. For example, some Lima setups expose
the host as:

```text
http://host.lima.internal:8765
```

## OpenClaw Tools

The plugin registers two optional tools:

- `delta_mem_mlx_status`: checks host assumptions and sidecar health.
- `delta_mem_mlx_provider_config`: generates the model-provider config block with a stable `X-OpenClaw-Session-Key` and QMD `vsearch` attention-state defaults.

## OpenClaw Provider Hook

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

Verify the hook by checking the sidecar response headers:
`X-Delta-Attention-State-Count` should be greater than `0`, and
`X-Delta-Attention-State-Source` should be `request`. The sidecar method above
will instead report `qmd`.

## Benchmarks

The public sidecar repo keeps current benchmark notes in:

https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw/blob/main/wiki/Benchmark-Findings.md

The strongest OpenClaw-shaped QMD preload tests improved from `0.5625` plain to
`0.7292` δ-mem (`1.30x`) at `1.48x` to `1.63x` probe latency, using the older
lenient scorer. The stricter OpenClaw-16 replay showed weaker exact-recall
recovery (`+0.0391`) with effectively flat latency (`1.01x`).

## ClawHub Publish

Dry run first:

```sh
clawhub package publish . --family code-plugin --dry-run
```

Publish:

```sh
clawhub package publish . --family code-plugin
```
