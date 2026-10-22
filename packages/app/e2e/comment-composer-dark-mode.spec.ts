import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/**
 * Dark mode: the new-comment composer sits inside the rail card, so it must
 * share the card's surface and keep its labels readable. A light surface
 * nested in the dark card left "Me", "Comment" and "Change" white-on-white.
 */
test.use({ colorScheme: "dark" });

type Rgba = [number, number, number, number];

/** Text colour and the opaque surface it is painted on (nearest non-transparent ancestor). */
async function paint(locator: Locator) {
  return locator.evaluate(async (element) => {
    // Read settled colours, not a frame of a hover/checked transition.
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    const parse = (value: string): Rgba => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) {
        // Tailwind v4 may emit oklch/oklab; let the browser resolve it.
        const canvas = document.createElement("canvas").getContext("2d");
        if (!canvas) throw new Error("no canvas");
        canvas.fillStyle = value;
        canvas.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      }
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    let node: Element | null = element;
    let background: Rgba = [0, 0, 0, 0];
    while (node) {
      const value = parse(getComputedStyle(node).backgroundColor);
      if (value[3] > 0.5) {
        background = value;
        break;
      }
      node = node.parentElement;
    }
    return {
      color: parse(getComputedStyle(element).color),
      background,
    };
  });
}

function luminance([r, g, b]: Rgba) {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function expectReadable(locator: Locator, label: string) {
  await expect(locator).toBeVisible();
  const { color, background } = await paint(locator);
  expect(
    contrast(color, background),
    `${label}: text ${color} on ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

async function snap(page: Page, name: string) {
  const dir = process.env.ROUGHDRAFT_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.resolve(dir, `${name}.png`) });
}

test.describe("comment composer in dark mode", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("composer-dark");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  // Wide windows show the side rail; below 1100px the comments render inline
  // above the document ("banner" variant), which is where the light surface was.
  const layouts = [
    {
      name: "side rail",
      width: 1280,
      variant: "rail",
      card: "comment-thread-c1",
    },
    {
      name: "inline (narrow window)",
      width: 1000,
      variant: "banner",
      card: "document-comment-fallback",
    },
  ] as const;

  for (const layout of layouts) {
    test(`${layout.name}: keeps the new-comment composer on the card's dark surface with readable labels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: layout.width, height: 800 });
      const filePath = writeProjectFile(
        projectDir,
        "dark.md",
        ["# Dark", "", "Cold start takes about four seconds.", ""].join("\n"),
      );
      await openMarkdownFile(page, filePath);
      await selectRichText(page, "about four seconds");
      await page.getByTestId("selection-menu-action-comment").click();
      const prefix = `comment-${layout.variant}-c1`;
      await page.getByTestId(`${prefix}-mode-ask`).click();
      await expect(page.getByTestId(`${prefix}-model`)).toBeVisible();
      await snap(page, `dark-composer-ask-${layout.variant}`);

      const cardSurface = (await paint(page.getByTestId(layout.card)))
        .background;
      // The card is dark, and nothing inside it repaints a light surface.
      expect(luminance(cardSurface)).toBeLessThan(0.2);
      expect(
        (await paint(page.getByTestId(`${prefix}-mode`))).background,
      ).toEqual(cardSurface);

      await expectReadable(page.getByTestId(`${prefix}-author`), "author");
      for (const option of ["comment", "ask", "change"]) {
        await expectReadable(
          page.getByTestId(`${prefix}-mode-${option}`),
          `mode ${option}`,
        );
      }
      for (const option of ["fast", "balanced", "session"]) {
        await expectReadable(
          page.getByTestId(`${prefix}-model-${option}`),
          `model ${option}`,
        );
      }
    });
  }
});
