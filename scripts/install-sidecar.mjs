#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { access, mkdir } from "node:fs/promises";
import { closeSync, constants, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO_URL = "https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw.git";
const DEFAULT_ROOT = path.join(os.homedir(), ".openclaw", "delta-mem-mlx-sidecar");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "8765";
const DEFAULT_MODEL_PRESET = "qwen3-delta";
const MODEL_PRESETS = {
  smoke: {
    label: "Small Qwen2.5 MLX smoke model",
    modelPath: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    modelId: "qwen2.5-0.5b-mlx-test",
    minMemoryGb: 8,
    adapterRepo: "",
    adapterDirName: ""
  },
  "qwen3-delta": {
    label: "Qwen3-4B MLX with converted δ-mem adapter",
    modelPath: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    modelId: "delta-mem-qwen3-4b-mlx",
    minMemoryGb: 16,
    adapterRepo: "declare-lab/delta-mem_qwen3_4b-instruct",
    adapterDirName: "delta-mem-qwen3-4b-instruct-mlx-adapter"
  }
};

function getArg(name) {
  const long = `--${name}`;
  const index = process.argv.indexOf(long);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function readArg(name, defaultValue) {
  return getArg(name) || defaultValue;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false
  });
  return result.status === 0;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function systemMemoryGb() {
  if (process.platform !== "darwin") return 0;
  const bytes = Number(commandOutput("sysctl", ["-n", "hw.memsize"]));
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / 1024 / 1024 / 1024;
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ask(rl, question, defaultValue) {
  if (!input.isTTY) return defaultValue;
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return true;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Sidecar did not become healthy at ${baseUrl}/health within ${timeoutMs / 1000}s. Last error: ${lastError}`);
}

function startSidecar(root, host, port, modelConfig) {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "start-sidecar.mjs");
  const sidecarDir = path.join(root, "delta-mem-sidecar");
  const logPath = path.join(sidecarDir, "sidecar.log");
  const args = [
    scriptPath,
    "--root",
    root,
    "--host",
    host,
    "--port",
    port,
    "--model-path",
    modelConfig.modelPath,
    "--model-id",
    modelConfig.modelId
  ];
  if (modelConfig.adapterDir) {
    args.push("--adapter-dir", modelConfig.adapterDir);
  }
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    closeSync(logFd);
  }
}

function checkModelCompatibility(modelConfig) {
  const memoryGb = systemMemoryGb();
  const warnings = [];
  if (memoryGb > 0 && memoryGb < modelConfig.minMemoryGb) {
    warnings.push(`detected ${memoryGb.toFixed(1)}GB memory, expected at least ${modelConfig.minMemoryGb}GB for ${modelConfig.modelId}`);
  }
  if (modelConfig.adapterDir || modelConfig.adapterRepo) {
    const compatibleBackbone = /Qwen3-4B-Instruct-2507/i.test(modelConfig.modelPath);
    if (!compatibleBackbone) {
      warnings.push("adapter compatibility check failed: the released δ-mem adapter is expected to target Qwen3-4B-Instruct-2507");
    }
  }
  return { memoryGb, warnings };
}

async function validateLocalArtifacts(modelConfig) {
  if (modelConfig.adapterDir && !(await exists(modelConfig.adapterDir))) {
    throw new Error(
      `Adapter directory is missing: ${modelConfig.adapterDir}. Download the selected artifacts, pass --adapter-dir to an existing local adapter, or install with --no-start.`
    );
  }
  if (modelConfig.adapterDir) {
    const required = ["delta_mem_config.json", "delta_mem_adapter_mlx.npz"];
    const missing = [];
    for (const fileName of required) {
      if (!(await exists(path.join(modelConfig.adapterDir, fileName)))) missing.push(fileName);
    }
    if (missing.length > 0) {
      throw new Error(
        `Adapter directory is incomplete: ${modelConfig.adapterDir}. Missing ${missing.join(", ")}. ` +
          "Run the installer with --download-model yes, or convert an upstream adapter with " +
          "`python -m delta_mem_sidecar.convert_adapter /path/to/adapter`."
      );
    }
  }
}

async function resolveModelConfig(rl, root) {
  const presetName = getArg("model-preset") || await ask(
    rl,
    "Choose model preset: smoke, qwen3-delta, or custom",
    DEFAULT_MODEL_PRESET
  );
  if (presetName === "custom") {
    const modelPath = getArg("model-path") || await ask(rl, "Custom MLX model path or Hugging Face repo", MODEL_PRESETS[DEFAULT_MODEL_PRESET].modelPath);
    const modelId = getArg("model-id") || await ask(rl, "OpenAI model id exposed by the sidecar", path.basename(modelPath).toLowerCase());
    const adapterDir = getArg("adapter-dir") || await ask(rl, "Optional local MLX adapter directory, blank for none", "");
    return {
      label: "Custom MLX model",
      modelPath,
      modelId,
      minMemoryGb: Number(getArg("min-memory-gb") || "16"),
      adapterRepo: "",
      adapterDir
    };
  }
  const preset = MODEL_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown model preset: ${presetName}`);
  }
  return {
    ...preset,
    adapterDir: preset.adapterDirName ? path.join(root, "adapters", preset.adapterDirName) : ""
  };
}

function downloadModelArtifacts(root, modelConfig) {
  if (!commandExists("hf")) {
    console.log("Skipping model download because the Hugging Face CLI `hf` was not found.");
    return;
  }
  run("hf", ["download", modelConfig.modelPath]);
  if (modelConfig.adapterRepo && modelConfig.adapterDir) {
    run("hf", ["download", modelConfig.adapterRepo, "--local-dir", modelConfig.adapterDir]);
    const converter = path.join(root, "delta-mem-sidecar", ".venv", "bin", "python");
    const mlxAdapter = path.join(modelConfig.adapterDir, "delta_mem_adapter_mlx.npz");
    const adapterExists = spawnSync("test", ["-f", mlxAdapter], { stdio: "ignore" }).status === 0;
    if (!adapterExists) {
      run(converter, ["-m", "delta_mem_sidecar.convert_adapter", modelConfig.adapterDir]);
    }
  }
}

async function main() {
  console.log("Delta-Mem MLX sidecar installer for OpenClaw");
  console.log("Target platform: macOS on Apple Silicon. The MLX runtime is not intended for Linux/Windows hosts.");

  const platformOk = process.platform === "darwin";
  const archOk = process.arch === "arm64";
  const missing = [];
  if (!platformOk) missing.push(`platform is ${process.platform}, expected darwin`);
  if (!archOk) missing.push(`architecture is ${process.arch}, expected arm64`);
  for (const command of ["git", "python3.11"]) {
    if (!commandExists(command)) missing.push(`${command} not found`);
  }

  if (missing.length > 0) {
    console.log("\nAssumption check failed:");
    for (const item of missing) console.log(`- ${item}`);
    console.log("\nYou can bail out now, install the MLX sidecar elsewhere, then configure OpenClaw with that sidecar URL.");
  }

  const rl = createInterface({ input, output });
  try {
    const mode = getArg("mode") || await ask(
      rl,
      "\nChoose install mode: clone, existing, or abort",
      missing.length > 0 ? "abort" : "clone"
    );

    if (mode === "abort") {
      console.log("Aborted. No sidecar files were installed.");
      return;
    }

    const host = readArg("host", process.env.DELTA_MEM_HOST || DEFAULT_HOST);
    const port = readArg("port", process.env.DELTA_MEM_PORT || DEFAULT_PORT);
    const shouldStart = !hasFlag("no-start");
    const startIfRequested = async (root, modelConfig) => {
      if (!shouldStart) {
        console.log("\nInstall complete. Sidecar was not started because --no-start was provided.");
        console.log(`Sidecar repo: ${root}`);
        console.log(`Selected model: ${modelConfig.modelPath}`);
        if (modelConfig.adapterDir) console.log(`Selected adapter: ${modelConfig.adapterDir}`);
        return;
      }
      await validateLocalArtifacts(modelConfig);
      console.log(`\nStarting sidecar on http://${host}:${port} ...`);
      const started = startSidecar(root, host, port, modelConfig);
      console.log(`Sidecar process started with pid ${started.pid}.`);
      console.log(`Log file: ${started.logPath}`);
      await waitForHealth(`http://${host}:${port}`);
      console.log(`Sidecar health OK: http://${host}:${port}/health`);
    };

    if (mode === "existing") {
      const existingRoot = getArg("root") || await ask(rl, "Path to existing delta-mem repo", DEFAULT_ROOT);
      console.log("\nUse this OpenClaw sidecar base URL once it is running:");
      console.log("Set sidecarBaseUrl to whatever route OpenClaw has to the sidecar, for example http://127.0.0.1:8765 when same-host.");
      console.log("\nExisting sidecar path:");
      console.log(existingRoot);
      const modelConfig = await resolveModelConfig(rl, existingRoot);
      const compatibility = checkModelCompatibility(modelConfig);
      if (compatibility.warnings.length > 0) {
        console.log("\nCompatibility warnings:");
        for (const warning of compatibility.warnings) console.log(`- ${warning}`);
        const proceed = getArg("approve-compatibility") || await ask(rl, "Proceed anyway? yes/no", "no");
        if (proceed !== "yes") throw new Error("Aborted because model/adapter compatibility was not approved.");
      }
      await startIfRequested(existingRoot, modelConfig);
      return;
    }

    if (mode !== "clone") {
      throw new Error(`Unknown install mode: ${mode}`);
    }

    const root = getArg("root") || await ask(rl, "Install sidecar repo to", DEFAULT_ROOT);
    await mkdir(path.dirname(root), { recursive: true });

    if (await exists(path.join(root, ".git"))) {
      console.log(`\nRepo already exists at ${root}; pulling latest main.`);
      run("git", ["pull", "--ff-only"], { cwd: root });
    } else {
      run("git", ["clone", REPO_URL, root]);
    }

    const sidecarDir = path.join(root, "delta-mem-sidecar");
    run("python3.11", ["-m", "venv", ".venv"], { cwd: sidecarDir });
    run(path.join(sidecarDir, ".venv", "bin", "python"), [
      "-m",
      "pip",
      "install",
      "-e",
      ".[mlx,test]"
    ], { cwd: sidecarDir });

    const modelConfig = await resolveModelConfig(rl, root);
    console.log("\nSelected model:");
    console.log(`- ${modelConfig.label}`);
    console.log(`- model: ${modelConfig.modelPath}`);
    if (modelConfig.adapterRepo) console.log(`- adapter: ${modelConfig.adapterRepo}`);
    const compatibility = checkModelCompatibility(modelConfig);
    if (compatibility.memoryGb > 0) console.log(`- detected memory: ${compatibility.memoryGb.toFixed(1)}GB`);
    if (compatibility.warnings.length > 0) {
      console.log("\nCompatibility warnings:");
      for (const warning of compatibility.warnings) console.log(`- ${warning}`);
      const proceed = getArg("approve-compatibility") || await ask(rl, "Proceed anyway? yes/no", "no");
      if (proceed !== "yes") throw new Error("Aborted because model/adapter compatibility was not approved.");
    }

    const defaultDownload = modelConfig.adapterRepo && input.isTTY ? "yes" : "no";
    const downloadModels = getArg("download-model") || await ask(
      rl,
      "Download selected public Hugging Face model artifacts now? yes/no",
      defaultDownload
    );
    if (downloadModels === "yes") {
      downloadModelArtifacts(root, modelConfig);
    }

    console.log("\nInstall complete.");
    console.log(`Sidecar repo: ${root}`);
    await startIfRequested(root, modelConfig);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
