import type { ReactNode } from "react"
import type { ExtensionState } from "@alpha-code/types"
import { CalendarClock, Ellipsis, LayoutDashboard, Settings, SquarePen, Store, Ticket } from "lucide-react"

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	StandardTooltip,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

export interface ChatToolbarProps {
	navigation?: ReactNode
	renderContext: ExtensionState["renderContext"]
	debug: boolean
	onNewChat: () => void
	onOpenSettings: () => void
	onOpenTickets: () => void
	onOpenIncidents: () => void
	onOpenScheduledTasks: () => void
	onOpenMarketplace: () => void
}

const controlClassName =
	"size-6 shrink-0 rounded-md p-0 text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground hover:text-vscode-foreground motion-reduce:transition-none [&_svg]:size-[17px]"

const ChatToolbar = ({
	navigation,
	renderContext,
	debug,
	onNewChat,
	onOpenSettings,
	onOpenTickets,
	onOpenIncidents,
	onOpenScheduledTasks,
	onOpenMarketplace,
}: ChatToolbarProps) => {
	const { t } = useAppTranslation()
	const hasNativeActions = renderContext === "sidebar"
	if (hasNativeActions && !navigation) return null
	const actions = [
		{ label: t("common:chatToolbar.newChat"), Icon: SquarePen, onClick: onNewChat },
		{ label: t("common:chatToolbar.settings"), Icon: Settings, onClick: onOpenSettings },
		{ label: t("common:chatToolbar.tickets"), Icon: Ticket, onClick: onOpenTickets },
	]

	return (
		<div
			role="group"
			aria-label={t("common:chatToolbar.label")}
			className="chat-toolbar flex h-7 min-w-0 shrink-0 items-center gap-px px-2 py-px">
			<div className="flex min-w-0 flex-1 items-center gap-1">{navigation}</div>
			{!hasNativeActions &&
				actions.map(({ label, Icon, onClick }) => (
					<StandardTooltip key={label} content={label} side="bottom">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={controlClassName}
							aria-label={label}
							onClick={onClick}>
							<Icon aria-hidden="true" />
						</Button>
					</StandardTooltip>
				))}
			{!hasNativeActions && (
				<DropdownMenu>
					<StandardTooltip content={t("common:chatToolbar.more")} side="bottom">
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={controlClassName}
								aria-label={t("common:chatToolbar.more")}>
								<Ellipsis aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
					</StandardTooltip>
					<DropdownMenuContent align="end" sideOffset={4}>
						{debug && (
							<DropdownMenuItem onSelect={onOpenIncidents}>
								<LayoutDashboard aria-hidden="true" />
								{t("common:chatToolbar.incidentDashboard")}
							</DropdownMenuItem>
						)}
						<DropdownMenuItem onSelect={onOpenScheduledTasks}>
							<CalendarClock aria-hidden="true" />
							{t("common:chatToolbar.scheduledTasks")}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onOpenMarketplace}>
							<Store aria-hidden="true" />
							{t("common:chatToolbar.marketplace")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	)
}

export default ChatToolbar
