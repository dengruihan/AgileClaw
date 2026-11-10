/**
 * Spreadsheet display-value formatting without formula evaluation.
 *
 * Excel stores displayed numbers as a cached value plus a number format code.
 * This module renders the cached value through safe, bounded format codes
 * (numbers, currency, percentages, scientific notation, and date/time) using
 * pure arithmetic. It never evaluates a formula, never reads locale data, and
 * never allocates a `Date`, so the same file renders identically on every host.
 */
import { cleanText, truncate } from "./office-preview-xml.js";

/** Builtin `numFmtId` codes defined by ECMA-376; en-US display conventions. */
const BUILTIN_NUMBER_FORMATS: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Serial number of 1970-01-01 in each Excel date system. */
const EPOCH_SERIAL_1900 = 25_569;
const EPOCH_SERIAL_1904 = 24_107;

export function builtinNumberFormat(id: number): string | undefined {
  return BUILTIN_NUMBER_FORMATS[id];
}

/** Quotes/escapes make `;` and `[` literal; section splitting respects them. */
function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] ?? "";
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && (char === "\\" || char === "_" || char === "*")) {
      current += char + (code[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (!quoted && char === ";") {
      sections.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  sections.push(current);
  return sections;
}

type FormatSection = {
  code: string;
  negative: boolean;
  zero: boolean;
  /** The negative section defines its own sign, so no minus is added. */
  explicitNegative: boolean;
};

function chooseSection(code: string, value: number): FormatSection {
  const sections = splitSections(code);
  if (value < 0 && sections.length > 1) {
    return { code: sections[1] ?? "", negative: true, zero: false, explicitNegative: true };
  }
  if (value === 0 && sections.length > 2) {
    return { code: sections[2] ?? "", negative: false, zero: true, explicitNegative: false };
  }
  return {
    code: sections[0] ?? code,
    negative: value < 0,
    zero: value === 0,
    explicitNegative: false,
  };
}

/** Removes brackets, quoted literals, and escapes; used for token detection. */
function barePattern(code: string): string {
  let bare = "";
  let quoted = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] ?? "";
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (char === "\\" || char === "_" || char === "*") {
      index += 1;
      continue;
    }
    if (char === "[") {
      const end = code.indexOf("]", index + 1);
      index = end < 0 ? code.length : end;
      continue;
    }
    bare += char;
  }
  return bare;
}

function isDateTimeCode(code: string): boolean {
  const bare = barePattern(code);
  // `m` alone is ambiguous but only appears in date/time formats; the number
  // patterns used by previews never contain y/m/d/h/s letters.
  return /[ymdhs]/iu.test(bare) || /AM\/PM|A\/P/iu.test(bare);
}

type CivilDate = { year: number; month: number; day: number; weekday: number };

/** Howard Hinnant's civil-from-days algorithm, days counted from 1970-01-01. */
function civilFromDays(daysSinceEpoch: number): CivilDate {
  const z = daysSinceEpoch + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  // 1970-01-01 was a Thursday; weekday 0 = Sunday.
  const weekday = ((daysSinceEpoch % 7) + 11) % 7;
  return { year, month, day, weekday };
}

function excelSerialToDateParts(
  serial: number,
  date1904: boolean,
): { date: CivilDate; hour: number; minute: number; second: number } {
  // Excel's 1900 system pretends 1900-02-29 existed (serial 60). Serials at or
  // below 59 predate that fake day and sit one day closer to the epoch; the
  // serials real documents use (>= 61) map directly because the epoch serial
  // 25,569 already includes the fake day.
  const wholeDays = Math.floor(serial);
  const fraction = serial - wholeDays;
  const epoch = date1904 ? EPOCH_SERIAL_1904 : EPOCH_SERIAL_1900;
  const dayOffset =
    !date1904 && wholeDays > 0 && wholeDays <= 60 ? Math.min(wholeDays + 1, 60) : wholeDays;
  const date = civilFromDays(dayOffset - epoch);
  let totalSeconds = Math.round(fraction * 86_400);
  if (totalSeconds >= 86_400) {
    totalSeconds -= 86_400;
  }
  return {
    date,
    hour: Math.floor(totalSeconds / 3_600),
    minute: Math.floor((totalSeconds % 3_600) / 60),
    second: totalSeconds % 60,
  };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function formatAmPm(hour: number, token: string): string {
  const isAm = hour < 12;
  if (!isAm) {
    return "PM";
  }
  return token.length > 1 && token.toLowerCase() === "a/p" ? "A" : "AM";
}

/** Formats one serial value through a date/time format code. */
function formatDateTime(value: number, code: string, date1904: boolean): string {
  const { date, hour, minute, second } = excelSerialToDateParts(value, date1904);
  const bare = barePattern(code).toUpperCase();
  const twelveHour = bare.includes("AM/PM") || bare.includes("A/P");
  const elapsedHours = Math.floor(value * 24);
  let output = "";
  let index = 0;
  let lastTimeToken: "hour" | "minute" | "second" | undefined;
  while (index < code.length) {
    const char = code[index] ?? "";
    if (char === '"') {
      const end = code.indexOf('"', index + 1);
      output += code.slice(index + 1, end < 0 ? code.length : end);
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    if (char === "\\" || char === "_" || char === "*") {
      output += char === "\\" ? (code[index + 1] ?? "") : "";
      index += 2;
      continue;
    }
    if (char === "[") {
      const end = code.indexOf("]", index + 1);
      const inside = code.slice(index + 1, end < 0 ? code.length : end).toLowerCase();
      if (/^h+$/u.test(inside)) {
        output += pad(elapsedHours, inside.length);
      } else if (/^m+$/u.test(inside)) {
        output += pad(Math.floor(value * 1_440), inside.length);
      } else if (/^s+$/u.test(inside)) {
        output += pad(Math.floor(value * 86_400), inside.length);
      }
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    const rest = code.slice(index);
    const amPm = rest.match(/^AM\/PM|^A\/P/iu)?.[0];
    if (amPm) {
      output += formatAmPm(hour, amPm);
      index += amPm.length;
      lastTimeToken = undefined;
      continue;
    }
    const run = rest.match(/^([ymdhHsS])\1*/u)?.[0];
    if (!run) {
      output += char;
      index += 1;
      lastTimeToken = char === ":" ? lastTimeToken : undefined;
      continue;
    }
    const token = run[0]?.toLowerCase() ?? "";
    const length = run.length;
    if (token === "y") {
      output += length <= 2 ? pad(date.year % 100, 2) : pad(date.year, 4);
    } else if (token === "m") {
      const nextChar = code[index + length] ?? "";
      const isMinute = lastTimeToken === "hour" || nextChar === ":" || lastTimeToken === "minute";
      if (isMinute) {
        output += length >= 2 ? pad(minute, 2) : String(minute);
        lastTimeToken = "minute";
      } else {
        output +=
          length >= 4
            ? (MONTH_NAMES[date.month - 1] ?? "")
            : length === 3
              ? (MONTH_NAMES[date.month - 1] ?? "").slice(0, 3)
              : pad(date.month, Math.max(1, length));
      }
    } else if (token === "d") {
      output +=
        length >= 4
          ? (WEEKDAY_NAMES[date.weekday] ?? "")
          : length === 3
            ? (WEEKDAY_NAMES[date.weekday] ?? "").slice(0, 3)
            : pad(date.day, Math.max(1, length));
    } else if (token === "h") {
      const display = twelveHour ? hour % 12 || 12 : hour;
      output += length >= 2 ? pad(display, 2) : String(display);
      lastTimeToken = "hour";
    } else {
      output += length >= 2 ? pad(second, 2) : String(second);
      lastTimeToken = "second";
    }
    index += length;
  }
  return output;
}

type NumericLayout = {
  prefix: string;
  suffix: string;
  /** Mandatory (`0`) and optional (`#`/`?`) fraction placeholders, left to right. */
  fractionPlaceholders: string;
  decimals: number;
  minIntegerDigits: number;
  grouping: boolean;
  percentScale: number;
  hasPlaceholder: boolean;
  /** Scientific exponent digit count and explicit sign marker, when present. */
  exponentDigits: number;
  exponentSign: "+" | "-" | undefined;
};

/** Extracts prefix/suffix literals and placeholder shape from a numeric code. */
function numericLayout(code: string): NumericLayout {
  let prefix = "";
  let suffix = "";
  let pattern = "";
  let seenPlaceholder = false;
  let percentScale = 1;
  let exponentDigits = 0;
  let exponentSign: "+" | "-" | undefined;
  let index = 0;
  while (index < code.length) {
    const char = code[index] ?? "";
    if (char === '"') {
      const end = code.indexOf('"', index + 1);
      const literal = code.slice(index + 1, end < 0 ? code.length : end);
      if (seenPlaceholder) {
        suffix += literal;
      } else {
        prefix += literal;
      }
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    if (char === "\\") {
      const literal = code[index + 1] ?? "";
      if (seenPlaceholder) {
        suffix += literal;
      } else {
        prefix += literal;
      }
      index += 2;
      continue;
    }
    if (char === "_" || char === "*") {
      index += 2;
      continue;
    }
    if (char === "[") {
      const end = code.indexOf("]", index + 1);
      const inside = code.slice(index + 1, end < 0 ? code.length : end);
      const currency = inside.match(/^\$([^-\]]*)/u)?.[1];
      if (currency && !seenPlaceholder) {
        prefix += currency;
      }
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    if (seenPlaceholder && (char === "E" || char === "e")) {
      // Parse the exponent marker and its placeholders, then keep scanning so
      // literals after the exponent (e.g. a negative section's closing paren)
      // stay in the suffix.
      let cursor = index + 1;
      const signChar = code[cursor];
      if (signChar === "+" || signChar === "-") {
        exponentSign = signChar;
        cursor += 1;
      }
      while (/[0#?]/u.test(code[cursor] ?? "")) {
        exponentDigits += 1;
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    if (/[0#?]/u.test(char)) {
      seenPlaceholder = true;
      pattern += char;
      index += 1;
      continue;
    }
    if (seenPlaceholder) {
      if (char === "." || char === ",") {
        pattern += char;
      } else if (char === "%") {
        suffix += char;
        percentScale *= 100;
      } else {
        suffix += char;
      }
    } else if (char === "%") {
      prefix += char;
      percentScale *= 100;
    } else {
      prefix += char;
    }
    index += 1;
  }
  const dot = pattern.indexOf(".");
  const integerPattern = dot < 0 ? pattern : pattern.slice(0, dot);
  const fractionPattern = dot < 0 ? "" : pattern.slice(dot + 1);
  return {
    prefix,
    suffix,
    fractionPlaceholders: [...fractionPattern].filter((char) => /[0#?]/u.test(char)).join(""),
    decimals: [...fractionPattern].filter((char) => /[0#?]/u.test(char)).length,
    minIntegerDigits: [...integerPattern].filter((char) => char === "0").length,
    grouping: integerPattern.includes(","),
    percentScale,
    hasPlaceholder: pattern.length > 0,
    exponentDigits: Math.max(1, exponentDigits),
    exponentSign,
  };
}

/**
 * Renders fractional digits through Excel's optional placeholders: a `#`/`?`
 * digit shows when it is non-zero or a later shown digit is non-zero; `0`
 * always shows. The caller supplies digits already padded to the placeholder
 * count.
 */
function renderOptionalFraction(rawFraction: string, placeholders: string): string {
  const digits = rawFraction.padEnd(placeholders.length, "0");
  const shown = Array.from({ length: placeholders.length }, () => false);
  let laterNonZero = false;
  for (let index = placeholders.length - 1; index >= 0; index -= 1) {
    const digit = digits[index] ?? "0";
    if (placeholders[index] === "0") {
      shown[index] = true;
      laterNonZero ||= digit !== "0";
    } else {
      shown[index] = digit !== "0" || laterNonZero;
      laterNonZero ||= digit !== "0";
    }
  }
  return digits
    .split("")
    .filter((_digit, index) => shown[index])
    .join("");
}

function groupInteger(value: string): string {
  let grouped = "";
  for (let index = 0; index < value.length; index += 1) {
    const remaining = value.length - index;
    grouped += value[index];
    if (remaining > 1 && (remaining - 1) % 3 === 0) {
      grouped += ",";
    }
  }
  return grouped;
}

function formatNumeric(value: number, section: FormatSection): string {
  if (section.code === "General" || section.code === "@") {
    return formatGeneral(value);
  }
  const layout = numericLayout(section.code);
  if (!layout.hasPlaceholder) {
    // An all-literal section (e.g. `"n/a"`) never renders the cached value.
    return truncate(cleanText(`${layout.prefix}${layout.suffix}`), 4_096);
  }
  const scaled = Math.abs(value) * layout.percentScale;
  if (!Number.isFinite(scaled)) {
    return "";
  }
  const fixed = scaled.toFixed(Math.min(10, layout.decimals));
  const [integerPart = "0", rawFraction = ""] = fixed.split(".");
  const fractionPart = renderOptionalFraction(rawFraction, layout.fractionPlaceholders);
  const paddedInteger = integerPart.padStart(layout.minIntegerDigits, "0");
  const grouped = layout.grouping ? groupInteger(paddedInteger) : paddedInteger;
  const number = fractionPart ? `${grouped}.${fractionPart}` : grouped;
  // A negative section defines its own sign/parentheses; the fallback section
  // needs the minus sign Excel would otherwise add.
  const sign = section.negative && !section.explicitNegative ? "-" : "";
  return truncate(cleanText(`${sign}${layout.prefix}${number}${layout.suffix}`), 4_096);
}

function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  // 15 significant digits matches Excel's General display and hides binary
  // floating-point noise such as 0.30000000000000004.
  const rounded = Number(value.toPrecision(15));
  return String(rounded).replace("e", "E");
}

function formatScientific(value: number, section: FormatSection): string {
  const layout = numericLayout(section.code);
  const exponential = Math.abs(value).toExponential(Math.min(10, layout.decimals));
  const [rawMantissa = "0", rawExponent = "0"] = exponential.split("e");
  const [mantissaInteger = "0", rawFraction = ""] = rawMantissa.split(".");
  const fraction = renderOptionalFraction(rawFraction, layout.fractionPlaceholders);
  const mantissa = fraction ? `${mantissaInteger}.${fraction}` : mantissaInteger;
  const exponentValue = Number.parseInt(rawExponent, 10);
  const exponentText = Number.isFinite(exponentValue)
    ? `${exponentValue < 0 ? "-" : layout.exponentSign === "+" ? "+" : layout.exponentSign === "-" ? "" : "+"}${pad(Math.abs(exponentValue), layout.exponentDigits)}`
    : rawExponent;
  // The selected section owns the sign: a negative section may use parentheses.
  const sign = section.negative && !section.explicitNegative ? "-" : "";
  return truncate(
    cleanText(`${sign}${layout.prefix}${mantissa}E${exponentText}${layout.suffix}`),
    4_096,
  );
}

/**
 * Renders one cached spreadsheet value for display.
 *
 * Strings, booleans, and error values keep their stored text; numeric values
 * go through the sheet's format code. Formula cells only use their cached
 * `<v>` value: formulas are never evaluated.
 */
export function formatSpreadsheetCellValue(params: {
  raw: string;
  type: string | undefined;
  formatCode: string | undefined;
  date1904: boolean;
}): string {
  const raw = params.raw.trim();
  if (!raw) {
    return "";
  }
  if (params.type === "b") {
    return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : cleanText(raw);
  }
  if (params.type === "str" || params.type === "inlineStr" || params.type === "e") {
    return cleanText(raw);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return cleanText(raw);
  }
  const code = params.formatCode?.trim() || "General";
  if (code === "@") {
    return cleanText(raw);
  }
  const section = chooseSection(code, value);
  if (isDateTimeCode(section.code)) {
    return truncate(cleanText(formatDateTime(value, section.code, params.date1904)), 4_096);
  }
  if (/[eE][+-]?[0#?]/u.test(barePattern(section.code))) {
    return formatScientific(value, section);
  }
  if (section.code.trim() === "General" || section.code.trim() === "") {
    return formatGeneral(value);
  }
  return formatNumeric(value, section);
}

/** Bounded display copy of a number-format code for accessibility facts. */
export function sanitizeNumberFormatCode(code: string | undefined): string | undefined {
  const sanitized = cleanText(code ?? "").trim();
  return sanitized ? truncate(sanitized, 128) : undefined;
}
