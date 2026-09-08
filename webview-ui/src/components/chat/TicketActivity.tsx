import { Check, Search, Ticket, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ticketActivitySchema, type ClineSayTool } from "@alpha-code/types"
import { vscode } from "../../utils/vscode"

export function TicketActivity({ tool }: { tool: ClineSayTool }) {
	const { t } = useTranslation("tickets")
	let parsed = ticketActivitySchema.safeParse(tool.ticketActivity)
	// Old approval rows stored the request in content. Extract only the label; never render the payload.
	if (!parsed.success && tool.content) {
		try {
			const legacy = JSON.parse(tool.content)
			parsed = ticketActivitySchema.safeParse({
				operation:
					legacy?.operation === "create_ticket"
						? "create"
						: legacy?.operation === "update_ticket"
							? "update"
							: legacy?.operation === "delete_ticket"
								? "delete"
								: undefined,
				state: "pending",
				name: legacy?.name,
			})
		} catch {
			// Malformed or older saved rows retain a safe, generic label.
		}
	}
	const activity = parsed.success ? parsed.data : undefined
	const failed = activity?.state === "error" || activity?.state === "cancelled"
	const Icon = failed
		? TriangleAlert
		: activity?.operation === "list"
			? Search
			: activity?.state === "success"
				? Check
				: Ticket
	const label = !activity
		? "title"
		: activity.state === "cancelled"
			? "activityCancelled"
			: activity.state === "error"
				? "activityLookupFailed"
				: activity.operation === "list"
					? activity.state === "pending"
						? "activitySearching"
						: activity.total
							? "activityFound"
							: "empty"
					: activity.operation === "read"
						? activity.state === "success"
							? "activityLoaded"
							: "activityReading"
						: activity.operation === "create"
							? activity.state === "success"
								? "activityCreated"
								: "activityCreate"
							: activity.operation === "delete"
								? activity.state === "success"
									? "activityDeleted"
									: "activityDelete"
								: activity.state === "success"
									? "activityUpdated"
									: "activityUpdate"
	const matches = activity?.operation === "list" ? (activity.matches ?? []) : activity?.name ? [activity] : []
	return (
		<div
			className="min-w-0 rounded-md border border-vscode-panel-border bg-vscode-editor-background px-3 py-2"
			role="group"
			aria-label={t("activityTitle")}>
			<div className="mb-1 flex items-center gap-2 font-medium">
				<Ticket className="size-4 shrink-0" aria-hidden="true" />
				<span>{t("activityTitle")}</span>
			</div>
			<div className="flex min-w-0 items-start gap-2 text-vscode-descriptionForeground">
				<Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				<div className="min-w-0 break-words">
					<span>{t(label, { count: activity?.operation === "list" ? activity.total : undefined })}</span>
					{activity?.operation === "list" && activity.query && <span> · {activity.query}</span>}
					{matches.map((match, index) => (
						<div key={index}>
							{(match.target || match.reference) &&
							activity?.state === "success" &&
							activity.operation !== "delete" ? (
								<button
									className="text-left text-vscode-textLink-foreground hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
									onClick={(event) => {
										event.stopPropagation()
										vscode.postMessage(
											match.target
												? { type: "openTicket", ticketTarget: match.target }
												: { type: "openMention", text: `ticket:${match.reference}` },
										)
									}}>
									{match.reference && <span className="font-mono">{match.reference} · </span>}
									{match.name}
								</button>
							) : (
								<>
									{match.reference && (
										<span className="font-mono text-vscode-foreground">{match.reference}</span>
									)}
									<span> · {match.name}</span>
								</>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
