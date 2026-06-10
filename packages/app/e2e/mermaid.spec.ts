import { expect, test } from "@playwright/test";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const MERMAID_DOC = [
  "# Flow",
  "",
  "```mermaid",
  "graph TD;",
  "  A-->B;",
  "  A-->C;",
  "```",
  "",
].join("\n");

test.describe("mermaid diagrams", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("mermaid");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("renders a mermaid code block as an SVG diagram @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "diagram.md", MERMAID_DOC);

    await openMarkdownFile(page, filePath);

    const diagram = page.getByTestId("mermaid-diagram");
    await expect(diagram).toBeVisible();
    // The rendered-SVG container only appears once mermaid finishes drawing.
    await expect(page.getByTestId("mermaid-diagram-rendered")).toBeVisible();
    // The raw fence text must not be shown verbatim in the rendered diagram.
    await expect(diagram).not.toContainText("graph TD;");

    logE2eEvent("mermaid.rendered", { projectDir, file: "diagram.md" });
  });

  test("keeps the mermaid source editable in code mode @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "source.md", MERMAID_DOC);

    await openMarkdownFile(page, filePath, "code");

    await expect(codeEditor(page)).toContainText("```mermaid");
    await expect(codeEditor(page)).toContainText("graph TD;");

    logE2eEvent("mermaid.source-preserved", { projectDir, file: "source.md" });
  });
});
