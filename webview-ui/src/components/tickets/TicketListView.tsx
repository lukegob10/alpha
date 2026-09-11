import { useEffect, useRef } from "react"
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, Search, Ticket as TicketIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
	ticketStatusOrder,
	ticketTypeSchema,
	type TicketList,
	type TicketStatus,
	type TicketType,
} from "@alpha-code/types"
import { TicketTypeBadge } from "./TicketTypeBadge"

interface TicketListViewProps {
	list: TicketList
	query: string
	typeFilter: TicketType | "untagged" | undefined
	onTypeFilterChange: (type: TicketType | "untagged" | undefined) => void
	offset: number
	busy: boolean
	loading?: boolean
	showEmpty?: boolean
	returnToTicket?: string
	collapsedStatuses: readonly TicketStatus[]
	onToggleStatus: (status: TicketStatus) => void
	onQueryChange: (query: string) => void
	onPageChange: (offset: number) => void
	onOpen: (id: string) => void
}

const statusIcons = { backlog: Circle, "in-progress": CircleDot, complete: CircleCheck }

export function TicketListView({
	list,
	query,
	typeFilter,
	onTypeFilterChange,
	offset,
	busy,
	loading = false,
	showEmpty = true,
	returnToTicket,
	collapsedStatuses,
	onToggleStatus,
	onQueryChange,
	onPageChange,
	onOpen,
}: TicketListViewProps) {
	const { t } = useTranslation("tickets")
	const selectedRow = useRef<HTMLButtonElement>(null)
	const selectedGroup = useRef<HTMLButtonElement>(null)
	const search = useRef<HTMLInputElement>(null)
	useEffect(() => {
		;(selectedRow.current ?? selectedGroup.current ?? search.current)?.focus({ preventScroll: true })
	}, [])
	return (
		<section className="tickets-list" aria-labelledby="tickets-heading" aria-busy={loading}>
			<header className="tickets-list-toolbar">
				<div className="tickets-list-title">
					<h1 id="tickets-heading">{t("title")}</h1>
					<span className="ticket-count">{list.total}</span>
				</div>
				<div className="tickets-list-filters">
					<select
						aria-label={t("filterType")}
						value={typeFilter ?? ""}
						onChange={(event) => {
							const value = event.target.value
							onTypeFilterChange(value === "untagged" ? value : ticketTypeSchema.safeParse(value).data)
						}}>
						<option value="">{t("allTypes")}</option>
						{ticketTypeSchema.options.map((type) => (
							<option key={type} value={type}>
								{t(`types.${type}`)}
							</option>
						))}
						<option value="untagged">{t("noType")}</option>
					</select>
					<div className="tickets-search">
						<Search size={15} aria-hidden="true" />
						<input
							ref={search}
							aria-label={t("search")}
							placeholder={t("search")}
							value={query}
							onChange={(event) => onQueryChange(event.target.value)}
						/>
					</div>
				</div>
			</header>
			{ticketStatusOrder.map((status) => {
				const tickets = list.tickets.filter((item) => item.status === status)
				const collapsed = collapsedStatuses.includes(status)
				const Caret = collapsed ? ChevronRight : ChevronDown
				const StatusIcon = statusIcons[status]
				return (
					<section className="ticket-group" key={status} aria-labelledby={`ticket-group-${status}`}>
						<h2 id={`ticket-group-${status}`} data-status={status}>
							<button
								type="button"
								className="ticket-group-toggle"
								ref={
									collapsed && tickets.some((item) => item.id === returnToTicket)
										? selectedGroup
										: undefined
								}
								aria-expanded={!collapsed}
								aria-controls={`ticket-group-list-${status}`}
								onClick={() => onToggleStatus(status)}>
								<Caret size={14} aria-hidden="true" />
								<StatusIcon size={14} className="ticket-group-status" aria-hidden="true" />
								<span>{t(status)}</span>
								<small className="ticket-count">{tickets.length}</small>
							</button>
						</h2>
						<ul id={`ticket-group-list-${status}`} hidden={collapsed}>
							{tickets.map((item) => (
								<li key={item.id}>
									<button
										ref={!collapsed && returnToTicket === item.id ? selectedRow : undefined}
										className="ticket-row"
										data-status={item.status}
										disabled={busy}
										onClick={() => onOpen(item.id)}>
										<StatusIcon size={15} aria-hidden="true" />
										{item.reference && <span className="ticket-reference">{item.reference}</span>}
										<span className="ticket-row-name" title={item.name}>
											{item.name}
										</span>
										{item.type && <TicketTypeBadge type={item.type} />}
										<time
											dateTime={item.updatedAt}
											title={`${t("updated")} ${new Date(item.updatedAt).toLocaleString()}`}>
											{new Date(item.updatedAt).toLocaleDateString(undefined, {
												month: "short",
												day: "numeric",
											})}
										</time>
										<ChevronRight size={14} className="ticket-row-chevron" aria-hidden="true" />
									</button>
								</li>
							))}
						</ul>
					</section>
				)
			})}
			{!list.total && (loading || showEmpty) && (
				<div className="tickets-empty">
					<TicketIcon size={24} aria-hidden="true" />
					<p role="status">{t(loading ? "activitySearching" : "empty")}</p>
				</div>
			)}
			{list.total > 50 && (
				<footer className="tickets-pagination">
					<button
						aria-label={t("previousPage")}
						disabled={busy || offset === 0}
						onClick={() => onPageChange(Math.max(0, offset - 50))}>
						←
					</button>
					<span>
						{offset + 1}–{Math.min(offset + 50, list.total)} / {list.total}
					</span>
					<button
						aria-label={t("nextPage")}
						disabled={busy || offset + 50 >= list.total}
						onClick={() => onPageChange(offset + 50)}>
						→
					</button>
				</footer>
			)}
			{!!list.invalidFiles.length && (
				<div role="alert" className="tickets-notice">
					<p>{t("invalid")}</p>
					{list.invalidFiles.map((file) => (
						<div key={file}>
							<code>{file}</code>
						</div>
					))}
				</div>
			)}
		</section>
	)
}
