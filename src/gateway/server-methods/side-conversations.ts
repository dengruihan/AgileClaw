/**
 * Side-conversation Gateway RPCs.
 *
 * These methods own persistent hidden children only. The first question is sent
 * through the ordinary `chat.send` path after creation, so no model-run path is
 * added here.
 */
import {
  validateSideConversationsAbandonParams,
  validateSideConversationsCloseParams,
  validateSideConversationsCreateParams,
  validateSideConversationsDeleteParams,
  validateSideConversationsListParams,
  validateSideConversationsMergeParams,
  validateSideConversationsReopenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import {
  abandonPersistentSideConversation,
  deletePersistentSideConversation,
  mergePersistentSideConversation,
} from "./side-conversations-handoff.js";
import {
  closePersistentSideConversation,
  createPersistentSideConversation,
  listPersistentSideConversations,
  reopenPersistentSideConversation,
} from "./side-conversations-lifecycle.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sideConversationHandlers: GatewayRequestHandlers = {
  "sideConversations.create": async (options) => {
    const { params, respond, context, client, sessionMutationAuthorization } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsCreateParams,
        "sideConversations.create",
        respond,
      )
    ) {
      return;
    }
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const assertCurrent = () => {
      requestAuthority.assertCurrent();
      sessionMutationAuthorization?.assertCurrent();
    };
    const result = await createPersistentSideConversation({
      cfg: context.getRuntimeConfig(),
      context,
      client,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      intentId: params.intentId,
      ...(params.label !== undefined ? { label: params.label } : {}),
      parentSessionKey: params.parentSessionKey,
      assertCurrent,
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, ...result.value });
    emitSessionsChanged(context, {
      sessionKey: result.value.conversation.sessionKey,
      reason: "side-conversation.create",
    });
    emitSessionsChanged(context, {
      sessionKey: result.value.conversation.parentSessionKey,
      reason: "side-conversation.registry",
    });
  },

  "sideConversations.list": async (options) => {
    const { params, respond, context } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsListParams,
        "sideConversations.list",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agent = resolveRequestedSessionAgentId(cfg, params.parentSessionKey, params.agentId);
    if (!agent.ok) {
      respond(false, undefined, agent.error);
      return;
    }
    // The parent row is the authorization boundary for its hidden registry.
    const read = retainSessionScopedRead(options, params.parentSessionKey, agent.agentId);
    try {
      const result = await listPersistentSideConversations({
        cfg,
        agentId: agent.agentId,
        parentSessionKey: params.parentSessionKey,
        ...(params.state ? { state: params.state } : {}),
      });
      if (!result.ok) {
        respond(false, undefined, result.error);
        return;
      }
      read?.assertCurrent();
      respond(true, { ok: true, ...result.value });
    } catch (error) {
      if (!(error instanceof SessionMutationAuthorizationChangedError)) {
        throw error;
      }
      respond(false, undefined, error.error);
    } finally {
      read?.release();
    }
  },

  "sideConversations.close": async (options) => {
    const { params, respond, context, sessionMutationAuthorization } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsCloseParams,
        "sideConversations.close",
        respond,
      )
    ) {
      return;
    }
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const result = await closePersistentSideConversation({
      cfg: context.getRuntimeConfig(),
      context,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      parentSessionKey: params.parentSessionKey,
      sessionKey: params.sessionKey,
      assertCurrent: () => {
        requestAuthority.assertCurrent();
        sessionMutationAuthorization?.assertCurrent();
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, conversation: result.value });
    emitSessionsChanged(context, {
      sessionKey: result.value.sessionKey,
      reason: "side-conversation.close",
    });
  },

  "sideConversations.merge": async (options) => {
    const { params, respond, context, sessionMutationAuthorization } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsMergeParams,
        "sideConversations.merge",
        respond,
      )
    ) {
      return;
    }
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const result = await mergePersistentSideConversation({
      cfg: context.getRuntimeConfig(),
      context,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      parentSessionKey: params.parentSessionKey,
      sessionKey: params.sessionKey,
      ...(options.signal ? { signal: options.signal } : {}),
      assertCurrent: () => {
        requestAuthority.assertCurrent();
        sessionMutationAuthorization?.assertCurrent();
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, ...result.value });
    emitSessionsChanged(context, {
      sessionKey: result.value.conversation.sessionKey,
      reason: "side-conversation.merge",
    });
    emitSessionsChanged(context, {
      sessionKey: result.value.conversation.parentSessionKey,
      reason: "side-conversation.merge",
    });
  },

  "sideConversations.abandon": async (options) => {
    const { params, respond, context, sessionMutationAuthorization } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsAbandonParams,
        "sideConversations.abandon",
        respond,
      )
    ) {
      return;
    }
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const result = await abandonPersistentSideConversation({
      cfg: context.getRuntimeConfig(),
      context,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      parentSessionKey: params.parentSessionKey,
      sessionKey: params.sessionKey,
      assertCurrent: () => {
        requestAuthority.assertCurrent();
        sessionMutationAuthorization?.assertCurrent();
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, conversation: result.value });
    emitSessionsChanged(context, {
      sessionKey: result.value.sessionKey,
      reason: "side-conversation.abandon",
    });
  },

  "sideConversations.delete": async (options) => {
    const { params, respond, context, sessionMutationAuthorization } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsDeleteParams,
        "sideConversations.delete",
        respond,
      )
    ) {
      return;
    }
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const result = await deletePersistentSideConversation({
      cfg: context.getRuntimeConfig(),
      context,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      parentSessionKey: params.parentSessionKey,
      sessionKey: params.sessionKey,
      ...(params.deleteTranscript !== undefined
        ? { deleteTranscript: params.deleteTranscript }
        : {}),
      assertCurrent: () => {
        requestAuthority.assertCurrent();
        sessionMutationAuthorization?.assertCurrent();
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, ...result.value });
    emitSessionsChanged(context, {
      sessionKey: params.sessionKey,
      reason: "side-conversation.delete",
    });
    emitSessionsChanged(context, {
      sessionKey: params.parentSessionKey,
      reason: "side-conversation.registry",
    });
  },

  "sideConversations.reopen": async (options) => {
    const { params, respond, context, sessionMutationAuthorization } = options;
    if (
      !assertValidParams(
        params,
        validateSideConversationsReopenParams,
        "sideConversations.reopen",
        respond,
      )
    ) {
      return;
    }
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const result = await reopenPersistentSideConversation({
      cfg: context.getRuntimeConfig(),
      context,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      parentSessionKey: params.parentSessionKey,
      sessionKey: params.sessionKey,
      assertCurrent: () => {
        requestAuthority.assertCurrent();
        sessionMutationAuthorization?.assertCurrent();
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, conversation: result.value });
    emitSessionsChanged(context, {
      sessionKey: result.value.sessionKey,
      reason: "side-conversation.reopen",
    });
  },
};
