// src/pages/ServicoSanearVisao.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { SLA_HORAS_PADRAO } from "../lib/sla";
import "./TerceirizadaVisao.css";

type TipoCaminhaoExecucao = "PROPRIO" | "TERCEIRIZADO";
type StatusTab = "OPEN" | "DONE" | "ALL";
type StatusType = "success" | "error" | "info";

type FirestoreOS = {
  id: string;
  tipo?: string | null;
  protocolo?: string | null;
  ordemServico?: string | null;
  bairro?: string | null;
  rua?: string | null;
  numero?: string | null;
  pontoReferencia?: string | null;
  referencia?: string | null;
  observacoes?: string | null;
  status?: string | null;
  createdAt?: Timestamp | null;
  createdByEmail?: string | null;
  dataExecucao?: Timestamp | null;
  updatedAt?: Timestamp | null;
  slaHoras?: number | null;

  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;
  ordemServicoPdfUrl?: string | null;
  ordemServicoPdfPath?: string | null;

  tipoCaminhaoExecucao?: TipoCaminhaoExecucao | null;
  tipoCaminhaoExecucaoLabel?: string | null;
  finalizadoPorEmail?: string | null;
};

const COLLECTION_NAME = "ordensHidrojato";

function normalizeStatusValue(status?: string | null): string {
  return String(status ?? "").trim().toUpperCase();
}

function isDoneStatus(status?: string | null): boolean {
  const s = normalizeStatusValue(status);
  return s === "CONCLUIDA" || s === "CONCLUÍDA" || s === "CONCLUIDO";
}

function isCanceledStatus(status?: string | null): boolean {
  const s = normalizeStatusValue(status);
  return s === "CANCELADA" || s === "CANCELADO";
}

function isOpenStatus(status?: string | null): boolean {
  return !isDoneStatus(status) && !isCanceledStatus(status);
}

function statusClass(status?: string | null): string {
  const s = normalizeStatusValue(status);
  if (s === "CONCLUIDA" || s === "CONCLUÍDA" || s === "CONCLUIDO") {
    return "os-status-badge os-status-concluida";
  }
  if (s === "ANDAMENTO" || s === "EM_ANDAMENTO") {
    return "os-status-badge os-status-andamento";
  }
  if (s === "AGUARDANDO_SANEAR") {
    return "os-status-badge os-status-aguardando-sanear";
  }
  if (s === "CANCELADA" || s === "CANCELADO") {
    return "os-status-badge os-status-cancelada";
  }
  return "os-status-badge os-status-aberta";
}

function formatStatusLabel(status?: string | null): string {
  const s = normalizeStatusValue(status);

  const labels: Record<string, string> = {
    ABERTA: "ABERTA",
    ANDAMENTO: "EM ANDAMENTO",
    EM_ANDAMENTO: "EM ANDAMENTO",
    AGUARDANDO_SANEAR: "AGUARDANDO SANEAR",
    CONCLUIDA: "CONCLUÍDA",
    "CONCLUÍDA": "CONCLUÍDA",
    CONCLUIDO: "CONCLUÍDA",
    CANCELADA: "CANCELADA",
    CANCELADO: "CANCELADA",
  };

  return labels[s] || s.replaceAll("_", " ") || "ABERTA";
}

function formatDateTime(value?: Timestamp | null): string {
  if (!value) return "-";
  try {
    return value.toDate().toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function getCaminhaoLabel(tipo?: TipoCaminhaoExecucao | string | null): string {
  const normalized = String(tipo ?? "").toUpperCase();
  if (normalized === "PROPRIO") return "Caminhão próprio";
  if (normalized === "TERCEIRIZADO") return "Caminhão terceirizado";
  return "-";
}

function getIdentificacao(os: FirestoreOS): string {
  return os.ordemServico || os.protocolo || "Sem identificação";
}

function getEndereco(os: FirestoreOS): string {
  return (
    [os.rua, os.numero ? `nº ${os.numero}` : "", os.bairro ? `– ${os.bairro}` : ""]
      .filter(Boolean)
      .join(" ") || "Endereço não informado"
  );
}

function base64PdfToObjectUrl(base64: string): string {
  const clean = base64.includes(",") ? base64.split(",").pop() || "" : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  return URL.createObjectURL(blob);
}

const ServicoSanearVisao: React.FC = () => {
  const [ordens, setOrdens] = useState<FirestoreOS[]>([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("OPEN");
  const [modalOs, setModalOs] = useState<FirestoreOS | null>(null);
  const [tipoCaminhaoExecucao, setTipoCaminhaoExecucao] =
    useState<TipoCaminhaoExecucao | "">("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");
  const [infoModal, setInfoModal] = useState<{ title: string; message: string } | null>(null);

  useEffect(() => {
    const qHidrojato = query(
      collection(db, COLLECTION_NAME),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      qHidrojato,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = raw.ordemServicoPdf ?? null;

          return {
            id: d.id,
            tipo: raw.tipo || "HIDROJATO",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,
            bairro: raw.bairro ?? raw.bairroLocal ?? raw.bairro_os ?? null,
            rua: raw.rua ?? raw.logradouro ?? raw.ruaAvenida ?? null,
            numero: raw.numero ?? raw.numeroCasa ?? null,
            pontoReferencia: raw.pontoReferencia ?? raw.referencia ?? raw.ponto ?? null,
            referencia: raw.referencia ?? null,
            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            updatedAt: raw.updatedAt ?? null,
            slaHoras: raw.slaHoras ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
            ordemServicoPdfUrl: raw.ordemServicoPdfUrl ?? pdfNested?.url ?? null,
            ordemServicoPdfPath: raw.ordemServicoPdfPath ?? pdfNested?.path ?? null,
            tipoCaminhaoExecucao: raw.tipoCaminhaoExecucao ?? null,
            tipoCaminhaoExecucaoLabel: raw.tipoCaminhaoExecucaoLabel ?? null,
            finalizadoPorEmail: raw.finalizadoPorEmail ?? null,
          };
        });

        setOrdens(data);
        setLoading(false);
        setStatusMessage(null);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatusType("error");
        setStatusMessage(
          "Não foi possível carregar as ordens de Caminhão Hidrojato. Verifique sua conexão e tente novamente."
        );
      }
    );

    return () => unsubscribe();
  }, []);

  const totalAbertas = useMemo(
    () => ordens.filter((os) => isOpenStatus(os.status)).length,
    [ordens]
  );

  const totalConcluidas = useMemo(
    () => ordens.filter((os) => isDoneStatus(os.status)).length,
    [ordens]
  );

  const totalCanceladas = useMemo(
    () => ordens.filter((os) => isCanceledStatus(os.status)).length,
    [ordens]
  );

  const filtradas = useMemo(() => {
    const porStatus = ordens.filter((os) => {
      if (statusTab === "ALL") return true;
      if (statusTab === "DONE") return isDoneStatus(os.status);
      return isOpenStatus(os.status);
    });

    const texto = busca.trim().toLowerCase();
    if (!texto) return porStatus;

    return porStatus.filter((os) => {
      const dataCriacao = formatDateTime(os.createdAt).toLowerCase();
      const dataExecucao = formatDateTime(os.dataExecucao).toLowerCase();
      const tipoCaminhao = getCaminhaoLabel(os.tipoCaminhaoExecucao).toLowerCase();

      return (
        os.protocolo?.toLowerCase().includes(texto) ||
        os.ordemServico?.toLowerCase().includes(texto) ||
        os.bairro?.toLowerCase().includes(texto) ||
        os.rua?.toLowerCase().includes(texto) ||
        os.numero?.toLowerCase().includes(texto) ||
        os.pontoReferencia?.toLowerCase().includes(texto) ||
        dataCriacao.includes(texto) ||
        dataExecucao.includes(texto) ||
        tipoCaminhao.includes(texto)
      );
    });
  }, [ordens, statusTab, busca]);

  function handleOpenModal(os: FirestoreOS) {
    setModalOs(os);
    setTipoCaminhaoExecucao(os.tipoCaminhaoExecucao ?? "");
  }

  function handleCloseModal() {
    setModalOs(null);
    setTipoCaminhaoExecucao("");
  }

  function handleOpenPdf(os: FirestoreOS) {
    if (os.ordemServicoPdfUrl) {
      window.open(os.ordemServicoPdfUrl, "_blank", "noopener,noreferrer");
      return;
    }

    if (os.ordemServicoPdfBase64) {
      const url = base64PdfToObjectUrl(os.ordemServicoPdfBase64);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }

    setInfoModal({
      title: "PDF não encontrado",
      message: "Esta OS de Hidrojato não possui PDF anexado.",
    });
  }

  async function handleFinalizarServico() {
    if (!modalOs) return;

    if (isDoneStatus(modalOs.status)) {
      setInfoModal({
        title: "OS já concluída",
        message: "Esta ordem já está marcada como concluída.",
      });
      return;
    }

    if (!tipoCaminhaoExecucao) {
      setInfoModal({
        title: "Informe o tipo de caminhão",
        message:
          "Antes de finalizar, selecione se o serviço foi feito por caminhão próprio ou caminhão terceirizado.",
      });
      return;
    }

    const label = getCaminhaoLabel(tipoCaminhaoExecucao);

    try {
      setIsUpdating(true);

      await updateDoc(doc(db, COLLECTION_NAME, modalOs.id), {
        status: "CONCLUIDA",
        dataExecucao: serverTimestamp(),
        updatedAt: serverTimestamp(),
        tipoCaminhaoExecucao,
        tipoCaminhaoExecucaoLabel: label,
        finalizadoPorArea: "SERVICO_SANEAR",
        finalizadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
        finalizadoPorUid: auth.currentUser?.uid ?? null,
      });

      const execTimestamp = Timestamp.now();
      setModalOs((prev) =>
        prev
          ? {
              ...prev,
              status: "CONCLUIDA",
              dataExecucao: execTimestamp,
              tipoCaminhaoExecucao,
              tipoCaminhaoExecucaoLabel: label,
              finalizadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
            }
          : prev
      );

      setStatusType("success");
      setStatusMessage(`OS finalizada como ${label}.`);
      setInfoModal({
        title: "Serviço finalizado",
        message: `A OS foi concluída e registrada como executada por ${label.toLowerCase()}.`,
      });
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao finalizar",
        message:
          "Não foi possível finalizar a OS de Hidrojato. Verifique sua conexão e tente novamente.",
      });
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <section className="page-card terceirizada-page servico-sanear-page">
      <header className="page-header">
        <div>
          <h2>Área de Serviço SANEAR</h2>
          <p className="page-section-description">
            Área interna para acompanhamento e finalização das ordens de Caminhão Hidrojato.
            Essas ordens não são enviadas para a Área da Terceirizada.
          </p>
        </div>
      </header>

      <div className="terceirizada-banner">
        <div>
          <span className="terceirizada-pill">SERVIÇO INTERNO SANEAR</span>
          <h2>Caminhão Hidrojato</h2>
          <p>
            Consulte a OS em PDF, acompanhe o prazo de atendimento e finalize informando
            se a execução foi realizada com caminhão próprio ou caminhão terceirizado.
          </p>
        </div>

        <div className="terceirizada-highlight">
          <div className="terceirizada-icon">🚛</div>
          <div>
            <span>Fila interna</span>
            <strong>{totalAbertas} OS aberta(s)</strong>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>{statusMessage}</div>
      )}

      <div className="sla-explainer" role="note">
        <div className="sla-explainer-icon" aria-hidden="true">
          ⏱
        </div>
        <div className="sla-explainer-content">
          <div className="sla-explainer-title">Prazo de atendimento</div>
          <p className="sla-explainer-text">
            As ordens de Hidrojato seguem o mesmo padrão operacional do sistema, com prazo
            padrão de <strong>{SLA_HORAS_PADRAO} horas úteis</strong> e controle por status.
          </p>
        </div>
      </div>

      <div className="os-kpi-row">
        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">OS em aberto</div>
            <div className="os-kpi-value">{totalAbertas}</div>
          </div>
          <span className="os-kpi-pill">Aguardando execução</span>
        </div>

        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">OS concluídas</div>
            <div className="os-kpi-value">{totalConcluidas}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-success">Finalizadas</span>
        </div>

        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">Total de OS</div>
            <div className="os-kpi-value">{ordens.length}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-neutral">
            {totalCanceladas > 0 ? `${totalCanceladas} cancelada(s)` : "Atualizado em tempo real"}
          </span>
        </div>
      </div>

      <div className="os-toolbar">
        <div className="os-status-tabs" style={{ marginBottom: "0.5rem" }}>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "OPEN" ? "is-active" : ""}`}
            onClick={() => setStatusTab("OPEN")}
          >
            Abertas ({totalAbertas})
          </button>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "DONE" ? "is-active" : ""}`}
            onClick={() => setStatusTab("DONE")}
          >
            Concluídas ({totalConcluidas})
          </button>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "ALL" ? "is-active" : ""}`}
            onClick={() => setStatusTab("ALL")}
          >
            Todas ({ordens.length})
          </button>
        </div>

        <div className="os-search">
          <input
            className="os-search-input"
            type="text"
            placeholder="Buscar por protocolo, OS, bairro, rua, número, data ou tipo de caminhão..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
      </div>

      <div className="os-main">
        {loading && <div className="os-empty">Carregando ordens de Hidrojato...</div>}

        {!loading && filtradas.length === 0 && (
          <div className="os-empty">Nenhuma ordem encontrada para os filtros atuais.</div>
        )}

        {!loading && filtradas.length > 0 && (
          <section className="os-group-section">
            <div className="os-group-header">
              <div>
                <span className="os-badge os-badge-asfalto">Caminhão Hidrojato</span>
              </div>
              <span className="os-group-count">
                {filtradas.length} OS {statusTab === "OPEN" ? "em aberto" : statusTab === "DONE" ? "concluída(s)" : "encontrada(s)"}
              </span>
            </div>

            <div className="os-list">
              {filtradas.map((os) => (
                <article
                  key={os.id}
                  className="os-card"
                  onClick={() => handleOpenModal(os)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleOpenModal(os);
                    }
                  }}
                >
                  <div className="os-card-header">
                    <div>
                      <h3>{getIdentificacao(os)}</h3>
                      <p className="os-card-address">{getEndereco(os)}</p>
                    </div>
                    <div>
                      <span className={statusClass(os.status)}>
                        {formatStatusLabel(os.status)}
                      </span>
                    </div>
                  </div>

                  <div className="os-card-meta">
                    <span>Criado em {formatDateTime(os.createdAt)}</span>
                    {isDoneStatus(os.status) && (
                      <span>Execução: {getCaminhaoLabel(os.tipoCaminhaoExecucao)}</span>
                    )}
                    {os.createdByEmail && <span>Por {os.createdByEmail}</span>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>

      {modalOs && (
        <div className="modal-backdrop" onClick={handleCloseModal}>
          <div className="modal" style={{ maxWidth: 900, width: "94%" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">OS de Caminhão Hidrojato</h3>
                <p className="page-section-description" style={{ margin: "0.25rem 0 0" }}>
                  {getIdentificacao(modalOs)}
                </p>
              </div>
              <button type="button" className="modal-close" onClick={handleCloseModal}>
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="page-section">
                <h3>Dados da OS</h3>
                <div className="page-form-grid">
                  <div className="page-field">
                    <label>Protocolo</label>
                    <input className="field-readonly" value={modalOs.protocolo || "-"} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Ordem de Serviço</label>
                    <input className="field-readonly" value={modalOs.ordemServico || "-"} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Status atual</label>
                    <input className="field-readonly" value={formatStatusLabel(modalOs.status)} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Data de criação</label>
                    <input className="field-readonly" value={formatDateTime(modalOs.createdAt)} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Data de execução</label>
                    <input className="field-readonly" value={formatDateTime(modalOs.dataExecucao)} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Execução registrada</label>
                    <input
                      className="field-readonly"
                      value={
                        modalOs.tipoCaminhaoExecucaoLabel ||
                        getCaminhaoLabel(modalOs.tipoCaminhaoExecucao)
                      }
                      readOnly
                    />
                  </div>
                </div>
              </div>

              <div className="page-section">
                <h3>Local do serviço</h3>
                <div className="page-form-grid">
                  <div className="page-field">
                    <label>Bairro</label>
                    <input className="field-readonly" value={modalOs.bairro || "-"} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Rua / Avenida</label>
                    <input className="field-readonly" value={modalOs.rua || "-"} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Número</label>
                    <input className="field-readonly" value={modalOs.numero || "-"} readOnly />
                  </div>

                  <div className="page-field">
                    <label>Ponto de referência</label>
                    <input className="field-readonly" value={modalOs.pontoReferencia || "-"} readOnly />
                  </div>
                </div>
              </div>

              <div className="page-field">
                <label>Observações</label>
                <textarea className="field-readonly" value={modalOs.observacoes || "-"} readOnly rows={3} />
              </div>

              <div className="page-section">
                <h3>Finalização interna</h3>
                <p className="page-section-description">
                  Antes de finalizar, informe qual caminhão executou o serviço. Essa informação
                  ficará gravada na OS e poderá ser conferida na listagem e no backup.
                </p>

                <div className="page-field">
                  <label>Serviço feito por</label>
                  <select
                    className="field-readonly"
                    value={tipoCaminhaoExecucao}
                    onChange={(e) =>
                      setTipoCaminhaoExecucao(e.target.value as TipoCaminhaoExecucao | "")
                    }
                    disabled={isDoneStatus(modalOs.status) || isUpdating}
                  >
                    <option value="">Selecione...</option>
                    <option value="PROPRIO">Caminhão próprio</option>
                    <option value="TERCEIRIZADO">Caminhão terceirizado</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => handleOpenPdf(modalOs)}>
                Abrir PDF da OS
              </button>
              <button type="button" className="btn-secondary" onClick={() => window.print()}>
                Imprimir
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleFinalizarServico}
                disabled={isUpdating || isDoneStatus(modalOs.status)}
              >
                {isUpdating
                  ? "Finalizando..."
                  : isDoneStatus(modalOs.status)
                  ? "Serviço já finalizado"
                  : "Finalizar serviço"}
              </button>
            </div>
          </div>
        </div>
      )}

      {infoModal && (
        <div className="modal-backdrop" onClick={() => setInfoModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{infoModal.title}</h3>
              <button type="button" className="modal-close" onClick={() => setInfoModal(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>{infoModal.message}</p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-primary" onClick={() => setInfoModal(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default ServicoSanearVisao;
