import type { ReactElement } from "react";

function EsgotoRetornando(): ReactElement {
  return (
    <section className="page-card">
      <header className="page-header">
        <div>
          <h2>Esgoto Retornando</h2>
          <p>
            Módulo para registro e acompanhamento de casos de esgoto retornando
            em imóveis ou vias públicas.
          </p>
        </div>
      </header>

      <div className="page-placeholder">
        <h2>Módulo indisponível</h2>
        <p>
          O módulo de <strong>Esgoto Retornando</strong> ainda não está
          disponível. Em breve será possível cadastrar e acompanhar essas
          ocorrências pelo sistema.
        </p>
      </div>
    </section>
  );
}

export default EsgotoRetornando;
