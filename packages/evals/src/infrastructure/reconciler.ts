import type { ResourceOwner } from "./types"

export type OpenAttempt = ResourceOwner & { databaseId: number; leaseActive: boolean }

export interface ReconciliationPorts {
	listOpenAttempts(): Promise<OpenAttempt[]>
	listContainerAttemptIds(runId: string): Promise<string[]>
	markOrphaned(databaseId: number, detail: string): Promise<void>
}

export async function reconcileOrphanedAttempts(ports: ReconciliationPorts): Promise<number[]> {
	const open = await ports.listOpenAttempts()
	const containersByRun = new Map<string, Set<string>>()
	const orphaned: number[] = []
	for (const attempt of open) {
		let containers = containersByRun.get(attempt.runId)
		if (!containers) {
			containers = new Set(await ports.listContainerAttemptIds(attempt.runId))
			containersByRun.set(attempt.runId, containers)
		}
		if (!attempt.leaseActive || !containers.has(attempt.attemptId)) {
			await ports.markOrphaned(
				attempt.databaseId,
				!attempt.leaseActive ? "runner lease expired" : "runner container absent",
			)
			orphaned.push(attempt.databaseId)
		}
	}
	return orphaned
}
