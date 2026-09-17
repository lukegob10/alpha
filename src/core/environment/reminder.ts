import { TodoItem, TodoStatus } from "@alpha-code/types"

/**
 * Format the reminders section as a markdown block in English, with basic instructions.
 */
export function formatReminderSection(todoList?: TodoItem[]): string {
	if (!todoList || todoList.length === 0) {
		return ""
	}
	const statusMap: Record<TodoStatus, string> = {
		pending: "Pending",
		in_progress: "In Progress",
		completed: "Completed",
	}
	const lines: string[] = [
		"====",
		"",
		"REMINDERS",
		"",
		"Current task checklist. Update at meaningful stage transitions or before the final response; combine status changes in one update. Do not update merely because a tool ran.",
		"",
	]

	lines.push("| # | Content | Status |")
	lines.push("|---|---------|--------|")
	todoList.forEach((item, idx) => {
		const escapedContent = item.content.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
		lines.push(`| ${idx + 1} | ${escapedContent} | ${statusMap[item.status] || item.status} |`)
	})
	lines.push("")

	return lines.join("\n")
}
