import { faker } from "@faker-js/faker";

import type { AgentIdentity } from "../types/agent.types.ts";

/**
 * Generates a unique agent identity with a human-friendly name and a programmatic ID.
 *
 * The name is a memorable two-part combination (adjective + first name) that makes it
 * easy for humans to refer to agents in logs and conversations.
 *
 * The ID is a standard UUID v4 suitable for indexing agents in pools and registries.
 *
 * @example
 * ```ts
 * const identity = generateIdentity();
 * // { id: "a1b2c3d4-...", name: "Brave Nova" }
 * ```
 */
export function generateIdentity(overrides?: {
	id?: string;
	name?: string;
}): AgentIdentity {
	return {
		id: overrides?.id ?? crypto.randomUUID(),
		name: overrides?.name ?? generateAgentName(),
	};
}

/**
 * Generates a memorable agent name by combining an adjective with a first name.
 *
 * Examples: "Swift Elena", "Clever Atlas", "Bold Orion"
 */
function generateAgentName(): string {
	const adjective = faker.word.adjective({ length: { min: 3, max: 8 } });
	const firstName = faker.person.firstName();

	// Capitalize the adjective to keep it clean
	const capitalized = adjective.charAt(0).toUpperCase() + adjective.slice(1);

	return `${capitalized} ${firstName}`;
}
