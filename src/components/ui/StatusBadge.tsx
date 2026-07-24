import { formatOrdemStatusLabel, getOrdemStatusCssClass } from "../../lib/status";

type StatusBadgeProps = {
  status?: string | null;
  className?: string;
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span className={[getOrdemStatusCssClass(status), className].filter(Boolean).join(" ")}>
      {formatOrdemStatusLabel(status, { uppercase: true })}
    </span>
  );
}
