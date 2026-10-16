import type { HistoryItem } from "@alpha-code/types"

/**
 * Extended HistoryItem with display-related fields for search highlighting and subtask indication
 */
export interface DisplayHistoryItem extends HistoryItem {
	/** HTML string with search match highlighting */
	highlight?: string
	/** Whether this task is a subtask (has a parent in the current task list) */
	isSubtask?: boolean
}

/**
 * A node in the subtask tree, representing a task and its recursively nested children.
 */
export interface SubtaskTreeNode {
	/** The task at this tree node */
	item: DisplayHistoryItem
	/** Recursively nested child subtasks */
	children: SubtaskTreeNode[]
	/** Whether this node's children are expanded in the UI */
	isExpanded: boolean
}

/**
 * Recursively counts all subtasks in a tree of SubtaskTreeNodes.
 */
export function countAllSubtasks(nodes: SubtaskTreeNode[]): number {
	let count = 0
	for (const node of nodes) {
		count += 1 + countAllSubtasks(node.children)
	}
	return count
}

/** Count each persisted descendant once, including malformed cycles from historical records. */
export function countTaskDescendants(tasks: readonly HistoryItem[], taskId: string): number {
	const children = new Map<string, string[]>()
	for (const task of tasks) {
		if (!task.parentTaskId) continue
		const siblings = children.get(task.parentTaskId) ?? []
		siblings.push(task.id)
		children.set(task.parentTaskId, siblings)
	}
	const visited = new Set([taskId])
	const pending = [taskId]
	while (pending.length) {
		for (const childId of children.get(pending.pop()!) ?? []) {
			if (visited.has(childId)) continue
			visited.add(childId)
			pending.push(childId)
		}
	}
	return visited.size - 1
}

/**
 * A group of tasks consisting of a parent task and its nested subtask tree
 */
export interface TaskGroup {
	/** The parent task */
	parent: DisplayHistoryItem
	/** Tree of subtasks (supports arbitrary nesting depth) */
	subtasks: SubtaskTreeNode[]
	/** Whether the subtask list is expanded */
	isExpanded: boolean
}

/**
 * Result from the useGroupedTasks hook
 */
export interface GroupedTasksResult {
	/** Groups of tasks (parent + subtasks) - used in normal view */
	groups: TaskGroup[]
	/** Flat list of tasks with isSubtask flag - used in search mode */
	flatTasks: DisplayHistoryItem[] | null
	/** Function to toggle expand/collapse state of a group */
	toggleExpand: (taskId: string) => void
	/** Whether search mode is active */
	isSearchMode: boolean
}
