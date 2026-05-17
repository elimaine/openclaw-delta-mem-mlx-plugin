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

The script checks assumptions first. If the host is not macOS arm64, or Python 3.11 is missing, it offers `abort` by default.

Existing install:

```sh
npm run start-sidecar -- --root /path/to/delta-mem-mlx-sidecar-w-openclaw
```

When OpenClaw is running inside Lima, configure the sidecar base URL as:

```text
http://host.lima.internal:8765
```

For host-only testing, use:

```text
http://127.0.0.1:8765
```

## OpenClaw Tools

The plugin registers two optional tools:

- `delta_mem_mlx_status`: checks host assumptions and sidecar health.
- `delta_mem_mlx_provider_config`: generates the model-provider config block with a stable `X-OpenClaw-Session-Key`.

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
