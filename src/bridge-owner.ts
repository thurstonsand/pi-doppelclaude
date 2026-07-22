// Process-scoped bridge owner.
//
// One process must hold exactly one bridge runtime even when the extension
// module is evaluated more than once: a nested (subagent) ModelRuntime
// re-imports this module, but its provider calls must route through the same
// stream closure and the same reentrant QueryContexts as the creating activation.
//
// A private Symbol.for() registry holds that single owner. The first activation
// builds it and owns its lifecycle; later activations borrow it. This module never receives
// ExtensionAPI — index.ts passes an ordinary build factory and does all Pi
// registration and event wiring itself.

const OWNER_KEY = Symbol.for("claude-bridge:owner");

export interface OwnerAcquisition<T> {
	/** The shared owner: built once per process, reused by borrowers. */
	owner: T;
	/** True only for the activation that created and manages the owner. */
	ownsLifecycle: boolean;
	/**
	 * Owner-only teardown: drop the owner so the next activation starts a fresh
	 * generation. A borrower's release is a no-op — it cannot clear the shared
	 * owner out from under the root.
	 */
	release(): void;
}

export function acquireBridgeOwner<T extends object>(build: () => T): OwnerAcquisition<T> {
	const registry = globalThis as Record<symbol, unknown>;
	const existing = registry[OWNER_KEY];
	if (existing !== undefined) {
		return { owner: existing as T, ownsLifecycle: false, release() {} };
	}
	const owner = build();
	registry[OWNER_KEY] = owner;
	return {
		owner,
		ownsLifecycle: true,
		release() {
			if (registry[OWNER_KEY] === owner) registry[OWNER_KEY] = undefined;
		},
	};
}
