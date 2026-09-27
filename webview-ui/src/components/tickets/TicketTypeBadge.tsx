import { useTranslation } from "react-i18next"
import type { TicketType } from "@alpha-code/types"

export function TicketTypeBadge({ type }: { type: TicketType }) {
	const { t } = useTranslation("tickets")
	const label = t(`types.${type}`)
	return (
		<span className="ticket-type-badge" data-type={type}>
			<span className="ticket-type-dot" aria-hidden="true" />
			<span className="ticket-type-label">{label}</span>
		</span>
	)
}
