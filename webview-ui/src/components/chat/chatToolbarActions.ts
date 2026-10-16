import type { ChatToolbarProps } from "./ChatToolbar"
import { vscode } from "@/utils/vscode"

/** Use the owning webview's existing host routes for shared toolbar navigation. */
export const chatToolbarActions = {
	onOpenSettings: () => vscode.postMessage({ type: "switchTab", tab: "settings" }),
	onOpenTickets: () => vscode.postMessage({ type: "openTickets" }),
	onOpenIncidents: () => vscode.postMessage({ type: "openIncidentDashboard" }),
	onOpenScheduledTasks: () => vscode.postMessage({ type: "switchTab", tab: "scheduledTasks" }),
	onOpenMarketplace: () => vscode.postMessage({ type: "switchTab", tab: "marketplace" }),
} satisfies Omit<ChatToolbarProps, "navigation" | "renderContext" | "debug" | "onNewChat">
