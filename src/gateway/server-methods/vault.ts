import {
  ErrorCodes,
  errorShape,
  validateVaultAuditListParams,
  validateVaultAuditListResult,
  validateVaultCreateParams,
  validateVaultDeleteParams,
  validateVaultEntryMutationResult,
  validateVaultGenerateParams,
  validateVaultGenerateResult,
  validateVaultInitializeParams,
  validateVaultListParams,
  validateVaultListResult,
  validateVaultLockParams,
  validateVaultMutationResult,
  validateVaultPurgeParams,
  validateVaultRestoreParams,
  validateVaultRevealParams,
  validateVaultRevealResult,
  validateVaultSetAutoLockParams,
  validateVaultStatusParams,
  validateVaultStatusResult,
  validateVaultUnlockParams,
  validateVaultUpdateParams,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { getVaultService, type VaultService } from "../../vault/vault-service.js";
import { VaultError } from "../../vault/vault-types.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const VAULT_REVEAL_SCOPE = "operator.vault.reveal";

type VaultLogger = {
  warn?: (message: string) => void;
};

function hasScope(client: GatewayClient | null, scope: string): boolean {
  const scopes = client?.connect?.scopes;
  return Array.isArray(scopes) && scopes.includes(scope);
}

/**
 * `operator.admin` satisfies ordinary operator scopes, but the vault deliberately
 * does not let it reveal stored passwords. Reveal, copy, and unlock require the
 * explicit reveal scope on this exact connection.
 */
function requireExplicitRevealScope(client: GatewayClient | null, respond: RespondFn): boolean {
  if (hasScope(client, VAULT_REVEAL_SCOPE)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "The password vault reveal scope is required.", {
      details: { code: "VAULT_REVEAL_SCOPE_REQUIRED", requiredScope: VAULT_REVEAL_SCOPE },
    }),
  );
  return false;
}

function vaultErrorShape(error: unknown): ErrorShape {
  if (error instanceof VaultError) {
    const details = { code: error.code, ...error.details };
    switch (error.code) {
      case "VAULT_WRONG_PASSPHRASE":
      case "VAULT_LOCKED":
      case "VAULT_LOCKED_OUT":
      case "VAULT_NOT_FOUND":
      case "VAULT_DELETED":
      case "VAULT_CONFLICT":
      case "VAULT_DUPLICATE":
      case "VAULT_INVALID_INPUT":
      case "VAULT_ALREADY_INITIALIZED":
        return errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details });
      default:
        return errorShape(ErrorCodes.UNAVAILABLE, error.message, { details });
    }
  }
  return errorShape(ErrorCodes.UNAVAILABLE, "The password vault operation failed.");
}

function logFailure(log: VaultLogger | undefined, method: string, error: unknown): void {
  if (error instanceof VaultError) {
    log?.warn?.(`${method} failed: ${error.code}`);
    return;
  }
  log?.warn?.(`${method} failed: ${errorMessage(error)}`);
}

function validateResult<T>(
  value: unknown,
  validate: (candidate: unknown) => candidate is T,
  method: string,
): T {
  if (!validate(value)) {
    throw new VaultError("VAULT_UNAVAILABLE", `${method} returned an invalid payload.`);
  }
  return value;
}

export function createVaultHandlers(
  params: {
    service?: VaultService;
    log?: VaultLogger;
  } = {},
): GatewayRequestHandlers {
  const service = params.service ?? getVaultService();

  return {
    "vault.status": defineValidatedGatewayHandler(
      "vault.status",
      validateVaultStatusParams,
      async (options) => {
        const { respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const status = await service.status();
          assertCurrent();
          respond(true, validateResult(status, validateVaultStatusResult, "vault.status"));
        } catch (error) {
          logFailure(params.log, "vault.status", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.initialize": defineValidatedGatewayHandler(
      "vault.initialize",
      validateVaultInitializeParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const status = await service.initialize(
            requestParams.passphrase,
            requestParams.autoLockSeconds,
          );
          assertCurrent();
          respond(true, validateResult(status, validateVaultStatusResult, "vault.initialize"));
        } catch (error) {
          logFailure(params.log, "vault.initialize", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.unlock": defineValidatedGatewayHandler(
      "vault.unlock",
      validateVaultUnlockParams,
      async (options) => {
        const { params: requestParams, respond, client } = options;
        if (!requireExplicitRevealScope(client ?? null, respond)) {
          return;
        }
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const status = await service.unlock(requestParams.passphrase);
          assertCurrent();
          respond(true, validateResult(status, validateVaultStatusResult, "vault.unlock"));
        } catch (error) {
          logFailure(params.log, "vault.unlock", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.lock": defineValidatedGatewayHandler(
      "vault.lock",
      validateVaultLockParams,
      async (options) => {
        const { respond } = options;
        try {
          await service.lock();
          respond(true, validateResult({ ok: true }, validateVaultMutationResult, "vault.lock"));
        } catch (error) {
          logFailure(params.log, "vault.lock", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.list": defineValidatedGatewayHandler(
      "vault.list",
      validateVaultListParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const entries = await service.list(requestParams.includeDeleted === true);
          assertCurrent();
          respond(true, validateResult({ entries }, validateVaultListResult, "vault.list"));
        } catch (error) {
          logFailure(params.log, "vault.list", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.create": defineValidatedGatewayHandler(
      "vault.create",
      validateVaultCreateParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const entry = await service.create({
            originScheme: requestParams.originScheme,
            originHost: requestParams.originHost,
            originPort: requestParams.originPort,
            siteLabel: requestParams.siteLabel,
            account: requestParams.account,
            ...(requestParams.label !== undefined ? { label: requestParams.label } : {}),
            password: requestParams.password,
            ...(requestParams.notes !== undefined ? { notes: requestParams.notes } : {}),
          });
          assertCurrent();
          respond(
            true,
            validateResult({ entry }, validateVaultEntryMutationResult, "vault.create"),
          );
        } catch (error) {
          logFailure(params.log, "vault.create", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.update": defineValidatedGatewayHandler(
      "vault.update",
      validateVaultUpdateParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const entry = await service.update({
            itemRef: requestParams.itemRef,
            revision: requestParams.revision,
            originScheme: requestParams.originScheme,
            originHost: requestParams.originHost,
            originPort: requestParams.originPort,
            siteLabel: requestParams.siteLabel,
            account: requestParams.account,
            ...(requestParams.label !== undefined ? { label: requestParams.label } : {}),
            ...(requestParams.password !== undefined ? { password: requestParams.password } : {}),
            ...(requestParams.notes !== undefined ? { notes: requestParams.notes } : {}),
          });
          assertCurrent();
          respond(
            true,
            validateResult({ entry }, validateVaultEntryMutationResult, "vault.update"),
          );
        } catch (error) {
          logFailure(params.log, "vault.update", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.delete": defineValidatedGatewayHandler(
      "vault.delete",
      validateVaultDeleteParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          await service.delete(requestParams.itemRef, requestParams.revision);
          assertCurrent();
          respond(true, validateResult({ ok: true }, validateVaultMutationResult, "vault.delete"));
        } catch (error) {
          logFailure(params.log, "vault.delete", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.restore": defineValidatedGatewayHandler(
      "vault.restore",
      validateVaultRestoreParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          await service.restore(requestParams.itemRef);
          assertCurrent();
          respond(true, validateResult({ ok: true }, validateVaultMutationResult, "vault.restore"));
        } catch (error) {
          logFailure(params.log, "vault.restore", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.purge": defineValidatedGatewayHandler(
      "vault.purge",
      validateVaultPurgeParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          await service.purge(requestParams.itemRef);
          assertCurrent();
          respond(true, validateResult({ ok: true }, validateVaultMutationResult, "vault.purge"));
        } catch (error) {
          logFailure(params.log, "vault.purge", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.reveal": defineValidatedGatewayHandler(
      "vault.reveal",
      validateVaultRevealParams,
      async (options) => {
        const { params: requestParams, respond, client } = options;
        if (!requireExplicitRevealScope(client ?? null, respond)) {
          return;
        }
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const result = await service.reveal(requestParams.itemRef, "reveal");
          assertCurrent();
          respond(true, validateResult(result, validateVaultRevealResult, "vault.reveal"));
        } catch (error) {
          logFailure(params.log, "vault.reveal", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.copy": defineValidatedGatewayHandler(
      "vault.copy",
      validateVaultRevealParams,
      async (options) => {
        const { params: requestParams, respond, client } = options;
        if (!requireExplicitRevealScope(client ?? null, respond)) {
          return;
        }
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const result = await service.reveal(requestParams.itemRef, "copy");
          assertCurrent();
          respond(true, validateResult(result, validateVaultRevealResult, "vault.copy"));
        } catch (error) {
          logFailure(params.log, "vault.copy", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.generate": defineValidatedGatewayHandler(
      "vault.generate",
      validateVaultGenerateParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        try {
          const password = await service.generate(
            requestParams.length,
            requestParams.includeSymbols,
          );
          respond(
            true,
            validateResult({ password }, validateVaultGenerateResult, "vault.generate"),
          );
        } catch (error) {
          logFailure(params.log, "vault.generate", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.setAutoLock": defineValidatedGatewayHandler(
      "vault.setAutoLock",
      validateVaultSetAutoLockParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const status = await service.setAutoLock(requestParams.autoLockSeconds);
          assertCurrent();
          respond(true, validateResult(status, validateVaultStatusResult, "vault.setAutoLock"));
        } catch (error) {
          logFailure(params.log, "vault.setAutoLock", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
    "vault.audit.list": defineValidatedGatewayHandler(
      "vault.audit.list",
      validateVaultAuditListParams,
      async (options) => {
        const { params: requestParams, respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          assertCurrent();
          const events = await service.auditList(requestParams.limit ?? 50, requestParams.before);
          assertCurrent();
          respond(
            true,
            validateResult({ events }, validateVaultAuditListResult, "vault.audit.list"),
          );
        } catch (error) {
          logFailure(params.log, "vault.audit.list", error);
          respond(false, undefined, vaultErrorShape(error));
        }
      },
    ),
  };
}
