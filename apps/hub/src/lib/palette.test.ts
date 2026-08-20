import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRANDS } from "./brand";

/**
 * Every brand redefines every colour, in both schemes.
 *
 * Not tidiness. `[data-brand]` outscores the bare `:root` the dark block uses,
 * so a token a brand sets wins in dark mode and a token it omits does not —
 * which once put a dark scheme's pastel chart series onto a near-white card.
 * That was found by reading the CSS; this is the check that finds the next one.
 */

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/**
 * Declarations only. The bare `/--[a-z0-9-]+/` this started as also matched a
 * `var(--x)` reference and any token named in a comment — and the comments in
 * this stylesheet do name tokens — so a block could claim to define a colour it
 * merely mentions. Comments are stripped first, then a token counts only where
 * a value follows it.
 */
const tokensIn = (block: string): Set<string> =>
  new Set(block.replace(/\/\*[\s\S]*?\*\//g, "").match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);

const blockFor = (pattern: RegExp): string => {
  const match = css.match(pattern);
  expect(match, `no block matched ${pattern}`).not.toBeNull();
  return match![1]!;
};

/** Layout and typography are shared; only colour is a brand's business. */
const COLOURS = [...tokensIn(blockFor(/^:root \{([\s\S]*?)\n\}/m))].filter(
  (token) => !/^--(radius|gap|font|nav)/.test(token),
);

const missingFrom = (block: string): string[] => {
  const defined = tokensIn(block);
  return COLOURS.filter((token) => !defined.has(token));
};

const lightBlock = (brand: string) =>
  blockFor(new RegExp(`^:root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n\\}`, "m"));

/** Indented, because it lives inside the `prefers-color-scheme` block. */
const darkBlock = (brand: string) =>
  blockFor(new RegExp(`^  :root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n  \\}`, "m"));

const valueIn = (block: string, token: string) =>
  block.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim();

/**
 * The colour, not the text that spells it.
 *
 * Comparing the raw declarations called `#CE1F63` and `#ce1f63` two different
 * colours — so a brand could ship a delete button in exactly its accent and
 * the assertion below would agree it had not. Case and `#abc` shorthand are
 * folded; anything else asserts as written, which is the honest limit of a
 * check that reads CSS as text.
 */
const colourIn = (block: string, token: string): string => {
  const value = valueIn(block, token);
  expect(value, `${token} has no value in this block`).toBeDefined();
  return value!
    .toLowerCase()
    .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3")
    .replace(/\s+/g, " ");
};

/**
 * The tints a badge is drawn on, from `renderer.css`.
 *
 * Read rather than restated: `.r-badge[data-tone="warning"]` mixes at 18% and
 * the rest at 16%, and a copy of those numbers here would agree with the
 * stylesheet exactly until somebody changed one.
 */
const rendererCss = readFileSync(new URL("../renderer/renderer.css", import.meta.url), "utf8");

const badgeTints = (): { tone: string; percent: number }[] => {
  const found = [
    ...rendererCss.matchAll(
      /\.r-badge\[data-tone="([a-z]+)"\][^{]*\{[^}]*color-mix\(in srgb, var\(--tone-\1\) (\d+)%/g,
    ),
  ].map((match) => ({ tone: match[1]!, percent: Number(match[2]) }));

  // Guards the guard: a renamed class or a rewritten mix would otherwise leave
  // this suite asserting contrast for an empty list of badges.
  expect(found.length, "no badge tints found in renderer.css").toBeGreaterThanOrEqual(4);
  return found;
};

const rgb = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.replace(/(.)/g, "$1$1") : value;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
};

/** WCAG 2.1 relative luminance. */
const luminance = (hex: string): number => {
  const channel = (raw: number): number => {
    const scaled = raw / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};

/**
 * `color-mix(in srgb, TONE p%, transparent)` over the surface behind it.
 *
 * Mixing with `transparent` yields the tone at `p` alpha rather than a lighter
 * tone, so what a reader actually sees is that composited onto the card. Doing
 * this arithmetic is the only way to check the colour a badge really is —
 * neither operand appears in the stylesheet as a value anybody could assert on.
 */
const over = (tone: string, percent: number, ground: string): string => {
  const [tr, tg, tb] = rgb(tone);
  const [gr, gg, gb] = rgb(ground);
  const alpha = percent / 100;
  const blend = (top: number, bottom: number): string =>
    Math.round(top * alpha + bottom * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${blend(tr, gr)}${blend(tg, gg)}${blend(tb, gb)}`;
};

describe("a brand's palette", () => {
  it("has colours to cover in the first place", () => {
    // Guards the guard: a regex that stopped matching would otherwise make
    // every assertion below vacuously true.
    expect(COLOURS.length).toBeGreaterThan(10);
    expect(COLOURS).toContain("--chart-1");
    expect(COLOURS).toContain("--accent");
  });

  // The default palette is subject to the same rule and was the one breaking
  // it: the dark block below `:root` inherits from the light block above it,
  // so a colour it omits keeps its daylight value rather than falling back to
  // anything sensible. This is the block a brand's dark scheme has to outscore,
  // which makes it the worst one to leave incomplete.
  it("the default redefines every colour in dark", () => {
    expect(missingFrom(blockFor(/^  :root \{([\s\S]*?)\n  \}/m))).toEqual([]);
  });

  for (const brand of BRANDS) {
    it(`${brand} redefines every colour in light`, () => {
      expect(missingFrom(lightBlock(brand))).toEqual([]);
    });

    it(`${brand} redefines every colour in dark`, () => {
      expect(missingFrom(darkBlock(brand))).toEqual([]);
    });

    // A destructive control and a primary one must not be the same colour,
    // whatever a brand does on its marketing site. Both schemes: a brand whose
    // accent and danger are distinct in daylight can still collapse them when
    // both are lifted for dark.
    for (const [scheme, block] of [
      ["light", lightBlock],
      ["dark", darkBlock],
    ] as const) {
      it(`${brand} does not reuse its accent as the danger tone in ${scheme}`, () => {
        const scoped = block(brand);
        expect(colourIn(scoped, "--accent")).not.toBe(colourIn(scoped, "--tone-danger"));
      });

    }
  }

  /**
   * A badge is its tone twice: as ink, and as the ground under the ink.
   *
   * This is the pairing nothing else checks. A tone is chosen against the card
   * it sits on, and a badge then draws it on a 16-18% wash of itself — which
   * lifts the ground toward the ink and costs contrast that was fine
   * everywhere else the tone appears. Every failure this found was exactly
   * that: legible as text, marginal as a badge.
   *
   * The **default** palette is in this list deliberately. It is the one no
   * brand block overrides and the one every deployment starts on, and two of
   * the three failures this first caught were in it — a per-brand loop would
   * have shipped them.
   */
  const PALETTES = [
    ["default", blockFor(/^:root \{([\s\S]*?)\n\}/m), blockFor(/^  :root \{([\s\S]*?)\n  \}/m)],
    ...BRANDS.map((brand) => [brand, lightBlock(brand), darkBlock(brand)] as const),
  ] as const;

  for (const [name, light, dark] of PALETTES) {
    for (const [scheme, scoped] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      it(`${name} badge ink is legible on its own tint in ${scheme}`, () => {
        const surface = colourIn(scoped, "--surface");

        // Collected rather than asserted one at a time: stopping at the first
        // failure hides the rest behind it, and these are fixed as a set.
        const failures = badgeTints().flatMap(({ tone, percent }) => {
          const ink = colourIn(scoped, `--tone-${tone}`);
          const ratio = contrast(ink, over(ink, percent, surface));
          return ratio >= 4.5 ? [] : [`${tone} ${ratio.toFixed(2)}:1 on its own ${percent}% tint`];
        });

        expect(failures, `${name} ${scheme}`).toEqual([]);
      });
    }
  }
});
