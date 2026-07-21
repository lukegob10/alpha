import { cn } from "@src/lib/utils"
import { Button, StandardTooltip } from "@src/components/ui"

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	iconClass: string
	title: string
	disabled?: boolean
	tooltip?: boolean
	isLoading?: boolean
	style?: React.CSSProperties
}

export const IconButton: React.FC<IconButtonProps> = ({
	iconClass,
	title,
	className,
	disabled,
	tooltip = true,
	isLoading,
	onClick,
	style,
	...props
}) => (
	<StandardTooltip content={tooltip ? title : undefined}>
		<Button
			variant="ghost"
			aria-label={title}
			className={cn(
				"relative inline-flex items-center justify-center",
				"bg-transparent border-none p-1.5",
				"rounded-md min-w-[28px] min-h-[28px]",
				"text-vscode-foreground opacity-85",
				"transition-all duration-150",
				"hover:bg-[var(--alpha-accent-soft)] hover:opacity-100",
				"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
				"active:scale-95",
				!disabled && "cursor-pointer",
				disabled && "opacity-40 cursor-not-allowed grayscale-[30%] hover:bg-transparent active:bg-transparent",
				className,
			)}
			disabled={disabled}
			onClick={!disabled ? onClick : undefined}
			style={{ fontSize: 16.5, ...style }}
			{...props}>
			<span className={cn("codicon", iconClass, isLoading && "codicon-modifier-spin")} />
		</Button>
	</StandardTooltip>
)
