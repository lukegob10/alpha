import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react"
import { ChevronRight, Plus, Ticket as TicketIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
	ticketSchema,
	ticketTargetSchema,
	ticketStatusOrder,
	type TicketTarget,
	type Ticket,
	type TicketFields,
	type TicketList,
	type TicketRequest,
	type TicketResponse,
	type TicketStatus,
} from "@alpha-code/types"
import { vscode } from "../../utils/vscode"
import i18n from "../../i18n/setup"
import { TicketReader } from "./TicketReader"
import { TicketListView } from "./TicketListView"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog"
import "./tickets.css"

const empty: TicketFields = { name: "", description: "", context: "", successCriteria: "", implementationSummary: "" }
const statuses: TicketStatus[] = ticketStatusOrder
type Draft = TicketFields & { status: TicketStatus }
type StoredState = {
	project: string
	ticket?: Ticket
	draft?: Draft
	editing?: boolean
	query?: string
	offset?: number
}
type Result = Ticket | TicketList | undefined

const ticketDraft = (ticket: Ticket): Draft => ({
	name: ticket.name,
	description: ticket.description,
	context: ticket.context,
	successCriteria: ticket.successCriteria,
	implementationSummary: ticket.implementationSummary,
	status: ticket.status,
})

export default function TicketsView() {
	const { t } = useTranslation("tickets")
	const initial = useRef(vscode.getState() as StoredState | undefined).current
	const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
	const [projectsLoaded, setProjectsLoaded] = useState(false)
	const [project, setProject] = useState(initial?.project ?? "")
	const [ticket, setTicket] = useState<Ticket | undefined>(initial?.ticket)
	const [draft, setDraft] = useState<Draft | undefined>(
		initial?.draft ?? (initial?.ticket && ticketDraft(initial.ticket)),
	)
	const [editing, setEditing] = useState(
		initial?.editing ??
			(!!initial?.draft &&
				(!initial.ticket ||
					Object.entries(initial.draft).some(
						([key, value]) => initial.ticket?.[key as keyof Ticket] !== value,
					))),
	)
	const [list, setList] = useState<TicketList>({ tickets: [], total: 0, invalidFiles: [] })
	const [listLoading, setListLoading] = useState(true)
	const [listError, setListError] = useState("")
	const projectAvailable = projects.some((item) => item.id === project)
	const [query, setQuery] = useState(initial?.query ?? "")
	const [offset, setOffset] = useState(initial?.offset ?? 0)
	const [collapsedStatuses, setCollapsedStatuses] = useState<TicketStatus[]>([])
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const running = useRef(false)
	const mounted = useRef(true)
	const [deleteTarget, setDeleteTarget] = useState<{ project: string; ticket: Ticket }>()
	const deleteTrigger = useRef<HTMLButtonElement>()
	const [navigation, setNavigation] = useState<TicketTarget>()
	const navigate = useRef<(target: TicketTarget) => void>(() => {})
	const [refresh, setRefresh] = useState(0)
	const [changed, setChanged] = useState(false)
	const [discard, setDiscard] = useState<(() => void) | undefined>()
	const sequence = useRef(0)
	const listSequence = useRef(0)
	const page = useRef<HTMLDivElement>(null)
	const listScroll = useRef(0)
	const returnToTicket = useRef(initial?.ticket?.id)
	const showingDetail = !!(ticket || draft)
	const pending = useRef(
		new Map<
			string,
			{ resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
		>(),
	)
	const baseline = ticket && ticketDraft(ticket)
	const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline)
	const latest = useRef({ project, dirty, id: ticket?.id })
	latest.current = { project, dirty, id: ticket?.id }

	const request = useCallback(
		(operation: TicketRequest["operation"], targetProject = latest.current.project) =>
			new Promise<Result>((resolve, reject) => {
				const requestId = String(++sequence.current)
				const timer = setTimeout(() => {
					pending.current.delete(requestId)
					reject(new Error(i18n.t("tickets:timeout")))
				}, 60000)
				pending.current.set(requestId, { resolve, reject, timer })
				vscode.postTicketMessage({ type: "ticketRequest", requestId, project: targetProject, operation })
			}),
		[],
	)

	useEffect(() => {
		mounted.current = true
		const receive = (event: MessageEvent<TicketResponse>) => {
			const message = event.data
			if (message.type === "ticketOpen") {
				const target = ticketTargetSchema.safeParse(message.target)
				if (target.success) setNavigation(target.data)
			} else if (message.type === "ticketProjects") {
				setProjects(message.projects)
				setProjectsLoaded(true)
				if (message.error) {
					setListError(message.error)
					setListLoading(false)
				} else setRefresh((value) => value + 1)
				void i18n.changeLanguage(message.language)
				// Preserve a detached draft's identity until the user explicitly switches projects.
				setProject((current) => current || message.projects[0]?.id || "")
			} else if (message.type === "ticketChanged" && message.project === latest.current.project) {
				setRefresh((value) => value + 1)
				setChanged(true)
			} else if (message.type === "ticketResponse") {
				const callback = pending.current.get(message.requestId)
				if (!callback) return
				clearTimeout(callback.timer)
				pending.current.delete(message.requestId)
				if (message.error) callback.reject(new Error(message.error))
				else callback.resolve(message.result)
			}
		}
		window.addEventListener("message", receive)
		vscode.postTicketMessage({ type: "ticketsReady" })
		const callbacks = pending.current
		return () => {
			mounted.current = false
			window.removeEventListener("message", receive)
			for (const callback of callbacks.values()) {
				clearTimeout(callback.timer)
				callback.reject(new Error("Ticket view closed"))
			}
			callbacks.clear()
		}
	}, [])

	useEffect(() => {
		vscode.setState({ project, ticket, draft, editing, query, offset })
	}, [project, ticket, draft, editing, query, offset])
	useLayoutEffect(() => {
		if (page.current) page.current.scrollTop = showingDetail ? 0 : listScroll.current
	}, [showingDetail])
	useEffect(() => {
		if (!projectAvailable) return
		let active = true
		const currentSequence = ++listSequence.current
		setListLoading(true)
		const timer = setTimeout(() => {
			void request({ action: "list", input: { query, offset, limit: 50 } }, project)
				.then((result) => {
					if (active && currentSequence === listSequence.current && result && "tickets" in result) {
						setList(result)
						setListError("")
						if (offset > 0 && offset >= result.total) {
							setOffset(Math.max(0, Math.floor((result.total - 1) / 50) * 50))
						}
					}
				})
				.catch((cause: Error) => {
					if (active && currentSequence === listSequence.current) setListError(cause.message)
				})
				.finally(() => {
					if (active && currentSequence === listSequence.current) setListLoading(false)
				})
		}, 150)
		return () => {
			active = false
			clearTimeout(timer)
		}
	}, [projectAvailable, project, query, offset, refresh, request])

	const accept = (value: Result) => {
		if (!mounted.current) return
		const parsed = ticketSchema.safeParse(value)
		if (!parsed.success) return
		const valueTicket = parsed.data
		returnToTicket.current = valueTicket.id
		setTicket(valueTicket)
		setDraft(ticketDraft(valueTicket))
		setChanged(false)
		setEditing(false)
	}
	const run = async (action: () => Promise<void>) => {
		if (running.current) return
		running.current = true
		setBusy(true)
		setError("")
		try {
			await action()
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			running.current = false
			if (mounted.current) setBusy(false)
		}
	}
	const guard = (action: () => void) => {
		if (dirty) setDiscard(() => action)
		else action()
	}
	const backToList = () =>
		guard(() => {
			setTicket(undefined)
			setDraft(undefined)
			setEditing(false)
			setChanged(false)
			setError("")
		})
	const open = (id: string) =>
		guard(() => {
			void run(async () => accept(await request({ action: "read", id })))
		})
	navigate.current = (target) =>
		guard(() => {
			void run(async () => {
				const result = await request({ action: "read", id: target.id }, target.project)
				if (ticketSchema.safeParse(result).success) {
					if (target.project !== project) {
						setProject(target.project)
						setQuery("")
						setOffset(0)
						setList({ tickets: [], total: 0, invalidFiles: [] })
						listScroll.current = 0
					}
					accept(result)
				}
			})
		})
	useEffect(() => {
		if (!navigation || busy || deleteTarget) return
		setNavigation(undefined)
		navigate.current(navigation)
	}, [navigation, busy, deleteTarget])
	const confirmDelete = (event: MouseEvent<HTMLButtonElement>) => {
		if (!ticket || running.current) return
		deleteTrigger.current = event.currentTarget
		setError("")
		setDeleteTarget({ project, ticket })
	}
	const deleteTicket = () => {
		if (!deleteTarget) return
		const target = deleteTarget
		void run(async () => {
			await request(
				{ action: "delete", input: { id: target.ticket.id, expectedRevision: target.ticket.revision } },
				target.project,
			)
			if (!mounted.current) return
			// Discard collection reads started before the deletion and any queued navigation back to it.
			listSequence.current++
			setNavigation((current) =>
				current?.project === target.project && current.id === target.ticket.id ? undefined : current,
			)
			const remaining = list.tickets.filter((item) => item.id !== target.ticket.id)
			returnToTicket.current = remaining[0]?.id
			setList({
				...list,
				tickets: remaining,
				total: Math.max(0, list.total - (remaining.length < list.tickets.length ? 1 : 0)),
			})
			setTicket(undefined)
			setDraft(undefined)
			setEditing(false)
			setChanged(false)
			setDeleteTarget(undefined)
			setListLoading(true)
			setRefresh((value) => value + 1)
		})
	}
	const save = async (): Promise<Ticket | undefined> => {
		if (!draft) return ticket
		const { status, ...fields } = draft
		let result = ticket
			? await request({
					action: "update",
					input: { id: ticket.id, expectedRevision: ticket.revision, ...fields, status },
				})
			: await request({ action: "create", input: fields })
		if (!ticket && status !== "backlog" && result && "id" in result)
			result = await request({
				action: "update",
				input: { id: result.id, expectedRevision: result.revision, status },
			})
		accept(result)
		setRefresh((value) => value + 1)
		return ticketSchema.parse(result)
	}

	const startWork = () => {
		void run(async () => {
			const saved = dirty ? await save() : ticket
			if (saved) {
				accept(await request({ action: "work", id: saved.id, expectedRevision: saved.revision }))
				setRefresh((value) => value + 1)
			}
		})
	}

	return (
		<main className="tickets-app">
			<AlertDialog
				open={!!deleteTarget}
				onOpenChange={(open) => {
					if (!open && !running.current) setDeleteTarget(undefined)
				}}>
				<AlertDialogContent
					onEscapeKeyDown={(event) => {
						if (running.current) event.preventDefault()
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus()
					}}>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("deleteDescription", {
								ticket: deleteTarget?.ticket.reference
									? `${deleteTarget.ticket.reference} · ${deleteTarget.ticket.name}`
									: deleteTarget?.ticket.name,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error && <p role="alert">{error}</p>}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
						<AlertDialogAction
							disabled={busy}
							onClick={(event) => {
								event.preventDefault()
								deleteTicket()
							}}>
							{t("deleteAction")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<header className="tickets-header">
				<nav className="tickets-breadcrumbs" aria-label={t("navigation")}>
					<ol>
						<li className="tickets-project-crumb">
							<select
								aria-label={t("project")}
								value={project}
								disabled={busy}
								onChange={(event) => {
									const next = event.target.value
									guard(() => {
										setProject(next)
										setTicket(undefined)
										setDraft(undefined)
										setEditing(false)
										setOffset(0)
										setQuery("")
										setChanged(false)
										setError("")
										setList({ tickets: [], total: 0, invalidFiles: [] })
										listScroll.current = 0
										returnToTicket.current = undefined
									})
								}}>
								{projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name} · {p.id.slice(-6)}
									</option>
								))}
							</select>
						</li>
						<li>
							<ChevronRight size={14} aria-hidden="true" />
							{showingDetail ? (
								<button disabled={busy} onClick={backToList}>
									<TicketIcon size={15} aria-hidden="true" />
									{t("title")}
								</button>
							) : (
								<span aria-current="page">
									<TicketIcon size={15} aria-hidden="true" />
									{t("title")}
								</span>
							)}
						</li>
						{ticket && (
							<li className="tickets-ticket-crumb">
								<ChevronRight size={14} aria-hidden="true" />
								{editing ? (
									<button
										disabled={busy}
										title={ticket.name}
										onClick={() => guard(() => accept(ticket))}>
										{ticket.reference ? `${ticket.reference} · ${ticket.name}` : ticket.name}
									</button>
								) : (
									<span aria-current="page" title={ticket.name}>
										{ticket.reference ? `${ticket.reference} · ${ticket.name}` : ticket.name}
									</span>
								)}
							</li>
						)}
						{editing && (
							<li>
								<ChevronRight size={14} aria-hidden="true" />
								<span aria-current="page">{ticket ? t("edit") : t("new")}</span>
							</li>
						)}
					</ol>
				</nav>
				<button
					className="tickets-new-button"
					disabled={!project || busy}
					onClick={() =>
						guard(() => {
							if (!showingDetail) listScroll.current = page.current?.scrollTop ?? 0
							setTicket(undefined)
							setDraft({ ...empty, status: "backlog" })
							setEditing(true)
							setChanged(false)
						})
					}>
					<Plus size={15} aria-hidden="true" />
					{t("new")}
				</button>
			</header>
			{projectsLoaded && !projectAvailable && !listError && <p>{t("noProject")}</p>}
			{listError && (
				<p role="alert" className="tickets-notice">
					{listError}{" "}
					<button
						disabled={busy || listLoading}
						onClick={() => vscode.postTicketMessage({ type: "ticketsReady" })}>
						{t("reload")}
					</button>
				</p>
			)}
			{error && (
				<p role="alert" className="tickets-notice">
					{error}
				</p>
			)}
			{discard && (
				<div role="alertdialog" aria-label={t("discard")} className="tickets-notice">
					<p>{t("discard")}</p>
					<button
						onClick={() => {
							discard()
							setDiscard(undefined)
						}}>
						{t("discardAction")}
					</button>
					<button onClick={() => setDiscard(undefined)}>{t("cancel")}</button>
				</div>
			)}
			<div className="tickets-page" ref={page}>
				{!showingDetail && (
					<TicketListView
						collapsedStatuses={collapsedStatuses}
						onToggleStatus={(status) =>
							setCollapsedStatuses((current) =>
								current.includes(status)
									? current.filter((item) => item !== status)
									: [...current, status],
							)
						}
						list={list}
						loading={!projectsLoaded || (projectAvailable && listLoading)}
						showEmpty={projectAvailable && !listLoading && !listError}
						query={query}
						offset={offset}
						busy={busy}
						returnToTicket={returnToTicket.current}
						onQueryChange={(value) => {
							setQuery(value)
							setOffset(0)
						}}
						onPageChange={(value) => {
							setOffset(value)
							if (page.current) page.current.scrollTop = 0
						}}
						onOpen={(id) => {
							listScroll.current = page.current?.scrollTop ?? 0
							returnToTicket.current = id
							open(id)
						}}
					/>
				)}
				{ticket && !editing ? (
					<TicketReader
						ticket={ticket}
						busy={busy}
						changed={changed}
						onEdit={() => setEditing(true)}
						onReload={() => open(ticket.id)}
						onWork={startWork}
						onDelete={confirmDelete}
					/>
				) : draft ? (
					<form
						className="ticket-detail"
						onSubmit={(event) => {
							event.preventDefault()
							void run(async () => {
								await save()
							})
						}}>
						{changed && (
							<p className="tickets-notice">
								{t("changed")}{" "}
								<button type="button" disabled={busy} onClick={() => ticket && open(ticket.id)}>
									{t("reload")}
								</button>
							</p>
						)}
						<h1 className="ticket-editor-heading">{ticket ? t("edit") : t("new")}</h1>
						{ticket?.reference && <p className="ticket-reference">{ticket.reference}</p>}
						<fieldset disabled={busy || !project}>
							<label>
								{t("name")}
								<input
									autoFocus
									required
									maxLength={200}
									value={draft.name}
									onChange={(event) => setDraft({ ...draft, name: event.target.value })}
								/>
							</label>
							<label>
								{t("status")}
								<select
									value={draft.status}
									onChange={(event) =>
										setDraft({ ...draft, status: event.target.value as TicketStatus })
									}>
									{statuses.map((status) => (
										<option key={status} value={status}>
											{t(status)}
										</option>
									))}
								</select>
							</label>
							{ticket && (
								<div className="ticket-dates">
									<span>
										{t("created")} {new Date(ticket.createdAt).toLocaleString()}
									</span>
									<span>
										{t("updated")} {new Date(ticket.updatedAt).toLocaleString()}
									</span>
									{ticket.completedAt && (
										<span>
											{t("completed")} {new Date(ticket.completedAt).toLocaleString()}
										</span>
									)}
								</div>
							)}
							{(["description", "context", "successCriteria", "implementationSummary"] as const).map(
								(field) => (
									<label key={field}>
										{t(field)}
										<textarea
											rows={field === "context" ? 6 : 4}
											maxLength={16000}
											required={field === "implementationSummary" && draft.status === "complete"}
											value={draft[field]}
											onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
										/>
									</label>
								),
							)}
							<footer className="tickets-toolbar">
								<button type="submit" disabled={!dirty}>
									{t("save")}
								</button>
								<button
									type="button"
									onClick={() =>
										guard(() => {
											if (ticket) accept(ticket)
											else {
												setDraft(undefined)
												setEditing(false)
											}
										})
									}>
									{t("cancel")}
								</button>
								{ticket && (
									<button
										type="button"
										onClick={() => {
											void run(async () => {
												await request({ action: "openMarkdown", id: ticket.id })
											})
										}}>
										{t("markdown")}
									</button>
								)}
								{ticket && (
									<button type="button" onClick={confirmDelete}>
										{t("delete")}
									</button>
								)}
								<button
									type="button"
									disabled={!draft.name.trim() || draft.status === "complete"}
									onClick={startWork}>
									{t("work")}
								</button>
							</footer>
						</fieldset>
					</form>
				) : null}
			</div>
		</main>
	)
}
