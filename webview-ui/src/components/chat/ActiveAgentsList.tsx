import { Bot, FolderOpen, GitMerge, X, Eye } from "lucide-react"

import { Button, StandardTooltip } from "@src/components/ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"

export function ActiveAgentsList({ currentTaskId }: { currentTaskId?: string }) {
	const { parallelAgents } = useExtensionState()
	const agents = (parallelAgents ?? []).filter(
		(agent) => agent.parentTaskId === currentTaskId && agent.status !== "closed",
	)

	if (!currentTaskId || agents.length === 0) {
		return null
	}

	return (
		<div className="mt-2 rounded-md border border-vscode-sideBarSectionHeader-border bg-vscode-sideBar-background/70">
			<div className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-vscode-descriptionForeground">
				<Bot className="size-3.5" />
				<span>Parallel agents</span>
			</div>
			<div className="flex flex-col divide-y divide-vscode-sideBarSectionHeader-border">
				{agents.map((agent) => (
					<div key={agent.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
						<span
							className={cn(
								"size-2 rounded-full shrink-0",
								agent.status === "running" && "bg-vscode-charts-blue",
								agent.status === "completed" && "bg-vscode-charts-green",
								agent.status === "failed" && "bg-vscode-charts-red",
								agent.status === "cancelled" && "bg-vscode-charts-yellow",
							)}
						/>
						<div className="min-w-0 flex-1">
							<div className="truncate text-vscode-foreground">{agent.taskName}</div>
							<div className="truncate text-vscode-descriptionForeground">
								{agent.status} · {agent.agentRole ?? "default"} · {agent.resolvedWorkspaceStrategy}
							</div>
						</div>
						<div className="flex items-center gap-1 shrink-0">
							<StandardTooltip content="View task">
								<Button
									variant="ghost"
									size="icon"
									className="size-6"
									onClick={() => vscode.postMessage({ type: "showTaskWithId", text: agent.id })}>
									<Eye className="size-3.5" />
								</Button>
							</StandardTooltip>
							{agent.workspacePath && (
								<StandardTooltip content="Open worktree">
									<Button
										variant="ghost"
										size="icon"
										className="size-6"
										onClick={() =>
											vscode.postMessage({ type: "openAgentWorktree", text: agent.id })
										}>
										<FolderOpen className="size-3.5" />
									</Button>
								</StandardTooltip>
							)}
							{agent.status === "completed" && agent.resolvedWorkspaceStrategy === "newWorktree" && (
								<StandardTooltip content="Integrate result">
									<Button
										variant="ghost"
										size="icon"
										className="size-6"
										onClick={() =>
											vscode.postMessage({ type: "integrateParallelAgentResult", text: agent.id })
										}>
										<GitMerge className="size-3.5" />
									</Button>
								</StandardTooltip>
							)}
							{agent.status === "running" && (
								<StandardTooltip content="Close agent">
									<Button
										variant="ghost"
										size="icon"
										className="size-6"
										onClick={() =>
											vscode.postMessage({ type: "closeParallelAgent", text: agent.id })
										}>
										<X className="size-3.5" />
									</Button>
								</StandardTooltip>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	)
}
