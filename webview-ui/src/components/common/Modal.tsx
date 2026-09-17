import * as Dialog from "@radix-ui/react-dialog"
import { useRef } from "react"

interface ModalProps {
	isOpen: boolean
	onClose: () => void
	title: string
	children: React.ReactNode
	className?: string
}

export function Modal({ isOpen, onClose, title, children, className = "" }: ModalProps) {
	const contentRef = useRef<HTMLDivElement>(null)

	return (
		<Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
					<Dialog.Content
						ref={contentRef}
						aria-describedby={undefined}
						onOpenAutoFocus={(event) => {
							event.preventDefault()
							const firstControl = contentRef.current?.querySelector<HTMLElement>(
								'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
							)
							const focusTarget = firstControl ?? contentRef.current
							focusTarget?.focus()
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
