import { AppButton } from "./AppButton";

type AppPaginationProps = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageStart?: number;
  pageEnd?: number;
  onPageChange: (page: number) => void;
  variant?: "top" | "bottom";
  label?: string;
};

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, page), Math.max(1, totalPages));
}

export function AppPagination({
  currentPage,
  totalPages,
  totalItems,
  pageStart,
  pageEnd,
  onPageChange,
  variant = "top",
  label = "OS",
}: AppPaginationProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const isFirst = currentPage <= 1;
  const isLast = currentPage >= safeTotalPages;

  const goTo = (page: number) => {
    onPageChange(clampPage(page, safeTotalPages));
  };

  return (
    <div className={`os-pagination-bar ${variant === "bottom" ? "os-pagination-bar-bottom" : ""}`}>
      <div>
        {variant === "top" && pageStart !== undefined && pageEnd !== undefined ? (
          <>
            Mostrando <strong>{pageStart}</strong> a <strong>{pageEnd}</strong> de <strong>{totalItems}</strong> {label}
          </>
        ) : (
          <>
            Página <strong>{currentPage}</strong> de <strong>{safeTotalPages}</strong>
          </>
        )}
      </div>

      <div className="os-pagination-actions">
        {variant === "bottom" && (
          <AppButton variant="secondary" onClick={() => goTo(1)} disabled={isFirst}>
            Primeira
          </AppButton>
        )}

        <AppButton variant="secondary" onClick={() => goTo(currentPage - 1)} disabled={isFirst}>
          Anterior
        </AppButton>

        {variant === "top" && <span>Página {currentPage} de {safeTotalPages}</span>}

        <AppButton variant="secondary" onClick={() => goTo(currentPage + 1)} disabled={isLast}>
          Próxima
        </AppButton>

        {variant === "bottom" && (
          <AppButton variant="secondary" onClick={() => goTo(safeTotalPages)} disabled={isLast}>
            Última
          </AppButton>
        )}
      </div>
    </div>
  );
}
