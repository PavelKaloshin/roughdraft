import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDevCli } from "../../../scripts/install-dev-cli.mjs";

const tempDirs: string[] = [];

function createFixtureRepo(basename = "lyon-v2") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-dev-cli-"));
  tempDirs.push(tempDir);

  const repoRoot = path.join(tempDir, basename);
  const cliEntryPath = path.join(
    repoRoot,
    "packages",
    "server",
    "bin",
    "roughdraft.mjs",
  );

  fs.mkdirSync(path.dirname(cliEntryPath), { recursive: true });
  fs.writeFileSync(cliEntryPath, "#!/usr/bin/env node\n", "utf8");

  return { repoRoot, tempDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("installDevCli", () => {
  it("installs a wrapper using the worktree directory name by default", () => {
    const { repoRoot, tempDir } = createFixtureRepo("lyon-v2");
    const binDir = path.join(tempDir, "bin");
    const warnings: string[] = [];

    const result = installDevCli({
      binDir,
      env: { PATH: binDir },
      repoRoot,
      warn: (message: string) => warnings.push(message),
    });

    const wrapperContent = fs.readFileSync(result.wrapperPath, "utf8");
    const mode = fs.statSync(result.wrapperPath).mode & 0o777;
    const expectedStateDir = path.join(
      os.homedir(),
      ".roughdraft",
      "dev",
      "roughdraft-dev-lyon-v2",
    );

    expect(result.commandName).toBe("roughdraft-dev-lyon-v2");
    expect(wrapperContent).toContain(`# roughdraft-dev-repo-root=${repoRoot}`);
    expect(wrapperContent).toContain(
      `if [[ -z "\${ROUGHDRAFT_STATE_DIR:-}" ]]; then export ROUGHDRAFT_STATE_DIR="${expectedStateDir}"; fi`,
    );
    expect(wrapperContent).toContain(
      `exec node "${path.join(repoRoot, "packages", "server", "bin", "roughdraft.mjs")}" "$@"`,
    );
    expect(mode).toBe(0o755);
    expect(result.stateDir).toBe(expectedStateDir);
    expect(warnings).toEqual([]);
  });

  it("sanitizes a custom name override", () => {
    const { repoRoot, tempDir } = createFixtureRepo("lyon-v2");

    const result = installDevCli({
      binDir: path.join(tempDir, "bin"),
      env: { PATH: "" },
      name: "API Redesign!!!",
      repoRoot,
      warn: () => {},
    });

    expect(result.commandName).toBe("roughdraft-dev-api-redesign");
  });

  it("warns when overwriting a wrapper for a different repo", () => {
    const firstRepo = createFixtureRepo("lyon-v2").repoRoot;
    const secondRepo = createFixtureRepo("lyon-v2-copy").repoRoot;
    const binDir = path.join(path.dirname(firstRepo), "bin");
    const warnings: string[] = [];

    installDevCli({
      binDir,
      env: { PATH: binDir },
      name: "shared",
      repoRoot: firstRepo,
      warn: () => {},
    });

    installDevCli({
      binDir,
      env: { PATH: binDir },
      name: "shared",
      repoRoot: secondRepo,
      warn: (message: string) => warnings.push(message),
    });

    expect(warnings).toContain(
      `Overwrote existing roughdraft-dev-shared wrapper that previously pointed to ${firstRepo}.`,
    );
  });

  it("warns when the bin dir is not on PATH", () => {
    const { repoRoot, tempDir } = createFixtureRepo("lyon-v2");
    const binDir = path.join(tempDir, "bin");
    const warnings: string[] = [];

    installDevCli({
      binDir,
      env: { PATH: "/usr/local/bin" },
      repoRoot,
      warn: (message: string) => warnings.push(message),
    });

    expect(warnings).toContain(
      `${binDir} is not on PATH. Invoke the wrapper with its full path or add that directory to your shell PATH.`,
    );
  });
});
