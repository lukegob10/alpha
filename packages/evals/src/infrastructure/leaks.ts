import type { DockerCliAdapter } from "./dockerAdapter"
import type { ResourceOwner } from "./types"

export async function assertNoContainerLeaks(adapter: DockerCliAdapter, owner: Partial<ResourceOwner>): Promise<void> {
	const leaked = await adapter.list(owner)
	if (leaked.length > 0) throw new Error(`Leaked eval containers: ${leaked.map(({ name }) => name).join(", ")}`)
}
