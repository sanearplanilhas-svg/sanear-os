import { useRegisterSW } from "virtual:pwa-register/react";

export default function UpdatePwaNotice() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration || import.meta.env.DEV) return;

      registration.update().catch((error) => {
        console.error("Erro ao verificar atualização do PWA:", error);
      });

      window.setInterval(() => {
        if (document.hidden) return;
        registration.update().catch((error) => {
          console.error("Erro ao verificar atualização periódica do PWA:", error);
        });
      }, 30 * 60 * 1000);

      window.addEventListener("focus", () => {
        registration.update().catch((error) => {
          console.error("Erro ao verificar atualização ao focar a janela:", error);
        });
      });
    },
    onRegisterError(error) {
      console.error("Erro ao registrar o PWA:", error);
    },
  });

  if (import.meta.env.DEV) return null;
  if (!needRefresh && !offlineReady) return null;

  const title = needRefresh
    ? "Nova versão disponível"
    : "Sistema pronto para uso offline";

  const description = needRefresh
    ? "Atualize agora para carregar os últimos ajustes do SANEAR Operacional."
    : "O sistema foi salvo no aparelho e pode abrir mais rápido nos próximos acessos.";

  async function handleUpdate() {
    if (needRefresh) {
      await updateServiceWorker(true);
      return;
    }

    setOfflineReady(false);
  }

  function handleDismiss() {
    setNeedRefresh(false);
    setOfflineReady(false);
  }

  return (
    <div className="pwa-update-notice" role="status" aria-live="polite">
      <div className="pwa-update-icon" aria-hidden="true">
        {needRefresh ? "↻" : "✓"}
      </div>

      <div className="pwa-update-content">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>

      <div className="pwa-update-actions">
        <button
          type="button"
          className="pwa-update-primary"
          onClick={handleUpdate}
        >
          {needRefresh ? "Atualizar agora" : "Entendi"}
        </button>

        {needRefresh && (
          <button
            type="button"
            className="pwa-update-secondary"
            onClick={handleDismiss}
          >
            Depois
          </button>
        )}
      </div>
    </div>
  );
}
