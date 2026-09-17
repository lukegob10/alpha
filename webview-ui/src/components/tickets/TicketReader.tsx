import { Circle, CircleCheck, CircleDot, Pencil, Trash2 } from "lucide-react"
import { useEffect, useRef, type MouseEventHandler } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useTranslation } from "react-i18next"
import type { Ticket } from "@alpha-code/types"
import { TicketTypeBadge } from "./TicketTypeBadge"

interface TicketReaderProps {
	ticket: Ticket
	busy: boolean
	changed: boolean
	onEdit: () => void
	onWork: () => void
	onReload: () => void
	onDelete: MouseEventHandler<HTMLButtonElement>
}

export function TicketReader({ ticket, busy, changed, onEdit, onWork, onReload, onDelete }: TicketReaderProps) {
	const { t } = useTranslation("tickets")
	const editButton = useRef<HTMLButtonElement>(null)
	const needsFocus = useRef(true)
	useEffect(() => {
		// Saving mounts this view while the request is still busy; focus after the button is enabled.
		if (!busy && needsFocus.current) {
			editButton.current?.focus()
			needsFocus.current = false
		}
	}, [busy])
	const StatusIcon = ticket.status === "complete" ? CircleCheck : ticket.status === "in-progress" ? CircleDot : Circle
	return (
		<article className="ticket-detail ticket-reader" aria-labelledby="ticket-heading">
			{changed && (
				<div className="tickets-notice">
					{t("changed")}{" "}
					<button disabled={busy} onClick={onReload}>
						{t("reload")}
					</button>
				</div>
			)}
			<div className="ticket-reader-layout">
				<div className="ticket-reader-content">
					<header className="ticket-reader-header">
						<div className="tickets-toolbar">
							{ticket.reference && <span className="ticket-reference">{ticket.reference}</span>}
							<button ref={editButton} className="ticket-edit-button" disabled={busy} onClick={onEdit}>
								<Pencil size={14} aria-hidden="true" />
								{t("edit")}
							</button>
							<button className="ticket-delete-button" disabled={busy} onClick={onDelete}>
								<Trash2 size={14} aria-hidden="true" />
								{t("delete")}
							</button>
						</div>
						<h1 id="ticket-heading">{ticket.name}</h1>
					</header>
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
					{ticket.status !== "complete" && (
						<footer className="ticket-reader-footer">
							<button disabled={busy} onClick={onWork}>
								{t("work")}
							</button>
						</footer>
					)}
				</div>
				<aside className="ticket-properties" aria-labelledby="ticket-properties-heading">
					<h2 id="ticket-properties-heading">{t("properties")}</h2>
					<dl>
						<div>
							<dt>{t("status")}</dt>
							<dd>
								<span className="ticket-status" data-status={ticket.status}>
									<StatusIcon size={14} aria-hidden="true" />
									{t(ticket.status)}
								</span>
							</dd>
						</div>
						<div>
							<dt>{t("type")}</dt>
							<dd>
								{ticket.type ? (
									<TicketTypeBadge type={ticket.type} />
								) : (
									<span className="ticket-no-type">{t("noType")}</span>
								)}
							</dd>
						</div>
					</dl>
					<dl className="ticket-reader-dates">
						{(["createdAt", "updatedAt", "completedAt"] as const).map((field) => {
							const date = ticket[field]
							return date ? (
								<div key={field}>
									<dt>
										{t(
											field === "createdAt"
												? "created"
												: field === "updatedAt"
													? "updated"
													: "completed",
										)}
									</dt>
									<dd>
										<time dateTime={date} title={new Date(date).toLocaleString()}>
											{new Date(date).toLocaleDateString(undefined, {
												month: "short",
												day: "numeric",
												year: "numeric",
											})}
										</time>
									</dd>
								</div>
							) : null
						})}
					</dl>
				</aside>
			</div>
		</article>
	)
}
