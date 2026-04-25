#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function sanitizeSuffix(value) {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!sanitized) {
    throw new Error(
      "Could not derive a valid dev CLI name. Use `--name <suffix>` to set one explicitly.",
    );
  }

  return sanitized;
}

function shellDoubleQuote(value) {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function parseArgs(argv) {
  let name;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--name") {
      name = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, name };
}

function printHelp(log = console.log) {
  log("Install a per-worktree Roughdraft dev CLI wrapper.");
  log("");
  log("Usage:");
  log("  pnpm dev:install-cli");
  log("  pnpm dev:install-cli --name <suffix>");
  log("");
  log("Environment:");
  log("  ROUGHDRAFT_DEV_BIN_DIR   Override the wrapper install directory.");
  log(
    "  ROUGHDRAFT_DEV_STATE_BASE_DIR   Override the per-wrapper state directory root.",
  );
}

function getDefaultBinDir(env = process.env) {
  return env.ROUGHDRAFT_DEV_BIN_DIR || path.join(os.homedir(), ".local", "bin");
}

function buildDefaultStateDir(commandName, env = process.env) {
  const baseDir =
    env.ROUGHDRAFT_DEV_STATE_BASE_DIR ||
    path.join(os.homedir(), ".roughdraft", "dev");
  return path.join(baseDir, commandName);
}

function buildWrapperContent({ repoRoot, cliEntryPath, stateDir }) {
  return [
    "#!/usr/bin/env bash",
    `# roughdraft-dev-repo-root=${repoRoot}`,
    `if [[ -z "\${ROUGHDRAFT_STATE_DIR:-}" ]]; then export ROUGHDRAFT_STATE_DIR=${shellDoubleQuote(stateDir)}; fi`,
    `exec node ${shellDoubleQuote(cliEntryPath)} "$@"`,
    "",
  ].join("\n");
}

function readExistingTarget(wrapperPath) {
  if (!fs.existsSync(wrapperPath)) {
    return null;
  }

  const content = fs.readFileSync(wrapperPath, "utf8");
  const match = content.match(/^# roughdraft-dev-repo-root=(.+)$/m);
  return match?.[1] ?? null;
}

export function installDevCli(options = {}) {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dirname, "..");
  const rawSuffix = options.name ?? path.basename(repoRoot);
  const suffix = sanitizeSuffix(rawSuffix);
  const binDir = options.binDir ?? getDefaultBinDir(env);
  const cliEntryPath = path.join(
    repoRoot,
    "packages",
    "server",
    "bin",
    "roughdraft.mjs",
  );
  const commandName = `roughdraft-dev-${suffix}`;
  const stateDir = options.stateDir ?? buildDefaultStateDir(commandName, env);
  const wrapperPath = path.join(binDir, commandName);
  const wrapperContent = buildWrapperContent({
    repoRoot,
    cliEntryPath,
    stateDir,
  });
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;

  if (!fs.existsSync(cliEntryPath)) {
    throw new Error(`CLI entrypoint not found: ${cliEntryPath}`);
  }

  fs.mkdirSync(binDir, { recursive: true });

  const previousTarget = readExistingTarget(wrapperPath);
  fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);

  log(`Installed ${commandName} -> ${repoRoot}`);

  if (previousTarget && previousTarget !== repoRoot) {
    warn(
      `Overwrote existing ${commandName} wrapper that previously pointed to ${previousTarget}.`,
    );
  }

  const pathEntries = (env.PATH || "").split(path.delimiter).filter(Boolean);
  if (!pathEntries.includes(binDir)) {
    warn(
      `${binDir} is not on PATH. Invoke the wrapper with its full path or add that directory to your shell PATH.`,
    );
  }

  return {
    binDir,
    commandName,
    repoRoot,
    stateDir,
    suffix,
    wrapperPath,
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printHelp();
      process.exit(0);
    }

    installDevCli({ name: args.name });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Failed to install dev CLI wrapper.",
    );
    process.exit(1);
  }
}
