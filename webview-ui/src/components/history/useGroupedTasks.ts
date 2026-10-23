import { useState, useMemo, useCallback } from "react"
import type { HistoryItem } from "@alpha-code/types"
import type { DisplayHistoryItem, SubtaskTreeNode, TaskGroup, GroupedTasksResult } from "./types"

/**
 * Recursively builds a subtask tree node for the given task.
 * Pure function — exported for independent testing.
 *
 * @param task - The task to build a tree node for
 * @param childrenMap - Map of parentId → direct children
 * @param expandedIds - Set of task IDs whose children are currently expanded
 * @returns A SubtaskTreeNode with recursively built children sorted by ts (newest first)
 */
export function buildSubtree(
	task: HistoryItem,
	childrenMap: Map<string, HistoryItem[]>,
	expandedIds: Set<string>,
	visited = new Set<string>(),
): SubtaskTreeNode {
	visited.add(task.id)
	const directChildren = (childrenMap.get(task.id) || []).slice().sort((a, b) => b.ts - a.ts)
	const children: SubtaskTreeNode[] = []
	for (const child of directChildren) {
		if (!visited.has(child.id)) children.push(buildSubtree(child, childrenMap, expandedIds, visited))
	}

	return {
		item: task as DisplayHistoryItem,
		children,
		isExpanded: expandedIds.has(task.id),
	}
}

/**
 * Hook to transform a flat task list into grouped structure based on parent-child relationships.
 * In search mode, returns a flat list with isSubtask flag for each item.
 *
 * @param tasks - The list of tasks to group
 * @param searchQuery - Current search query (empty string means not searching)
 * @returns GroupedTasksResult with groups, flatTasks, toggleExpand, and isSearchMode
 */
export function useGroupedTasks(tasks: HistoryItem[], searchQuery: string): GroupedTasksResult {
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

	const isSearchMode = searchQuery.trim().length > 0

	// Build a map of taskId -> HistoryItem for quick lookup
	const taskMap = useMemo(() => {
		const map = new Map<string, HistoryItem>()
		for (const task of tasks) {
			map.set(task.id, task)
		}
		return map
	}, [tasks])

	// Group tasks by parent-child relationship
	const groups = useMemo((): TaskGroup[] => {
		if (isSearchMode) {
			// In search mode, we don't group - return empty groups
			return []
		}

		// Build children map: parentId -> direct children[]
		const childrenMap = new Map<string, HistoryItem[]>()

		for (const task of tasks) {
			if (task.parentTaskId && taskMap.has(task.parentTaskId)) {
				const siblings = childrenMap.get(task.parentTaskId) || []
				siblings.push(task)
				childrenMap.set(task.parentTaskId, siblings)
			}
		}

		// Identify root tasks - tasks that either:
		// 1. Have no parentTaskId
		// 2. Have a parentTaskId that doesn't exist in our task list (orphans promoted to root)
		const rootTasks = tasks.filter((task) => !task.parentTaskId || !taskMap.has(task.parentTaskId))

		// Persisted cycles have no natural root. Render normal trees first, then
		// promote each remaining component so every saved chat stays reachable.
		const visited = new Set<string>()
		const taskGroups: TaskGroup[] = []
		for (const task of [...rootTasks, ...tasks]) {
			if (visited.has(task.id)) continue
			let parent = task
			const ancestors = new Set<string>()
			while (parent.parentTaskId && !ancestors.has(parent.id)) {
				ancestors.add(parent.id)
				const ancestor = taskMap.get(parent.parentTaskId)
				if (!ancestor || visited.has(ancestor.id)) break
				parent = ancestor
			}
			const node = buildSubtree(parent, childrenMap, expandedIds, visited)
			taskGroups.push({
				parent: parent as DisplayHistoryItem,
				subtasks: node.children,
				isExpanded: expandedIds.has(parent.id),
			})
		}

		// Preserve the search hook's selected sort order for root conversations.

		return taskGroups
	}, [tasks, taskMap, isSearchMode, expandedIds])

	// Flatten tasks for search mode with isSubtask flag
	const flatTasks = useMemo((): DisplayHistoryItem[] | null => {
		if (!isSearchMode) {
			return null
		}

		return tasks.map((task) => ({
			...task,
			isSubtask: !!task.parentTaskId && taskMap.has(task.parentTaskId),
		})) as DisplayHistoryItem[]
	}, [tasks, taskMap, isSearchMode])

	// Toggle expand/collapse for a group
	const toggleExpand = useCallback((taskId: string) => {
		setExpandedIds((prev) => {
			const newSet = new Set(prev)
			if (newSet.has(taskId)) {
				newSet.delete(taskId)
			} else {
				newSet.add(taskId)
			}
			return newSet
		})
	}, [])

	return {
		groups,
		flatTasks,
		toggleExpand,
		isSearchMode,
	}
}
