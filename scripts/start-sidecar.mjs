#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_ROOT = path.join(os.homedir(), ".openclaw", "delta-mem-mlx-sidecar");

function readArg(name, defaultValue) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return defaultValue;
  return process.argv[index + 1] || defaultValue;
}

const root = readArg("root", process.env.DELTA_MEM_SIDECAR_ROOT || DEFAULT_ROOT);
const host = readArg("host", process.env.DELTA_MEM_HOST || "127.0.0.1");
const port = readArg("port", process.env.DELTA_MEM_PORT || "8765");
const sidecarDir = path.join(root, "delta-mem-sidecar");
const python = path.join(sidecarDir, ".venv", "bin", "python");

const env = {
  ...process.env,
  DELTA_MEM_RUNTIME: process.env.DELTA_MEM_RUNTIME || "mlx",
  DELTA_MEM_MODEL_PATH: process.env.DELTA_MEM_MODEL_PATH || "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
  DELTA_MEM_MODEL_ID: process.env.DELTA_MEM_MODEL_ID || "qwen2.5-0.5b-mlx-test",
  DELTA_MEM_MAX_NEW_TOKENS: process.env.DELTA_MEM_MAX_NEW_TOKENS || "256"
};

console.log(`Starting delta-mem MLX sidecar from ${sidecarDir}`);
console.log(`Listening on ${host}:${port}`);
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
