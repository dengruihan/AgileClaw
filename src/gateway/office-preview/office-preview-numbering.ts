import { OFFICE_PREVIEW_MAX_DOCX_LIST_LEVELS } from "./office-preview-limits.js";
import {
  childNamed,
  childrenNamed,
  elements,
  tryParseXml,
  valAttribute,
  wordAttribute,
  type XmlElement,
} from "./office-preview-xml.js";
/**
 * DOCX list numbering (`word/numbering.xml`).
 *
 * Word stores the list label as a format plus a level template (`%1.`), not as
 * display text. This module keeps bounded per-numbering counters and renders the
 * label the document would show for each numbered paragraph, so the preview can
 * keep ordered/bulleted list structure instead of flattening it to plain text.
 */
import type { OfficeZipArchive } from "./office-preview-zip.js";

type LevelDefinition = {
  numFmt?: string;
  lvlText?: string;
  start: number;
};

type NumberDefinition = {
  abstractId?: string;
  overrides: Map<number, Partial<LevelDefinition>>;
};

export type DocxNumbering = {
  /** Next marker for one numbered paragraph; undefined when the level is unnumbered. */
  nextMarker: (numId: number, ilvl: number) => string | undefined;
};

const EMPTY_NUMBERING: DocxNumbering = { nextMarker: () => undefined };
const MAX_NUMBER_IDS = 200;
const MAX_ABSTRACT_NUMBERS = 100;

/** Lowercase roman numerals; clamped to the practical table range. */
function romanNumeral(value: number): string {
  if (value <= 0 || value > 3_999) {
    return String(value);
  }
  const table: readonly [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let remaining = value;
  let output = "";
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      output += symbol;
      remaining -= amount;
    }
  }
  return output;
}

function letterNumeral(value: number, uppercase: boolean): string {
  if (value <= 0) {
    return String(value);
  }
  let remaining = value;
  let output = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    output = String.fromCharCode(97 + digit) + output;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return uppercase ? output.toUpperCase() : output;
}

function formatNumber(value: number, numFmt: string | undefined): string {
  switch ((numFmt ?? "decimal").toLowerCase()) {
    case "lowerletter":
      return letterNumeral(value, false);
    case "upperletter":
      return letterNumeral(value, true);
    case "lowerroman":
      return romanNumeral(value);
    case "upperroman":
      return romanNumeral(value).toUpperCase();
    case "decimalzero":
      return String(value).padStart(2, "0");
    default:
      return String(value);
  }
}

/** Symbol/Wingdings bullet glyphs live in the private-use area; render a round bullet. */
function bulletGlyph(lvlText: string | undefined): string {
  const glyph = (lvlText ?? "").trim();
  if (!glyph) {
    return "•";
  }
  const code = glyph.codePointAt(0) ?? 0;
  if (code >= 0xf000 && code <= 0xf0ff) {
    return "•";
  }
  return glyph.slice(0, 4);
}

function readLevel(level: XmlElement): LevelDefinition {
  const start = Number.parseInt(valAttribute(childNamed(level, "start")) ?? "", 10);
  return {
    numFmt: valAttribute(childNamed(level, "numFmt"))?.toLowerCase(),
    lvlText: valAttribute(childNamed(level, "lvlText")),
    start: Number.isSafeInteger(start) && start >= 0 ? start : 1,
  };
}

/** Reads list numbering; a missing part leaves every paragraph unnumbered. */
export function readDocxNumbering(archive: OfficeZipArchive): DocxNumbering {
  const xml = archive.readText("word/numbering.xml");
  const doc = xml ? tryParseXml(xml) : undefined;
  if (!doc) {
    return EMPTY_NUMBERING;
  }
  const abstracts = new Map<string, Map<number, LevelDefinition>>();
  for (const abstractNode of elements(doc, "w:abstractNum")) {
    const id = wordAttribute(abstractNode, "abstractNumId");
    if (!id) {
      continue;
    }
    const levels = new Map<number, LevelDefinition>();
    for (const level of childrenNamed(abstractNode, "lvl")) {
      const ilvl = Number.parseInt(wordAttribute(level, "ilvl") ?? "", 10);
      if (Number.isSafeInteger(ilvl) && ilvl >= 0 && ilvl < OFFICE_PREVIEW_MAX_DOCX_LIST_LEVELS) {
        levels.set(ilvl, readLevel(level));
      }
    }
    abstracts.set(id, levels);
    if (abstracts.size >= MAX_ABSTRACT_NUMBERS) {
      break;
    }
  }
  const definitions = new Map<number, NumberDefinition>();
  for (const numNode of elements(doc, "w:num")) {
    const numId = Number.parseInt(wordAttribute(numNode, "numId") ?? "", 10);
    if (!Number.isSafeInteger(numId) || numId <= 0) {
      continue;
    }
    const overrides = new Map<number, Partial<LevelDefinition>>();
    for (const override of childrenNamed(numNode, "lvlOverride")) {
      const ilvl = Number.parseInt(wordAttribute(override, "ilvl") ?? "", 10);
      if (!Number.isSafeInteger(ilvl) || ilvl < 0) {
        continue;
      }
      const startOverride = Number.parseInt(
        valAttribute(childNamed(override, "startOverride")) ?? "",
        10,
      );
      const lvl = childNamed(override, "lvl");
      const level = lvl ? readLevel(lvl) : undefined;
      overrides.set(ilvl, {
        ...(Number.isSafeInteger(startOverride) ? { start: startOverride } : {}),
        ...(level?.numFmt ? { numFmt: level.numFmt } : {}),
        ...(level?.lvlText ? { lvlText: level.lvlText } : {}),
      });
    }
    definitions.set(numId, {
      abstractId: valAttribute(childNamed(numNode, "abstractNumId")),
      overrides,
    });
    if (definitions.size >= MAX_NUMBER_IDS) {
      break;
    }
  }
  if (definitions.size === 0) {
    return EMPTY_NUMBERING;
  }
  const counters = new Map<number, number[]>();

  return {
    nextMarker: (numId, ilvl) => {
      const definition = definitions.get(numId);
      const abstract = definition?.abstractId ? abstracts.get(definition.abstractId) : undefined;
      if (!definition || !abstract) {
        return undefined;
      }
      const baseLevel = abstract.get(ilvl);
      if (!baseLevel) {
        return undefined;
      }
      const override = definition.overrides.get(ilvl);
      const level: LevelDefinition = {
        numFmt: override?.numFmt ?? baseLevel.numFmt,
        lvlText: override?.lvlText ?? baseLevel.lvlText,
        start: override?.start ?? baseLevel.start,
      };
      if (level.numFmt === "none") {
        return undefined;
      }
      const used = counters.get(numId) ?? [];
      const start = level.start > 0 ? level.start : 1;
      used[ilvl] = used[ilvl] === undefined || used[ilvl] === 0 ? start : used[ilvl] + 1;
      for (let deeper = ilvl + 1; deeper < OFFICE_PREVIEW_MAX_DOCX_LIST_LEVELS; deeper += 1) {
        used[deeper] = 0;
      }
      counters.set(numId, used);
      if (level.numFmt === "bullet") {
        return bulletGlyph(level.lvlText);
      }
      const template = level.lvlText ?? `%${ilvl + 1}.`;
      const marker = template.replace(/%([1-9])/gu, (_match, digit: string) => {
        const referenced = Number.parseInt(digit, 10) - 1;
        const referencedLevel = abstract.get(referenced);
        const value = used[referenced] ?? 0;
        if (referenced === ilvl) {
          return formatNumber(value, level.numFmt);
        }
        return formatNumber(value, referencedLevel?.numFmt);
      });
      return marker.trim().slice(0, 32);
    },
  };
}
