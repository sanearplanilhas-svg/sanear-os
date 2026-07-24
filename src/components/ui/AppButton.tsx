import type { ButtonHTMLAttributes, ReactNode } from "react";

type AppButtonVariant = "primary" | "secondary" | "danger";
type AppButtonSize = "sm" | "md" | "lg";

type AppButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  fullWidth?: boolean;
  children: ReactNode;
};

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function AppButton({
  variant = "secondary",
  size = "md",
  fullWidth = false,
  className,
  children,
  ...props
}: AppButtonProps) {
  const variantClass =
    variant === "primary"
      ? "btn-primary"
      : variant === "danger"
        ? "btn-primary btn-danger"
        : "btn-secondary";

  return (
    <button
      type="button"
      className={joinClasses(
        variantClass,
        size !== "md" && `btn-${size}`,
        fullWidth && "btn-full",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
