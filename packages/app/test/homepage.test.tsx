import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Homepage, RoughdraftFlavoredMarkdownPage } from "../src/App";

const AGENT_SETUP_PROMPT =
  "Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.page/setup.md and set yourself up to use it.";

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("Homepage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("opens the agent setup prompt from the CTA and copies it", async () => {
    await act(async () => {
      root.render(
        <Homepage
          message="Roughdraft is a markdown editor with commenting and suggest changes mode, making it easier to align with AI on complex ideas."
          updateStatus={null}
        />,
      );
    });

    expect(container.textContent).toContain(
      "Easier collaboration with your coding agent",
    );
    expect(container.textContent).toContain(
      "making it easier to align with AI on complex ideas",
    );
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Open-source");
    expect(container.textContent).toContain("Runs locally");
    expect(container.textContent).toContain("Roughdraft flavored Markdown");
    expect(container.textContent).toContain(
      "We extended Markdown to add support for comment threads and suggested changes.",
    );
    expect(container.textContent).toContain(
      "blends CriticMarkup with Notion-style review affordances",
    );
    expect(container.textContent).toContain(
      "{~~rough notes~>clear next steps~~}",
    );
    expect(
      container.querySelectorAll('[contenteditable="plaintext-only"]'),
    ).toHaveLength(0);
    expect(
      container
        .querySelector('img[alt="Roughdraft markdown review workspace"]')
        ?.getAttribute("src"),
    ).toBe("/sneak-peek.png");
    expect(document.body.textContent).not.toContain(AGENT_SETUP_PROMPT);

    const cta = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Install Now"),
    );
    const githubLink = container.querySelector(
      'a[href="https://github.com/Lex-Inc/roughdraft"]',
    );

    expect(githubLink?.textContent).toContain("View on GitHub");
    expect(githubLink?.getAttribute("target")).toBe("_blank");
    expect(githubLink?.getAttribute("rel")).toBe("noreferrer");
    expect(
      container.querySelector('a[href="/roughdraft-flavored-markdown"]')
        ?.textContent,
    ).toContain("Read the spec");

    expect(cta).toBeDefined();
    if (!cta) throw new Error("CTA not found");

    await click(cta);

    expect(document.body.textContent).toContain(
      "Copy this into your coding agent",
    );
    expect(document.body.textContent).toContain(AGENT_SETUP_PROMPT);

    const copyButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Copy prompt"),
    );

    expect(copyButton).toBeDefined();
    if (!copyButton) throw new Error("Copy button not found");

    await click(copyButton);

    expect(writeText).toHaveBeenCalledWith(AGENT_SETUP_PROMPT);
    expect(document.body.textContent).toContain("Copied");
  });

  it("renders the Roughdraft flavored Markdown spec page", async () => {
    await act(async () => {
      root.render(<RoughdraftFlavoredMarkdownPage />);
    });

    expect(container.textContent).toContain(
      "Markdown with review comments and suggested changes",
    );
    expect(container.textContent).toContain(
      "regular Markdown plus portable review markup",
    );
    expect(container.textContent).toContain("Threaded review");
    expect(container.textContent).toContain("Substitution");
    expect(container.textContent).toContain("{~~old text~>new text~~}");
    expect(container.querySelector('a[href="/"]')?.textContent).toContain(
      "Back to Roughdraft",
    );
  });
});
