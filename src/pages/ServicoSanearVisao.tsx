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
  arrayUnion,
} from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import { extractFirstFileObjectUrlFromZipUrl, isZipReference } from "../lib/storageZip";
import { SLA_CONFIGS, getSlaHorasFromOrder } from "../lib/sla";
import { registrarAuditoriaOs } from "../lib/auditoria";
import {
  formatOrdemStatusLabel,
  getOrdemStatusCssClass,
  isOrdemAberta,
  isOrdemCancelada,
  isOrdemConcluida,
} from "../lib/status";
import { AppPagination } from "../components/ui";
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
  slaServico?: string | null;

  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;
  ordemServicoPdfUrl?: string | null;
  ordemServicoPdfPath?: string | null;
  ordemServicoPdfCompactado?: boolean | null;
  ordemServicoPdfMimeTypeOriginal?: string | null;

  tipoCaminhaoExecucao?: TipoCaminhaoExecucao | null;
  tipoCaminhaoExecucaoLabel?: string | null;
  finalizadoPorEmail?: string | null;
};

const COLLECTION_NAME = "ordensHidrojato";
const STORAGE_BUCKET = "os-arquivos";

function isDoneStatus(status?: string | null): boolean {
  return isOrdemConcluida(status);
}

function isCanceledStatus(status?: string | null): boolean {
  return isOrdemCancelada(status);
}

function isOpenStatus(status?: string | null): boolean {
  return isOrdemAberta(status);
}

function statusClass(status?: string | null): string {
  return getOrdemStatusCssClass(status);
}

function formatStatusLabel(status?: string | null): string {
  return formatOrdemStatusLabel(status, { uppercase: true });
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
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

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
            slaServico: raw.slaServico ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
            ordemServicoPdfUrl: raw.ordemServicoPdfUrl ?? pdfNested?.url ?? null,
            ordemServicoPdfPath: raw.ordemServicoPdfPath ?? pdfNested?.path ?? null,
            ordemServicoPdfCompactado:
              raw.ordemServicoPdfCompactado ??
              raw.ordemServicoPdfCompactadoZip ??
              pdfNested?.compactado ??
              pdfNested?.compactadoZip ??
              false,
            ordemServicoPdfMimeTypeOriginal:
              raw.ordemServicoPdfMimeTypeOriginal ??
              pdfNested?.mimeTypeOriginal ??
              "application/pdf",
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

  useEffect(() => {
    if (!statusMessage) return;

    const timer = window.setTimeout(() => {
      setStatusMessage(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [statusMessage]);

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

  const totalCaminhaoProprio = useMemo(
    () => ordens.filter((os) => isDoneStatus(os.status) && String(os.tipoCaminhaoExecucao ?? "").toUpperCase() === "PROPRIO").length,
    [ordens]
  );

  const totalCaminhaoTerceirizado = useMemo(
    () => ordens.filter((os) => isDoneStatus(os.status) && String(os.tipoCaminhaoExecucao ?? "").toUpperCase() === "TERCEIRIZADO").length,
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

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  }, [filtradas.length, PAGE_SIZE]);

  const paginatedOrdens = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filtradas.slice(start, start + PAGE_SIZE);
  }, [filtradas, currentPage, PAGE_SIZE]);

  const paginationStart = filtradas.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const paginationEnd = Math.min(currentPage * PAGE_SIZE, filtradas.length);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusTab, busca]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  function handleOpenModal(os: FirestoreOS) {
    setModalOs(os);
    setTipoCaminhaoExecucao(os.tipoCaminhaoExecucao ?? "");
  }

  function handleCloseModal() {
    setModalOs(null);
    setTipoCaminhaoExecucao("");
  }

  async function resolveAttachedPdfUrl(os: FirestoreOS): Promise<{ url: string; shouldRevoke: boolean } | null> {
    const rawUrl = os.ordemServicoPdfUrl || null;
    const rawPath = os.ordemServicoPdfPath || null;
    const zipped =
      Boolean(os.ordemServicoPdfCompactado) ||
      isZipReference(rawUrl) ||
      isZipReference(rawPath);
    const originalMime = os.ordemServicoPdfMimeTypeOriginal || "application/pdf";

    if (rawUrl) {
      if (zipped) {
        const extracted = await extractFirstFileObjectUrlFromZipUrl(rawUrl, originalMime);
        return { url: extracted.url, shouldRevoke: true };
      }

      return { url: rawUrl, shouldRevoke: false };
    }

    if (rawPath) {
      const { data } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(rawPath);

      if (data.publicUrl) {
        if (zipped) {
          const extracted = await extractFirstFileObjectUrlFromZipUrl(data.publicUrl, originalMime);
          return { url: extracted.url, shouldRevoke: true };
        }

        return { url: data.publicUrl, shouldRevoke: false };
      }
    }

    if (os.ordemServicoPdfBase64) {
      return { url: base64PdfToObjectUrl(os.ordemServicoPdfBase64), shouldRevoke: true };
    }

    return null;
  }

  async function handleOpenPdf(os: FirestoreOS) {
    try {
      const pdf = await resolveAttachedPdfUrl(os);

      if (!pdf) {
        setInfoModal({
          title: "PDF não encontrado",
          message: "Esta OS de Hidrojato não possui PDF anexado.",
        });
        return;
      }

      window.open(pdf.url, "_blank", "noopener,noreferrer");

      if (pdf.shouldRevoke) {
        window.setTimeout(() => URL.revokeObjectURL(pdf.url), 60_000);
      }
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Não foi possível abrir o PDF",
        message: "O anexo pode estar compactado ou indisponível no armazenamento. Tente novamente em alguns instantes.",
      });
    }
  }

  async function handleReabrirServico() {
    if (!modalOs) return;

    if (!isDoneStatus(modalOs.status)) {
      setInfoModal({
        title: "OS já está aberta",
        message: "Esta ordem já está disponível para execução.",
      });
      return;
    }

    const motivoInformado = window.prompt(
      "Informe o motivo da reabertura da OS:",
      "Correção ou nova finalização necessária."
    );

    if (motivoInformado === null) return;

    const motivoReabertura = motivoInformado.trim();
    if (!motivoReabertura) {
      setInfoModal({
        title: "Motivo obrigatório",
        message: "Informe o motivo da reabertura antes de continuar.",
      });
      return;
    }

    const confirmar = window.confirm(
      "Deseja reabrir esta OS? A execução atual será preservada no histórico e a OS ficará disponível para nova finalização."
    );

    if (!confirmar) return;

    try {
      setIsUpdating(true);

      const temExecucaoAnterior =
        !!modalOs.dataExecucao ||
        !!modalOs.finalizadoPorEmail ||
        !!modalOs.tipoCaminhaoExecucao ||
        !!modalOs.tipoCaminhaoExecucaoLabel;

      const historicoExecucao = {
        tipo: "REABERTURA_EXECUCAO",
        statusAnterior: modalOs.status ?? null,
        dataExecucao: modalOs.dataExecucao ?? null,
        tipoCaminhaoExecucao: modalOs.tipoCaminhaoExecucao ?? null,
        tipoCaminhaoExecucaoLabel: modalOs.tipoCaminhaoExecucaoLabel ?? null,
        finalizadoPorEmail: modalOs.finalizadoPorEmail ?? null,
        motivoReabertura,
        reabertaEm: Timestamp.now(),
        reabertaPorEmail: auth.currentUser?.email ?? null,
        reabertaPorUid: auth.currentUser?.uid ?? null,
      };

      await updateDoc(doc(db, COLLECTION_NAME, modalOs.id), {
        status: "ABERTA",
        dataExecucao: null,
        tipoCaminhaoExecucao: null,
        tipoCaminhaoExecucaoLabel: null,
        finalizadoPorArea: null,
        finalizadoPorEmail: null,
        finalizadoPorUid: null,
        reabertaEm: serverTimestamp(),
        reabertaPorEmail: auth.currentUser?.email ?? null,
        reabertaPorUid: auth.currentUser?.uid ?? null,
        motivoUltimaReabertura: motivoReabertura,
        ...(temExecucaoAnterior ? { historicoExecucoes: arrayUnion(historicoExecucao) } : {}),
        updatedAt: serverTimestamp(),
      });

      void registrarAuditoriaOs({
        osId: modalOs.id,
        origem: "hidrojato",
        collectionName: COLLECTION_NAME,
        acao: "REABERTURA_OS",
        titulo: "OS de Hidrojato reaberta",
        descricao: motivoReabertura,
        statusAntes: modalOs.status ?? null,
        statusDepois: "ABERTA",
        detalhes: { execucaoAnteriorPreservada: temExecucaoAnterior },
      });

      setModalOs((prev) =>
        prev
          ? {
              ...prev,
              status: "ABERTA",
              dataExecucao: null,
              tipoCaminhaoExecucao: null,
              tipoCaminhaoExecucaoLabel: null,
              finalizadoPorEmail: null,
            }
          : prev
      );
      setTipoCaminhaoExecucao("");
      setStatusType("success");
      setStatusMessage(
        temExecucaoAnterior
          ? "OS reaberta com sucesso. A execução anterior foi preservada no histórico."
          : "OS reaberta com sucesso."
      );
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao reabrir",
        message: "Não foi possível reabrir esta OS. Verifique sua conexão e tente novamente.",
      });
    } finally {
      setIsUpdating(false);
    }
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

      void registrarAuditoriaOs({
        osId: modalOs.id,
        origem: "hidrojato",
        collectionName: COLLECTION_NAME,
        acao: "FINALIZACAO_SANEAR",
        titulo: "OS de Hidrojato finalizada",
        descricao: `Serviço registrado como ${label.toLowerCase()}.`,
        statusAntes: modalOs.status ?? null,
        statusDepois: "CONCLUIDA",
        detalhes: { tipoCaminhaoExecucao, tipoCaminhaoExecucaoLabel: label },
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

          <div className="servico-sanear-hero-mini">
            <span><b>{totalCaminhaoProprio}</b> próprio(s)</span>
            <span><b>{totalCaminhaoTerceirizado}</b> terceirizado(s)</span>
            <span><b>{totalConcluidas}</b> finalizada(s)</span>
          </div>
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
            prazo de <strong>{SLA_CONFIGS.HIDROJATO.horas} horas úteis</strong> para Hidrojato e controle por status.
          </p>
        </div>
      </div>

      <div className="os-kpi-row">
        <div className="os-kpi-card servico-sanear-kpi is-open">
          <div>
            <div className="os-kpi-label">OS em aberto</div>
            <div className="os-kpi-value">{totalAbertas}</div>
          </div>
          <span className="os-kpi-pill">Aguardando execução</span>
        </div>

        <div className="os-kpi-card servico-sanear-kpi is-done">
          <div>
            <div className="os-kpi-label">OS concluídas</div>
            <div className="os-kpi-value">{totalConcluidas}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-success">Finalizadas</span>
        </div>

        <div className="os-kpi-card servico-sanear-kpi is-total">
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

            <AppPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filtradas.length}
              pageStart={paginationStart}
              pageEnd={paginationEnd}
              onPageChange={setCurrentPage}
              variant="top"
              label="OS"
            />

            <div className="os-list">
              {paginatedOrdens.map((os) => (
                <article
                  key={os.id}
                  className={`os-card servico-sanear-os-card ${isDoneStatus(os.status) ? "is-done" : "is-open"}`}
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
                  <div className="os-card-header servico-sanear-card-header">
                    <div>
                      <span className="servico-sanear-card-eyebrow">Caminhão Hidrojato</span>
                      <h3>{getIdentificacao(os)}</h3>
                      <p className="os-card-address">{getEndereco(os)}</p>
                    </div>
                    <div className="servico-sanear-status-area">
                      <span className={statusClass(os.status)}>
                        {formatStatusLabel(os.status)}
                      </span>
                      {os.ordemServicoPdfUrl || os.ordemServicoPdfBase64 ? (
                        <span className="servico-sanear-pdf-chip">PDF anexado</span>
                      ) : (
                        <span className="servico-sanear-pdf-chip is-missing">Sem PDF</span>
                      )}
                    </div>
                  </div>

                  <div className="servico-sanear-card-info">
                    <div>
                      <span>Criada</span>
                      <strong>{formatDateTime(os.createdAt)}</strong>
                    </div>
                    <div>
                      <span>Prazo</span>
                      <strong>{getSlaHorasFromOrder(os)}h úteis</strong>
                    </div>
                    <div>
                      <span>Execução</span>
                      <strong>{formatDateTime(os.dataExecucao)}</strong>
                    </div>
                    <div>
                      <span>Caminhão</span>
                      <strong>{getCaminhaoLabel(os.tipoCaminhaoExecucao)}</strong>
                    </div>
                  </div>

                  {os.createdByEmail && (
                    <div className="servico-sanear-created-by">Responsável pelo cadastro: {os.createdByEmail}</div>
                  )}

                  <div className="servico-sanear-card-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleOpenPdf(os);
                      }}
                    >
                      Abrir PDF
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleOpenModal(os);
                      }}
                    >
                      {isDoneStatus(os.status) ? "Ver detalhes" : "Finalizar"}
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <AppPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filtradas.length}
              onPageChange={setCurrentPage}
              variant="bottom"
              label="OS"
            />
          </section>
        )}
      </div>

      {modalOs && (
        <div className="modal-backdrop" onClick={handleCloseModal}>
          <div className="modal servico-sanear-modal" style={{ maxWidth: 900, width: "94%" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header servico-sanear-modal-header">
              <div>
                <span className="servico-sanear-card-eyebrow">Área de Serviço SANEAR</span>
                <h3 className="modal-title">OS de Caminhão Hidrojato</h3>
                <p className="page-section-description" style={{ margin: "0.25rem 0 0" }}>
                  {getIdentificacao(modalOs)} • {formatStatusLabel(modalOs.status)}
                </p>
              </div>
              <span className={statusClass(modalOs.status)}>{formatStatusLabel(modalOs.status)}</span>
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

              {isDoneStatus(modalOs.status) ? (
                <div className="page-section servico-sanear-execution-summary">
                  <h3>Resumo da execução</h3>
                  <p className="page-section-description">
                    Esta OS já foi finalizada. Para alterar dados de execução, reabra a OS primeiro.
                  </p>
                  <div className="servico-sanear-summary-grid">
                    <div>
                      <span>Serviço feito por</span>
                      <strong>{modalOs.tipoCaminhaoExecucaoLabel || getCaminhaoLabel(modalOs.tipoCaminhaoExecucao)}</strong>
                    </div>
                    <div>
                      <span>Finalizada em</span>
                      <strong>{formatDateTime(modalOs.dataExecucao)}</strong>
                    </div>
                    <div>
                      <span>Finalizada por</span>
                      <strong>{modalOs.finalizadoPorEmail || "-"}</strong>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="page-section">
                  <h3>Finalização interna</h3>
                  <p className="page-section-description">
                    Antes de finalizar, informe qual caminhão executou o serviço. Essa informação
                    ficará gravada na OS e poderá ser conferida na listagem e no backup.
                  </p>

                  <div className="page-field">
                    <label>Serviço feito por</label>
                    <div className="truck-choice-grid" role="group" aria-label="Tipo de caminhão da execução">
                      <button
                        type="button"
                        className={`truck-choice-card ${tipoCaminhaoExecucao === "PROPRIO" ? "is-selected" : ""}`}
                        onClick={() => setTipoCaminhaoExecucao("PROPRIO")}
                        disabled={isUpdating}
                      >
                        <span>🚛</span>
                        <strong>Caminhão próprio</strong>
                        <small>Equipe e veículo da SANEAR</small>
                      </button>

                      <button
                        type="button"
                        className={`truck-choice-card ${tipoCaminhaoExecucao === "TERCEIRIZADO" ? "is-selected" : ""}`}
                        onClick={() => setTipoCaminhaoExecucao("TERCEIRIZADO")}
                        disabled={isUpdating}
                      >
                        <span>🤝</span>
                        <strong>Caminhão terceirizado</strong>
                        <small>Apoio contratado para execução</small>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer servico-sanear-modal-footer">
              <button type="button" className="btn-secondary" onClick={() => handleOpenPdf(modalOs)}>
                Abrir PDF da OS
              </button>
              <button type="button" className="btn-secondary" onClick={() => window.print()}>
                Imprimir
              </button>
              {isDoneStatus(modalOs.status) ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleReabrirServico}
                  disabled={isUpdating}
                >
                  {isUpdating ? "Reabrindo..." : "Reabrir OS"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleFinalizarServico}
                  disabled={isUpdating}
                >
                  {isUpdating ? "Finalizando..." : "Finalizar serviço"}
                </button>
              )}
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
