import { useTranslation } from "react-i18next"
import type { TicketType } from "@alpha-code/types"

export function TicketTypeBadge({ type }: { type: TicketType }) {
	const { t } = useTranslation("tickets")
	return (
		<span className="ticket-type-badge" data-type={type}>
			<span className="ticket-type-dot" aria-hidden="true" />
			{t(`types.${type}`)}
		</span>
	)
}
