interface ModalProps {
	isOpen: boolean
	onClose: () => void
	children: React.ReactNode
	className?: string
}

export function Modal({ isOpen, onClose, children, className = "" }: ModalProps) {
	if (!isOpen) return null

	return (
		<div
			className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
			onClick={onClose}>
			<div
				className={`surface-overlay relative flex h-[90%] w-[90%] max-w-[1200px] flex-col overflow-hidden rounded-2xl ${className}`}
				onClick={(e) => e.stopPropagation()}>
				{children}
			</div>
		</div>
	)
}
