// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

/**
 * Personal website-password vault protocol.
 *
 * These payloads carry metadata and, only for reveal/copy, decrypted values.
 * The vault worker owns encryption and the data key; no agent tool registers
 * these methods.
 */

const VaultItemRefSchema = Type.String({ minLength: 1, maxLength: 128 });
const VaultRevisionSchema = Type.Integer({ minimum: 1 });
const VaultSchemeSchema = Type.Union([Type.Literal("https"), Type.Literal("http")]);
const VaultHostSchema = Type.String({ minLength: 1, maxLength: 253 });
const VaultPortSchema = Type.Integer({ minimum: 1, maximum: 65535 });
const VaultSiteLabelSchema = Type.String({ minLength: 1, maxLength: 256 });
const VaultAccountSchema = Type.String({ minLength: 1, maxLength: 512 });
const VaultLabelSchema = Type.String({ maxLength: 256 });
const VaultPasswordSchema = Type.String({ minLength: 1, maxLength: 4096 });
const VaultNotesSchema = Type.String({ maxLength: 64 * 1024 });
const VaultPassphraseSchema = Type.String({ minLength: 8, maxLength: 1024 });
const VaultAutoLockSecondsSchema = Type.Integer({ minimum: 15, maximum: 86_400 });

export const VaultEntryMetadataSchema = closedObject({
  itemRef: VaultItemRefSchema,
  originScheme: VaultSchemeSchema,
  originHost: VaultHostSchema,
  originPort: VaultPortSchema,
  siteLabel: VaultSiteLabelSchema,
  account: VaultAccountSchema,
  label: Type.Optional(VaultLabelSchema),
  hasNotes: Type.Boolean(),
  revision: VaultRevisionSchema,
  passwordUpdatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  lastUsedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  createdAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  deletedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type VaultEntryMetadataPayload = Static<typeof VaultEntryMetadataSchema>;

export const VaultStatusResultSchema = closedObject({
  initialized: Type.Boolean(),
  state: Type.Union([
    Type.Literal("uninitialized"),
    Type.Literal("locked"),
    Type.Literal("unlocked"),
    Type.Literal("corrupted"),
  ]),
  autoLockSeconds: VaultAutoLockSecondsSchema,
  failedAttempts: Type.Integer({ minimum: 0 }),
  lockedUntilMs: Type.Optional(Type.Integer({ minimum: 0 })),
  itemCount: Type.Integer({ minimum: 0 }),
  deletedCount: Type.Integer({ minimum: 0 }),
});
export type VaultStatusPayload = Static<typeof VaultStatusResultSchema>;

export const VaultStatusParamsSchema = closedObject({});

export const VaultInitializeParamsSchema = closedObject({
  passphrase: VaultPassphraseSchema,
  autoLockSeconds: Type.Optional(VaultAutoLockSecondsSchema),
});

export const VaultUnlockParamsSchema = closedObject({
  passphrase: VaultPassphraseSchema,
});

export const VaultLockParamsSchema = closedObject({});

export const VaultListParamsSchema = closedObject({
  includeDeleted: Type.Optional(Type.Boolean()),
});

export const VaultListResultSchema = closedObject({
  entries: Type.Array(VaultEntryMetadataSchema),
});

const VaultEntryFieldsSchema = {
  originScheme: VaultSchemeSchema,
  originHost: VaultHostSchema,
  originPort: VaultPortSchema,
  siteLabel: VaultSiteLabelSchema,
  account: VaultAccountSchema,
  label: Type.Optional(VaultLabelSchema),
} as const;

export const VaultCreateParamsSchema = closedObject({
  ...VaultEntryFieldsSchema,
  password: VaultPasswordSchema,
  notes: Type.Optional(VaultNotesSchema),
});

export const VaultUpdateParamsSchema = closedObject({
  itemRef: VaultItemRefSchema,
  revision: VaultRevisionSchema,
  ...VaultEntryFieldsSchema,
  password: Type.Optional(VaultPasswordSchema),
  notes: Type.Optional(VaultNotesSchema),
});

export const VaultDeleteParamsSchema = closedObject({
  itemRef: VaultItemRefSchema,
  revision: VaultRevisionSchema,
});

export const VaultRestoreParamsSchema = closedObject({
  itemRef: VaultItemRefSchema,
});

export const VaultPurgeParamsSchema = closedObject({
  itemRef: VaultItemRefSchema,
});

export const VaultEntryMutationResultSchema = closedObject({
  entry: VaultEntryMetadataSchema,
});

export const VaultMutationResultSchema = closedObject({ ok: Type.Literal(true) });

export const VaultRevealParamsSchema = closedObject({
  itemRef: VaultItemRefSchema,
});

export const VaultRevealResultSchema = closedObject({
  entry: VaultEntryMetadataSchema,
  password: VaultPasswordSchema,
  notes: VaultNotesSchema,
});

export const VaultGenerateParamsSchema = closedObject({
  length: Type.Optional(Type.Integer({ minimum: 12, maximum: 128 })),
  includeSymbols: Type.Optional(Type.Boolean()),
});

export const VaultGenerateResultSchema = closedObject({
  password: VaultPasswordSchema,
});

export const VaultSetAutoLockParamsSchema = closedObject({
  autoLockSeconds: VaultAutoLockSecondsSchema,
});

const VaultAuditActionSchema = Type.Union([
  Type.Literal("initialize"),
  Type.Literal("unlock"),
  Type.Literal("unlock-failed"),
  Type.Literal("lock"),
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("delete"),
  Type.Literal("restore"),
  Type.Literal("purge"),
  Type.Literal("reveal"),
  Type.Literal("copy"),
  Type.Literal("generate"),
  Type.Literal("purge-expired"),
]);

export const VaultAuditEventSchema = closedObject({
  sequence: Type.Integer({ minimum: 1 }),
  action: VaultAuditActionSchema,
  status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("blocked")]),
  itemRef: Type.Optional(VaultItemRefSchema),
  reasonCode: Type.Optional(Type.String({ maxLength: 64 })),
  occurredAtMs: Type.Integer({ minimum: 0 }),
});

export const VaultAuditListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  before: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const VaultAuditListResultSchema = closedObject({
  events: Type.Array(VaultAuditEventSchema),
});

export type VaultEntryMetadata = Static<typeof VaultEntryMetadataSchema>;
export type VaultStatus = Static<typeof VaultStatusResultSchema>;
export type VaultAuditEvent = Static<typeof VaultAuditEventSchema>;
export type VaultCreateParams = Static<typeof VaultCreateParamsSchema>;
export type VaultUpdateParams = Static<typeof VaultUpdateParamsSchema>;
export type VaultRevealResult = Static<typeof VaultRevealResultSchema>;
export type VaultAuditListResult = Static<typeof VaultAuditListResultSchema>;
