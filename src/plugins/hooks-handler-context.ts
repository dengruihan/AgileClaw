import type {
  TurnContextContributionsHost,
  TurnContextSource,
} from "./hook-agent-context.types.js";
import type { PluginHookHandlerMap, PluginHookName, PluginHookRegistration } from "./hook-types.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";

/**
 * Handler-context construction shared by hook dispatch: the per-invocation
 * lifetime assertion and the authorized prompt-build binding that scopes the
 * host turn-context surface to each plugin's own key and instance scope.
 */

type HookContext<K extends PluginHookName> = Parameters<PluginHookHandlerMap[K]>[1];

type ContextForHandlerPolicy<K extends PluginHookName> = {
  contextForHandler?: (
    context: HookContext<K>,
    registration: PluginHookRegistration<K>,
  ) => HookContext<K>;
};

export function buildHandlerContext<K extends PluginHookName>(params: {
  ctx: HookContext<K>;
  invocation: { active: boolean } | undefined;
  policy: ContextForHandlerPolicy<K>;
  hook: PluginHookRegistration<K>;
}): HookContext<K> {
  const invocation = params.invocation;
  const invocationContext = invocation
    ? {
        ...params.ctx,
        hookInvocation: Object.freeze({
          assertActive() {
            if (!invocation.active) {
              throw new Error("prompt hook invocation is no longer active");
            }
          },
        }),
      }
    : params.ctx;
  return params.policy.contextForHandler
    ? params.policy.contextForHandler(invocationContext, params.hook)
    : invocationContext;
}

/**
 * Namespaces the host's turn-context contributions per plugin: attach keys are
 * prefixed with the plugin id and factories run inside the plugin's instance
 * scope, so a stale or reloaded plugin can never retain host authority.
 */
export function createTurnContextContributionsContextForHandler(
  assertActive: () => void,
): (
  context: HookContext<"before_prompt_build">,
  registration: PluginHookRegistration<"before_prompt_build">,
) => HookContext<"before_prompt_build"> {
  return (context, registration) => {
    const host = context.turnContextContributions;
    if (!host) {
      return context;
    }
    const instance = getPluginValueInstance(registration.handler);
    return {
      ...context,
      turnContextContributions: {
        attach(options, factory) {
          assertActive();
          // Hook invocation authority ends when the handler returns. A source
          // instead retains the exact plugin instance's lifecycle, including
          // queued material the host may consume after the factory returns.
          const assertSourceCurrent = () => {
            options.assertCurrent?.();
            if (instance) {
              instance.lifecycle.signal.throwIfAborted();
              if (!instance.acceptingCalls || instance.owner?.revoked) {
                throw new Error(`Plugin ${registration.pluginId} is retiring`);
              }
            }
          };
          return host.attach(
            {
              ...options,
              key: `${registration.pluginId}:${options.key}`,
              signal: instance
                ? options.signal
                  ? AbortSignal.any([options.signal, instance.lifecycle.signal])
                  : instance.lifecycle.signal
                : options.signal,
              assertCurrent: assertSourceCurrent,
            },
            (scope): TurnContextSource => {
              assertSourceCurrent();
              const source = instance ? instance.wrap(factory)(scope) : factory(scope);
              if (!instance) {
                return source;
              }
              let disposal: Promise<void> | undefined;
              const dispose = () => {
                disposal ??= Promise.resolve().then(() =>
                  instance.runCleanup(() => source.dispose()),
                );
                return disposal;
              };
              const unregister = instance.lifecycle.onDispose(dispose);
              return {
                ...(source.onAssistantText
                  ? { onAssistantText: (event) => source.onAssistantText?.(event) }
                  : {}),
                flush: (deadlineAtMs) => source.flush(deadlineAtMs),
                dispose: async () => {
                  try {
                    await dispose();
                  } finally {
                    unregister();
                  }
                },
              };
            },
          );
        },
      } satisfies TurnContextContributionsHost,
    };
  };
}
