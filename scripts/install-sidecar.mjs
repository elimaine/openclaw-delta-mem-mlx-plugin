#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_URL = "https://github.com/elimaine/delta-mem-mlx-sidecar-w-openclaw.git";
const DEFAULT_ROOT = path.join(os.homedir(), ".openclaw", "delta-mem-mlx-sidecar");

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

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
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
    const mode = await ask(
      rl,
      "\nChoose install mode: clone, existing, or abort",
      missing.length > 0 ? "abort" : "clone"
    );

    if (mode === "abort") {
      console.log("Aborted. No sidecar files were installed.");
      return;
    }

    if (mode === "existing") {
      const existingRoot = await ask(rl, "Path to existing delta-mem repo", DEFAULT_ROOT);
      console.log("\nUse this OpenClaw sidecar base URL once it is running:");
      console.log("http://host.lima.internal:8765");
      console.log("\nExisting sidecar path:");
      console.log(existingRoot);
      return;
    }

    if (mode !== "clone") {
      throw new Error(`Unknown install mode: ${mode}`);
    }

    const root = await ask(rl, "Install sidecar repo to", DEFAULT_ROOT);
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

    const downloadModels = await ask(
      rl,
      "Download the public default smoke model with hf now? yes/no",
      "no"
    );
    if (downloadModels === "yes") {
      if (!commandExists("hf")) {
        console.log("Skipping model download because the Hugging Face CLI `hf` was not found.");
      } else {
        run("hf", ["download", "mlx-community/Qwen2.5-0.5B-Instruct-4bit"]);
      }
    }

    console.log("\nInstall complete.");
    console.log(`Sidecar repo: ${root}`);
    console.log("\nStart it with:");
    console.log(`node ${path.join(path.dirname(new URL(import.meta.url).pathname), "start-sidecar.mjs")} --root ${root}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
