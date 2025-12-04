import type { ReactElement } from "react";

function CaminhaoHidrojato(): ReactElement {
  return (
    <section className="page-card">
      <header className="page-header">
        <div>
          <h2>Caminhão Hidrojato</h2>
          <p>
            Módulo para cadastro e controle de serviços executados com caminhão
            hidrojato.
          </p>
        </div>
      </header>

      <div className="page-placeholder">
        <h2>Módulo indisponível</h2>
        <p>
          O módulo de <strong>Caminhão Hidrojato</strong> ainda não está
          disponível. Em breve será possível cadastrar e acompanhar os serviços
          executados com este equipamento.
        </p>
      </div>
    </section>
  );
}

export default CaminhaoHidrojato;
