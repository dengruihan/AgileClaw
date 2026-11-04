import {
  VAULT_ACCOUNT_MAX_LENGTH,
  VAULT_DEFAULT_AUTO_LOCK_SECONDS,
  VAULT_LABEL_MAX_LENGTH,
  VAULT_MAX_AUTO_LOCK_SECONDS,
  VAULT_MIN_AUTO_LOCK_SECONDS,
  VAULT_NOTES_MAX_BYTES,
  VAULT_PASSPHRASE_MAX_LENGTH,
  VAULT_PASSPHRASE_MIN_LENGTH,
  VAULT_PASSWORD_MAX_BYTES,
  VAULT_SITE_LABEL_MAX_LENGTH,
  VaultError,
  type VaultEntryCreateInput,
  type VaultEntryUpdateInput,
} from "./vault-types.js";

export function validatePassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string") {
    throw new VaultError("VAULT_INVALID_INPUT", "Enter the master passphrase.");
  }
  const bytes = Buffer.byteLength(passphrase, "utf8");
  if (passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH || bytes > VAULT_PASSPHRASE_MAX_LENGTH) {
    throw new VaultError(
      "VAULT_INVALID_INPUT",
      `The master passphrase must be ${VAULT_PASSPHRASE_MIN_LENGTH} to ${VAULT_PASSPHRASE_MAX_LENGTH} bytes.`,
    );
  }
  return passphrase;
}

export function normalizeAutoLockSeconds(value: unknown): number {
  if (value === undefined) {
    return VAULT_DEFAULT_AUTO_LOCK_SECONDS;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < VAULT_MIN_AUTO_LOCK_SECONDS ||
    value > VAULT_MAX_AUTO_LOCK_SECONDS
  ) {
    throw new VaultError(
      "VAULT_INVALID_INPUT",
      `Auto-lock must be between ${VAULT_MIN_AUTO_LOCK_SECONDS} and ${VAULT_MAX_AUTO_LOCK_SECONDS} seconds.`,
    );
  }
  return value;
}

function normalizeText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { required: boolean },
): string {
  if (value === undefined && !options.required) {
    return "";
  }
  if (typeof value !== "string") {
    throw new VaultError("VAULT_INVALID_INPUT", `${field} is required.`);
  }
  const trimmed = value.trim();
  if (options.required && trimmed.length === 0) {
    throw new VaultError("VAULT_INVALID_INPUT", `${field} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new VaultError("VAULT_INVALID_INPUT", `${field} is too long.`);
  }
  return trimmed;
}

function normalizePassword(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VaultError("VAULT_INVALID_INPUT", "Password is required.");
  }
  if (Buffer.byteLength(value, "utf8") > VAULT_PASSWORD_MAX_BYTES) {
    throw new VaultError("VAULT_INVALID_INPUT", "Password is too long.");
  }
  return value;
}

function normalizeNotes(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new VaultError("VAULT_INVALID_INPUT", "Notes must be text.");
  }
  if (Buffer.byteLength(value, "utf8") > VAULT_NOTES_MAX_BYTES) {
    throw new VaultError("VAULT_INVALID_INPUT", "Notes are too long.");
  }
  return value;
}

export function normalizeOrigin(input: {
  originScheme: unknown;
  originHost: unknown;
  originPort: unknown;
}): { scheme: "https" | "http"; host: string; port: number } {
  const scheme = input.originScheme;
  if (scheme !== "https" && scheme !== "http") {
    throw new VaultError("VAULT_INVALID_INPUT", "Origin scheme must be https or http.");
  }
  if (typeof input.originHost !== "string" || input.originHost.trim().length === 0) {
    throw new VaultError("VAULT_INVALID_INPUT", "Website host is required.");
  }
  const originPort = input.originPort;
  if (
    typeof originPort !== "number" ||
    !Number.isSafeInteger(originPort) ||
    originPort < 1 ||
    originPort > 65535
  ) {
    throw new VaultError("VAULT_INVALID_INPUT", "Website port is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${input.originHost.trim()}:${String(originPort)}`);
  } catch {
    throw new VaultError("VAULT_INVALID_INPUT", "Website host is invalid.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new VaultError(
      "VAULT_INVALID_INPUT",
      "Enter only the website host, not a path or query.",
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || host.length > 253) {
    throw new VaultError("VAULT_INVALID_INPUT", "Website host is invalid.");
  }
  return { scheme, host, port: originPort };
}

export function normalizeCreateInput(input: VaultEntryCreateInput) {
  const origin = normalizeOrigin(input);
  return {
    ...origin,
    siteLabel: normalizeText(input.siteLabel, "Site label", VAULT_SITE_LABEL_MAX_LENGTH, {
      required: true,
    }),
    account: normalizeText(input.account, "Account", VAULT_ACCOUNT_MAX_LENGTH, {
      required: true,
    }),
    label: normalizeText(input.label, "Label", VAULT_LABEL_MAX_LENGTH, { required: false }),
    password: normalizePassword(input.password),
    notes: normalizeNotes(input.notes),
  };
}

export function normalizeUpdateInput(input: VaultEntryUpdateInput) {
  const origin = normalizeOrigin(input);
  if (typeof input.itemRef !== "string" || input.itemRef.length === 0) {
    throw new VaultError("VAULT_INVALID_INPUT", "Entry reference is required.");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new VaultError("VAULT_INVALID_INPUT", "Entry revision is invalid.");
  }
  return {
    itemRef: input.itemRef,
    revision: input.revision,
    ...origin,
    siteLabel: normalizeText(input.siteLabel, "Site label", VAULT_SITE_LABEL_MAX_LENGTH, {
      required: true,
    }),
    account: normalizeText(input.account, "Account", VAULT_ACCOUNT_MAX_LENGTH, {
      required: true,
    }),
    label: normalizeText(input.label, "Label", VAULT_LABEL_MAX_LENGTH, { required: false }),
    password: input.password === undefined ? undefined : normalizePassword(input.password),
    notes: input.notes === undefined ? undefined : normalizeNotes(input.notes),
  };
}
