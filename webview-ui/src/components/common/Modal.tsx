import * as Dialog from "@radix-ui/react-dialog"
import { useRef, type RefObject } from "react"

interface ModalProps {
	isOpen: boolean
	onClose: () => void
	title: string
	children: React.ReactNode
	className?: string
	initialFocusRef?: RefObject<HTMLElement>
}

export function Modal({ isOpen, onClose, title, children, className = "", initialFocusRef }: ModalProps) {
	const contentRef = useRef<HTMLDivElement>(null)
	const openerRef = useRef<HTMLElement | null>(null)

	return (
		<Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
					<Dialog.Content
						ref={contentRef}
						aria-describedby={undefined}
						onOpenAutoFocus={(event) => {
							event.preventDefault()
							const activeElement = contentRef.current?.ownerDocument.activeElement
							openerRef.current = activeElement instanceof HTMLElement ? activeElement : null
							const firstControl = contentRef.current?.querySelector<HTMLElement>(
								'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
							)
							const focusTarget = initialFocusRef?.current ?? firstControl ?? contentRef.current
							focusTarget?.focus()
						}}
						onCloseAutoFocus={(event) => {
							// This controlled modal has no Radix Trigger to restore focus to.
							event.preventDefault()
							if (openerRef.current?.isConnected) openerRef.current.focus()
							openerRef.current = null
						}}
						className={`surface-overlay relative flex h-[90%] w-[90%] max-w-[1200px] flex-col overflow-hidden rounded-2xl ${className}`}>
						<Dialog.Title className="sr-only">{title}</Dialog.Title>
						{children}
					</Dialog.Content>
				</Dialog.Overlay>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
