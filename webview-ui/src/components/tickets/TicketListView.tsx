import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import {
	Ban,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleCheck,
	CircleDot,
	Search,
	Ticket as TicketIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import {
	ticketStatusOrder,
	ticketTypeSchema,
	type TicketList,
	type TicketPriority,
	type TicketStatus,
	type TicketSummary,
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

const statusIcons = { backlog: Circle, "in-progress": CircleDot, complete: CircleCheck, canceled: Ban }

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
	const [collapsedParents, setCollapsedParents] = useState<string[]>([])
	const selectedRow = useRef<HTMLButtonElement>(null)
	const selectedGroup = useRef<HTMLButtonElement>(null)
	const search = useRef<HTMLInputElement>(null)
	useEffect(() => {
		;(selectedRow.current ?? selectedGroup.current ?? search.current)?.focus({ preventScroll: true })
	}, [])

	// A filtered or paged child whose parent is absent becomes a visible root. When both
	// are present, the parent owns the child's position even if their statuses differ.
	const visible = new Map(list.tickets.map((item) => [item.id, item]))
	const children = new Map<string, TicketSummary[]>()
	const roots: TicketSummary[] = []
	const hasBrokenParentChain = (item: TicketSummary) => {
		const seen = new Set<string>([item.id])
		let parentId = item.parentId
		while (parentId && visible.has(parentId)) {
			if (seen.has(parentId)) return true
			seen.add(parentId)
			parentId = visible.get(parentId)?.parentId
		}
		return false
	}
	for (const item of list.tickets) {
		if (item.parentId && visible.has(item.parentId) && !hasBrokenParentChain(item)) {
			const siblings = children.get(item.parentId) ?? []
			siblings.push(item)
			children.set(item.parentId, siblings)
		} else roots.push(item)
	}
	const descendants = (root: TicketSummary): TicketSummary[] => [
		root,
		...(children.get(root.id) ?? []).flatMap(descendants),
	]
	const renderTicket = (item: TicketSummary, depth: number, visibleInGroup = true): ReactNode => {
		const childTickets = children.get(item.id) ?? []
		const collapsed = collapsedParents.includes(item.id)
		const StatusIcon = statusIcons[item.status]
		const priority: TicketPriority | undefined = item.priority ?? undefined
		return (
			<Fragment key={item.id}>
				<tr
					className={`ticket-row${depth ? " ticket-row--child" : ""}`}
					data-status={item.status}
					data-depth={depth}
					onClick={() => {
						if (!busy) onOpen(item.id)
					}}>
					<td className="ticket-cell">
						<div className="ticket-row-main" style={{ paddingInlineStart: `${Math.min(depth, 8) * 18}px` }}>
							{depth > 0 && <span className="ticket-row-branch" aria-hidden="true" />}
							{childTickets.length > 0 ? (
								<button
									type="button"
									className="ticket-row-expander"
									aria-label={t(collapsed ? "expandChildren" : "collapseChildren", {
										ticket: item.name,
									})}
									aria-expanded={!collapsed}
									disabled={busy}
									onClick={(event) => {
										event.stopPropagation()
										setCollapsedParents((current) =>
											current.includes(item.id)
												? current.filter((id) => id !== item.id)
												: [...current, item.id],
										)
									}}>
									{collapsed ? (
										<ChevronRight size={14} aria-hidden="true" />
									) : (
										<ChevronDown size={14} aria-hidden="true" />
									)}
								</button>
							) : (
								<span className="ticket-row-expander" aria-hidden="true" />
							)}
							<button
								ref={visibleInGroup && returnToTicket === item.id ? selectedRow : undefined}
								className="ticket-row-open"
								disabled={busy}
								type="button">
								{depth > 0 && <StatusIcon className="ticket-row-status" size={14} aria-hidden="true" />}
								{item.reference && <span className="ticket-reference">{item.reference}</span>}
								<span className="ticket-row-name" title={item.name}>
									{item.name}
								</span>
								<span className="ticket-priority-inline" data-priority={priority ?? "none"}>
									<span aria-hidden="true">{priority ? t(`priorities.${priority}`) : "—"}</span>
									<span className="sr-only">
										{priority
											? `${t("priority")}: ${t(`priorities.${priority}`)}`
											: t("noPriority")}
									</span>
								</span>
								{item.childCount > 0 && (
									<span
										className="ticket-row-progress"
										aria-label={t("childProgress", {
											complete: item.completedChildCount,
											total: item.childCount,
										})}>
										{item.completedChildCount}/{item.childCount}
									</span>
								)}
							</button>
						</div>
					</td>
					<td className="ticket-priority-cell">
						{priority ? (
							<span className="ticket-priority" data-priority={priority}>
								{t(`priorities.${priority}`)}
							</span>
						) : (
							<span className="ticket-priority-empty" aria-label={t("noPriority")}>
								—
							</span>
						)}
					</td>
					<td className="ticket-type-cell">{item.type && <TicketTypeBadge type={item.type} />}</td>
					<td className="ticket-updated-cell">
						<time
							dateTime={item.updatedAt}
							title={`${t("updated")} ${new Date(item.updatedAt).toLocaleString()}`}>
							{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
						</time>
					</td>
				</tr>
				{!collapsed && childTickets.map((child) => renderTicket(child, depth + 1, visibleInGroup))}
			</Fragment>
		)
	}

	return (
		<section className="tickets-list" aria-labelledby="tickets-heading" aria-busy={loading}>
			<header className="tickets-list-toolbar">
				<div className="tickets-list-title">
					<h1 id="tickets-heading">{t("allTickets")}</h1>
					<span className="ticket-count">{list.total}</span>
				</div>
				<div className="tickets-list-filters">
					<select
						className="ticket-filter-select"
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
			<div className="ticket-table-scroll">
				<table className="ticket-table" aria-label={t("title")}>
					<colgroup>
						<col className="ticket-column" />
						<col className="priority-column" />
						<col className="type-column" />
						<col className="updated-column" />
					</colgroup>
					<thead>
						<tr>
							<th scope="col">{t("ticketColumn")}</th>
							<th scope="col">{t("priority")}</th>
							<th scope="col">{t("type")}</th>
							<th scope="col">{t("updated")}</th>
						</tr>
					</thead>
					{ticketStatusOrder.map((status) => {
						const groupRoots = roots.filter((item) => item.status === status)
						const groupTickets = groupRoots.flatMap(descendants)
						if (groupTickets.length === 0) return null
						const collapsed = collapsedStatuses.includes(status)
						const Caret = collapsed ? ChevronRight : ChevronDown
						const labelId = `ticket-group-label-${status}`
						const rowsId = `ticket-group-rows-${status}`
						return (
							<Fragment key={status}>
								<tbody className="ticket-group-heading">
									<tr data-status={status}>
										<th scope="rowgroup" colSpan={4}>
											<h2 className="ticket-group-title">
												<button
													id={labelId}
													className="ticket-group-toggle"
													ref={
														collapsed &&
														groupTickets.some((item) => item.id === returnToTicket)
															? selectedGroup
															: undefined
													}
													aria-expanded={!collapsed}
													aria-controls={rowsId}
													onClick={() => onToggleStatus(status)}>
													<Caret size={14} aria-hidden="true" />
													<span>{t(status)}</span>
													<small className="ticket-count">{groupTickets.length}</small>
												</button>
											</h2>
										</th>
									</tr>
								</tbody>
								<tbody
									id={rowsId}
									className="ticket-group-rows"
									aria-labelledby={labelId}
									hidden={collapsed}>
									{groupRoots.map((item) => renderTicket(item, 0, !collapsed))}
								</tbody>
							</Fragment>
						)
					})}
				</table>
			</div>
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
