type EmptyStateProps = {
  title?: string;
  message: string;
};

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="os-empty app-empty-state">
      {title && <strong>{title}</strong>}
      <span>{message}</span>
    </div>
  );
}
