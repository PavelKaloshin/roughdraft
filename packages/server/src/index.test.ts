import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

describe("createApp", () => {
  let projectDir: string;
  let homeDir: string;
  const serverRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-server-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates a markdown page on disk", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app)
      .post("/api/pages")
      .send({ title: "Draft", projectPath: projectDir });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: "untitled-1",
      title: "Draft",
      content: "# Draft\n",
    });
    expect(response.body.version).toEqual(expect.any(String));

    const filePath = path.join(projectDir, "untitled-1.md");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("# Draft\n");
  });

  it("reads nested markdown files inside the project", async () => {
    const nestedDir = path.join(projectDir, "notes");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "draft.md"), "# Nested draft\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "notes/draft.md",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: "notes/draft",
      title: "Nested draft",
      content: "# Nested draft\n",
    });
    expect(response.body.version).toEqual(expect.any(String));
  });

  it("lists, updates, and deletes page-backed markdown files", async () => {
    fs.writeFileSync(path.join(projectDir, "alpha.md"), "# Alpha\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const listResponse = await request(app).get("/api/pages").query({
      projectPath: projectDir,
    });
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual([
      { id: "alpha", title: "Alpha", content: "# Alpha\n" },
    ]);

    const readResponse = await request(app).get("/api/pages/alpha").query({
      projectPath: projectDir,
    });
    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual({
      id: "alpha",
      title: "Alpha",
      content: "# Alpha\n",
    });

    const updateResponse = await request(app)
      .put("/api/pages/alpha")
      .query({ projectPath: projectDir })
      .send({ content: "# Beta\n" });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body).toEqual({
      id: "alpha",
      title: "Beta",
      content: "# Beta\n",
    });
    expect(fs.readFileSync(path.join(projectDir, "alpha.md"), "utf-8")).toBe(
      "# Beta\n",
    );

    const deleteResponse = await request(app).delete("/api/pages/alpha").query({
      projectPath: projectDir,
    });
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body).toEqual({ ok: true });
    expect(fs.existsSync(path.join(projectDir, "alpha.md"))).toBe(false);
  });

  it("saves a markdown file when the expected version matches", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Original\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const readResponse = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "draft.md",
    });

    const saveResponse = await request(app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "draft.md" })
      .send({
        content: "# Saved\n",
        expectedVersion: readResponse.body.version,
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toMatchObject({
      id: "draft",
      title: "Saved",
      content: "# Saved\n",
    });
    expect(saveResponse.body.version).toEqual(expect.any(String));
    expect(fs.readFileSync(path.join(projectDir, "draft.md"), "utf-8")).toBe(
      "# Saved\n",
    );
  });

  it("rejects stale markdown-file writes", async () => {
    const nestedDir = path.join(projectDir, "notes");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "draft.md"), "# Original\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const readResponse = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "notes/draft.md",
    });

    fs.writeFileSync(path.join(nestedDir, "draft.md"), "# External change\n");

    const staleWriteResponse = await request(app)
      .put("/api/markdown-file")
      .query({
        projectPath: projectDir,
        path: "notes/draft.md",
      })
      .send({
        content: "# Roughdraft change\n",
        expectedVersion: readResponse.body.version,
      });

    expect(staleWriteResponse.status).toBe(409);
    expect(staleWriteResponse.body).toMatchObject({
      error: "Markdown file changed on disk",
      current: {
        id: "notes/draft",
        title: "External change",
        content: "# External change\n",
      },
    });
    expect(staleWriteResponse.body.current.version).toEqual(expect.any(String));
    expect(fs.readFileSync(path.join(nestedDir, "draft.md"), "utf-8")).toBe(
      "# External change\n",
    );
  });

  it("rejects stale markdown-file writes when file metadata is unchanged", async () => {
    const filePath = path.join(projectDir, "draft.md");
    const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");
    fs.writeFileSync(filePath, "# Original\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const readResponse = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "draft.md",
    });

    fs.writeFileSync(filePath, "# External\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    const staleWriteResponse = await request(app)
      .put("/api/markdown-file")
      .query({
        projectPath: projectDir,
        path: "draft.md",
      })
      .send({
        content: "# Roughdraft\n",
        expectedVersion: readResponse.body.version,
      });

    expect(staleWriteResponse.status).toBe(409);
    expect(staleWriteResponse.body).toMatchObject({
      error: "Markdown file changed on disk",
      current: {
        id: "draft",
        title: "External",
        content: "# External\n",
      },
    });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("# External\n");
  });

  it("rejects markdown-file reads outside the project directory", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "../secrets.md",
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Markdown file not found" });
  });

  it("requires projectPath on project-backed routes", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/pages");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "projectPath is required" });
  });

  it("reports neutral server status without an active project", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      port: 4312,
    });

    const response = await request(app).get("/api/status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      backend: "local-files",
      pid: process.pid,
      port: 4312,
      serverRoot,
      stateless: true,
      capabilities: {
        projectPathRequired: true,
        fileSystemBrowsing: true,
      },
    });
    expect(response.body).not.toHaveProperty("projectDir");
  });

  it("reports update status from npm metadata", async () => {
    const packageJsonPath = path.join(projectDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "roughdraft", version: "0.1.0" }),
    );

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      packageJsonPath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "0.2.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const response = await request(app).get("/api/update-status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      updateCommand: "npm i -g roughdraft@latest",
    });
  });

  it("lists directories from the home directory when no path is provided", async () => {
    fs.mkdirSync(path.join(homeDir, "docs"));

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/directories");

    expect(response.status).toBe(200);
    expect(response.body.path).toBe(homeDir);
    expect(response.body.directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docs",
          path: path.join(homeDir, "docs"),
        }),
      ]),
    );
  });

  it("lists markdown files and directories for the file picker", async () => {
    fs.mkdirSync(path.join(homeDir, "docs"));
    fs.writeFileSync(path.join(homeDir, "draft.md"), "# Draft\n");
    fs.writeFileSync(path.join(homeDir, "ignored.txt"), "Nope\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/fs/list");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      path: homeDir,
      displayPath: "~",
      parentPath: null,
    });
    expect(response.body.directories).toEqual([
      {
        name: "docs",
        path: path.join(homeDir, "docs"),
        kind: "directory",
      },
    ]);
    expect(response.body.files).toEqual([
      {
        name: "draft.md",
        path: path.join(homeDir, "draft.md"),
        kind: "file",
      },
    ]);
  });

  it("returns project tree paths with directories before files", async () => {
    fs.mkdirSync(path.join(projectDir, "notes", "nested"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(projectDir, "zeta.md"), "# Zeta\n");
    fs.writeFileSync(path.join(projectDir, "notes", "alpha.md"), "# Alpha\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/file-tree").query({
      projectPath: projectDir,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      paths: ["notes/", "notes/nested/", "notes/alpha.md", "zeta.md"],
    });
  });

  it("opens and creates project directories", async () => {
    const createdDir = path.join(projectDir, "created", "workspace");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      port: 4321,
    });

    const openResponse = await request(app)
      .post("/api/project/open")
      .send({ path: projectDir });
    expect(openResponse.status).toBe(200);
    expect(openResponse.body).toEqual({
      backend: "local-files",
      projectDir,
      port: 4321,
    });

    const createResponse = await request(app)
      .post("/api/project/create")
      .send({ path: createdDir });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toEqual({
      backend: "local-files",
      projectDir: createdDir,
      port: 4321,
    });
    expect(fs.statSync(createdDir).isDirectory()).toBe(true);
  });

  it("reports an undelivered open request when no matching window is listening", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      port: 4312,
    });

    const response = await request(app)
      .post("/api/open-request")
      .send({
        path: path.join(projectDir, "draft.md"),
        url: "http://localhost:4312/?path=/tmp/draft.md",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ delivered: false });
  });

  it("serves local files and stores uploaded assets inside the project", async () => {
    fs.writeFileSync(path.join(projectDir, "image.txt"), "asset text\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const fileResponse = await request(app).get("/api/files").query({
      projectPath: projectDir,
      path: "image.txt",
    });
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.text).toBe("asset text\n");

    const assetResponse = await request(app)
      .post("/api/assets")
      .send({
        projectPath: projectDir,
        filename: "My Sketch.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("png bytes").toString("base64"),
      });

    expect(assetResponse.status).toBe(201);
    expect(assetResponse.body).toMatchObject({
      markdownPath: "./.roughdraft-assets/My-Sketch.png",
      mimeType: "image/png",
    });
    expect(assetResponse.body.previewUrl).toContain("/api/files?");
    expect(
      fs.readFileSync(
        path.join(projectDir, ".roughdraft-assets", "My-Sketch.png"),
        "utf-8",
      ),
    ).toBe("png bytes");
  });
});
