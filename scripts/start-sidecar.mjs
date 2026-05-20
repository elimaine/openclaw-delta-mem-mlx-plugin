#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_ROOT = path.join(os.homedir(), ".delta-mem", "delta-mem-mlx");
const DEFAULT_MODEL_PRESET = "qwen3-delta";
const MODEL_PRESETS = {
  smoke: {
    modelPath: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    modelId: "qwen2.5-0.5b-mlx-test",
    adapterDirName: ""
  },
  "qwen3-delta": {
    modelPath: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    modelId: "delta-mem-qwen3-4b-mlx",
    adapterDirName: "delta-mem-qwen3-4b-instruct-mlx-adapter"
  }
};

function readArg(name, defaultValue) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return defaultValue;
  return process.argv[index + 1] || defaultValue;
}

const root = readArg("root", process.env.DELTA_MEM_SIDECAR_ROOT || DEFAULT_ROOT);
const modelPresetName = readArg("model-preset", process.env.DELTA_MEM_MODEL_PRESET || DEFAULT_MODEL_PRESET);
const modelPreset = MODEL_PRESETS[modelPresetName] || MODEL_PRESETS[DEFAULT_MODEL_PRESET];
const host = readArg("host", process.env.DELTA_MEM_HOST || "127.0.0.1");
const port = readArg("port", process.env.DELTA_MEM_PORT || "8765");
const modelPath = readArg("model-path", process.env.DELTA_MEM_MODEL_PATH || modelPreset.modelPath);
const modelId = readArg("model-id", process.env.DELTA_MEM_MODEL_ID || modelPreset.modelId);
const defaultAdapterDir = modelPreset.adapterDirName ? path.join(root, "adapters", modelPreset.adapterDirName) : "";
const adapterDir = readArg("adapter-dir", process.env.DELTA_MEM_ADAPTER_DIR || defaultAdapterDir);
const sidecarDir = path.join(root, "delta-mem-sidecar");
const python = path.join(sidecarDir, ".venv", "bin", "python");

const env = {
  ...process.env,
  DELTA_MEM_RUNTIME: process.env.DELTA_MEM_RUNTIME || "mlx",
  DELTA_MEM_MODEL_PATH: modelPath,
  DELTA_MEM_MODEL_ID: modelId,
  DELTA_MEM_MAX_NEW_TOKENS: process.env.DELTA_MEM_MAX_NEW_TOKENS || "256"
};

if (adapterDir) {
  const required = ["delta_mem_config.json", "delta_mem_adapter_mlx.npz"];
  const missing = required.filter((fileName) => !existsSync(path.join(adapterDir, fileName)));
  if (missing.length > 0) {
    console.error(`Adapter directory is incomplete: ${adapterDir}`);
    console.error(`Missing: ${missing.join(", ")}`);
    console.error("Run install-sidecar with --download-model yes, or convert the upstream adapter before starting.");
    process.exit(1);
  }
  env.DELTA_MEM_ADAPTER_DIR = adapterDir;
}

console.log(`Starting delta-mem MLX sidecar from ${sidecarDir}`);
console.log(`Listening on ${host}:${port}`);
console.log(`Model path: ${modelPath}`);
if (adapterDir) console.log(`Adapter dir: ${adapterDir}`);
console.log("This assumes macOS on Apple Silicon with the MLX extras installed.");

const child = spawn(python, [
  "-m",
  "uvicorn",
  "delta_mem_sidecar.app:create_app",
  "--factory",
  "--host",
  host,
  "--port",
  port
], {
  cwd: sidecarDir,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
