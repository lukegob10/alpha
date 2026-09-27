import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, type MouseEventHandler } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useTranslation } from "react-i18next"
import {
	ticketPrioritySchema,
	ticketStatusOrder,
	ticketTypeSchema,
	type Ticket,
	type TicketPriority,
	type TicketStatus,
	type TicketSummary,
} from "@alpha-code/types"
import { TicketTypeBadge } from "./TicketTypeBadge"

interface TicketReaderProps {
	ticket: Ticket
	busy: boolean
	changed: boolean
	onEdit: () => void
	onAddChild: () => void
	onWork: () => void
	onReload: () => void
	onDelete: MouseEventHandler<HTMLButtonElement>
	onOpenRelated: (id: string) => void
	onOpenLinkedTask: (taskId: string) => void
	parent?: TicketSummary
	childTickets: TicketSummary[]
	relationsLoading: boolean
	relationsError?: string
	onStatusChange: (status: TicketStatus) => void
	onPriorityChange: (priority: TicketPriority | null) => void
	onTypeChange: (type: Ticket["type"] | null) => void
	statusPending: boolean
	statusError?: string
}

const formatDate = (date: string) =>
	new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(date))

type PropertyFocus = {
	ticketId: string
	element: HTMLSelectElement
	userMoved: boolean
}

export function TicketReader({
	ticket,
	busy,
	changed,
	onEdit,
	onAddChild,
	onWork,
	onReload,
	onDelete,
	onOpenRelated,
	onOpenLinkedTask,
	parent,
	childTickets,
	relationsLoading,
	relationsError,
	onStatusChange,
	onPriorityChange,
	onTypeChange,
	statusPending,
	statusError,
}: TicketReaderProps) {
	const { t } = useTranslation("tickets")
	const editButton = useRef<HTMLButtonElement>(null)
	const needsFocus = useRef(true)
	const propertyFocus = useRef<PropertyFocus | undefined>(undefined)
	useEffect(() => {
		// Saving mounts this view while the request is still busy; focus after the button is enabled.
		if (!busy && needsFocus.current) {
			editButton.current?.focus()
			needsFocus.current = false
		}
	}, [busy])
	useLayoutEffect(() => {
		const pending = propertyFocus.current
		if (!pending) return
		if (pending.ticketId !== ticket.id) {
			propertyFocus.current = undefined
			return
		}
		if (!statusPending) {
			propertyFocus.current = undefined
			const active = document.activeElement
			if (
				!pending.userMoved &&
				pending.element.isConnected &&
				(active === document.body || active === document.documentElement)
			) {
				pending.element.focus({ preventScroll: true })
			}
			return
		}

		const active = document.activeElement
		if (active !== pending.element && active !== document.body && active !== document.documentElement) {
			pending.userMoved = true
		}
		const movedFocus = (event: FocusEvent) => {
			if (
				event.target !== pending.element &&
				event.target !== document.body &&
				event.target !== document.documentElement
			)
				pending.userMoved = true
		}
		const pressedTab = (event: KeyboardEvent) => {
			if (event.key === "Tab") pending.userMoved = true
		}
		const pointerDown = (event: PointerEvent) => {
			if (event.target !== pending.element) pending.userMoved = true
		}
		document.addEventListener("focusin", movedFocus, true)
		document.addEventListener("keydown", pressedTab, true)
		document.addEventListener("pointerdown", pointerDown, true)
		return () => {
			document.removeEventListener("focusin", movedFocus, true)
			document.removeEventListener("keydown", pressedTab, true)
			document.removeEventListener("pointerdown", pointerDown, true)
		}
	}, [statusPending, ticket.id])
	const rememberPropertyFocus = (element: HTMLSelectElement) => {
		if (document.activeElement === element) {
			propertyFocus.current = { ticketId: ticket.id, element, userMoved: false }
		}
	}

	return (
		<article className="ticket-detail ticket-reader" aria-labelledby="ticket-heading">
			{changed && (
				<div className="tickets-notice">
					{t("changed")}{" "}
					<button type="button" disabled={busy} onClick={onReload}>
						{t("reload")}
					</button>
				</div>
			)}
			<header className="ticket-reader-header">
				<div className="ticket-reader-header-row">
					{ticket.reference && <span className="ticket-reader-reference">{ticket.reference}</span>}
					<div className="ticket-reader-actions">
						{ticket.status !== "complete" && ticket.status !== "canceled" && (
							<button type="button" className="ticket-reader-primary" disabled={busy} onClick={onWork}>
								{t("work")}
							</button>
						)}
						<button
							type="button"
							ref={editButton}
							className="ticket-edit-button"
							disabled={busy}
							onClick={onEdit}>
							<Pencil size={14} aria-hidden="true" />
							{t("edit")}
						</button>
						<button
							type="button"
							className="ticket-delete-button ticket-reader-delete"
							disabled={busy}
							onClick={onDelete}>
							<Trash2 size={14} aria-hidden="true" />
							{t("delete")}
						</button>
					</div>
				</div>
				<h1 id="ticket-heading">{ticket.name}</h1>
				<div className="ticket-reader-meta">
					<span className="ticket-reader-status" data-status={ticket.status}>
						{t(ticket.status)}
					</span>
					{ticket.type && <TicketTypeBadge type={ticket.type} />}
					<span>
						{t("updated")}{" "}
						<time dateTime={ticket.updatedAt} title={new Date(ticket.updatedAt).toLocaleString()}>
							{formatDate(ticket.updatedAt)}
						</time>
					</span>
				</div>
			</header>
			<div className="ticket-reader-layout">
				<div className="ticket-reader-content">
					{(["description", "context", "successCriteria", "implementationSummary"] as const).map(
						(field) =>
							(field === "implementationSummary" || ticket[field].trim()) && (
								<section
									className={`ticket-reader-section ticket-reader-${field}`}
									key={field}
									aria-labelledby={`ticket-${field}`}>
									<h2 id={`ticket-${field}`}>{t(field)}</h2>
									<div className="ticket-prose">
										<ReactMarkdown
											remarkPlugins={[remarkGfm]}
											components={{
												a: ({ href, children }) =>
													href && /^https?:\/\//i.test(href) ? (
														<a href={href} target="_blank" rel="noreferrer noopener">
															{children}
														</a>
													) : (
														<span>{children}</span>
													),
												img: ({ alt }) => <span>{alt}</span>,
											}}>
											{ticket[field]}
										</ReactMarkdown>
									</div>
								</section>
							),
					)}
					{ticket.parentId && (
						<section className="ticket-reader-parent" aria-labelledby="ticket-parent-heading">
							<h2 id="ticket-parent-heading">{t("parentTicket")}</h2>
							<button
								type="button"
								className="ticket-reader-relation"
								disabled={busy}
								onClick={() => onOpenRelated(ticket.parentId!)}>
								{parent
									? `${parent.reference ? `${parent.reference} · ` : ""}${parent.name}`
									: t("openParent")}
							</button>
						</section>
					)}
				</div>
				<aside className="ticket-reader-sidebar">
					<section className="ticket-reader-sidebar-section" aria-labelledby="ticket-properties-heading">
						<h2 id="ticket-properties-heading">{t("properties")}</h2>
						<div className="ticket-reader-property-controls">
							<label className="ticket-reader-property" htmlFor="ticket-status-select">
								<span>{t("status")}</span>
								<select
									id="ticket-status-select"
									className="ticket-status-select"
									aria-label={t("statusOf", { ticket: ticket.name })}
									value={ticket.status}
									disabled={busy || statusPending}
									onChange={(event) => {
										rememberPropertyFocus(event.currentTarget)
										onStatusChange(event.target.value as TicketStatus)
									}}>
									{ticketStatusOrder.map((status) => (
										<option key={status} value={status}>
											{t(status)}
										</option>
									))}
								</select>
							</label>
							<label className="ticket-reader-property" htmlFor="ticket-priority-select">
								<span>{t("priority")}</span>
								<select
									id="ticket-priority-select"
									value={ticket.priority ?? ""}
									disabled={busy || statusPending}
									onChange={(event) => {
										rememberPropertyFocus(event.currentTarget)
										const parsed = ticketPrioritySchema.safeParse(event.target.value)
										onPriorityChange(parsed.success ? parsed.data : null)
									}}>
									<option value="">{t("noPriority")}</option>
									{ticketPrioritySchema.options.map((priority) => (
										<option key={priority} value={priority}>
											{t(`priorities.${priority}`)}
										</option>
									))}
								</select>
							</label>
							<label className="ticket-reader-property" htmlFor="ticket-type-select">
								<span>{t("type")}</span>
								<select
									id="ticket-type-select"
									value={ticket.type ?? ""}
									disabled={busy || statusPending}
									onChange={(event) => {
										rememberPropertyFocus(event.currentTarget)
										const parsed = ticketTypeSchema.safeParse(event.target.value)
										onTypeChange(parsed.success ? parsed.data : null)
									}}>
									<option value="">{t("noType")}</option>
									{ticketTypeSchema.options.map((type) => (
										<option key={type} value={type}>
											{t(`types.${type}`)}
										</option>
									))}
								</select>
							</label>
						</div>
						{statusPending && (
							<p className="ticket-reader-property-feedback" role="status">
								{t("savingProperty")}
							</p>
						)}
						{statusError && (
							<p className="ticket-reader-property-feedback" role="alert">
								{statusError}
							</p>
						)}
						<dl className="ticket-reader-dates">
							{(["createdAt", "completedAt"] as const).map((field) => {
								const date = ticket[field]
								if (!date) return null
								return (
									<div key={field}>
										<dt>{t(field === "createdAt" ? "created" : "completed")}</dt>
										<dd>
											<time dateTime={date} title={new Date(date).toLocaleString()}>
												{formatDate(date)}
											</time>
										</dd>
									</div>
								)
							})}
						</dl>
					</section>
					<section className="ticket-reader-sidebar-section" aria-labelledby="ticket-linked-work-heading">
						<h2 id="ticket-linked-work-heading">{t("linkedWork")}</h2>
						{ticket.linkedTaskIds.length > 0 ? (
							<ul className="ticket-reader-linked-work">
								{ticket.linkedTaskIds.map((taskId, index) => (
									<li key={taskId}>
										<button
											type="button"
											className="ticket-reader-relation"
											disabled={busy}
											aria-label={t("openLinkedConversation", { number: index + 1 })}
											title={taskId}
											onClick={() => onOpenLinkedTask(taskId)}>
											<MessageSquare size={14} aria-hidden="true" />
											{t("linkedConversation", { number: index + 1 })}
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="ticket-reader-empty">{t("noLinkedWork")}</p>
						)}
					</section>
					<section className="ticket-reader-sidebar-section" aria-labelledby="ticket-subtickets-heading">
						<div className="ticket-reader-section-heading">
							<h2 id="ticket-subtickets-heading">{t("subtickets")}</h2>
							<button
								type="button"
								className="ticket-reader-add-child"
								disabled={busy}
								onClick={onAddChild}>
								<Plus size={14} aria-hidden="true" />
								{t("addChild")}
							</button>
						</div>
						{relationsError ? (
							<p className="ticket-reader-empty" role="alert">
								{t("relationsError")}: {relationsError}
							</p>
						) : relationsLoading ? (
							<p className="ticket-reader-empty" role="status">
								{t("relationsLoading")}
							</p>
						) : childTickets.length > 0 ? (
							<ul className="ticket-reader-subtickets">
								{childTickets.map((child) => (
									<li key={child.id}>
										<button
											type="button"
											className="ticket-reader-relation"
											disabled={busy}
											onClick={() => onOpenRelated(child.id)}>
											{child.reference && <span>{child.reference} · </span>}
											<span>{child.name}</span>
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="ticket-reader-empty">{t("noSubtickets")}</p>
						)}
					</section>
				</aside>
			</div>
		</article>
	)
}
