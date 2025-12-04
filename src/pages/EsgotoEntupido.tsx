import type { ReactElement } from "react";

function EsgotoEntupido(): ReactElement {
  return (
    <section className="page-card">
      <header className="page-header">
        <div>
          <h2>Esgoto Entupido</h2>
          <p>
            Módulo para registro e acompanhamento de ocorrências de esgoto
            entupido.
          </p>
        </div>
      </header>

      <div className="page-placeholder">
        <h2>Módulo indisponível</h2>
        <p>
          O módulo de <strong>Esgoto Entupido</strong> ainda não está
          disponível. Em breve será possível cadastrar e controlar as
          ocorrências registradas.
        </p>
      </div>
    </section>
  );
}

export default EsgotoEntupido;
