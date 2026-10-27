import type { HistoryItem } from "@alpha-code/types"

type NavigationContext = { generation: number; workspace: string }

/** Per-view cursor over saved chats; opening a chat must not reorder an ongoing history walk. */
export class TaskHistoryNavigator {
	private cursor?: NavigationContext & { ids: string[]; index: number }

	isCurrent(context: NavigationContext): boolean {
		return this.cursor?.generation === context.generation && this.cursor.workspace === context.workspace
	}

	select(
		history: readonly HistoryItem[],
		currentTaskId: string | undefined,
		direction: -1 | 1,
		context: NavigationContext,
	): string | undefined {
		const visible = history.filter((item) => item.ts && item.task && !item.archived && item.taskKind !== "subagent")
		const visibleIds = new Set(visible.map((item) => item.id))
		const roots = visible.filter((item) => !item.parentTaskId || !visibleIds.has(item.parentTaskId))
		const eligibleIds = new Set(roots.map((item) => item.id))
		if (!this.isCurrent(context)) {
			// Match the history view's default newest-first order. Codex's resume picker also
			// navigates an ordered saved-thread list (source/tests retrieved 2026-10-26).
			const ids = [...roots].sort((a, b) => b.ts - a.ts).map((item) => item.id)
			this.cursor = { ...context, ids, index: ids.indexOf(currentTaskId ?? "") }
		}
		const cursor = this.cursor!
		// Previous means older (down the newest-first list), Next means newer.
		const step = -direction
		for (
			let index = cursor.index < 0 ? 0 : cursor.index + step;
			index >= 0 && index < cursor.ids.length;
			index += step
		) {
			const id = cursor.ids[index]
			if (!eligibleIds.has(id)) continue
			cursor.index = index
			return id
		}
		return undefined
	}

	recordOpen(generation: number): void {
		if (this.cursor) this.cursor.generation = generation
	}

	reset(): void {
		this.cursor = undefined
	}
}
