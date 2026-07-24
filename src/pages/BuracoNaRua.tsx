import React, { useState, type ChangeEvent, type FormEvent } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  setDoc,
  updateDoc,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import { compactFileToZip, ZIP_STORAGE_MIME } from "../lib/storageZip";
import {
  extrairDadosOsDoPdf,
  type DadosOsExtraidos,
  type ResultadoExtracaoPdfOs,
} from "../lib/pdfOsExtractor";

import { getSlaConfig, getSlaHorasPorServico } from "../lib/sla";
import { salvarAnexoPendente, resumirErroAnexo } from "../lib/anexosPendentes";
type BuracoNaRuaProps = {
  onBack: () => void;
};

type PdfAnexado = {
  file: File;
  nomeArquivo: string;
  dataAnexoTexto: string;
};

type StatusType = "success" | "error" | "info";

const STORAGE_BUCKET = "os-arquivos";

function sanitizeForStoragePath(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

const FORM_STEPS = [
  { id: "identificacao", label: "Identificação", short: "ID" },
  { id: "local", label: "Local", short: "Local" },
  { id: "detalhes", label: "Detalhes", short: "Obs." },
  { id: "anexos", label: "PDF", short: "PDF" },
  { id: "confirmacao", label: "Confirmar", short: "OK" },
] as const;

type FormStep = (typeof FORM_STEPS)[number]["id"];

type CampoForm =
  | "protocolo"
  | "ordemServico"
  | "bairro"
  | "rua"
  | "numero"
  | "referencia"
  | "observacoes"
  | "pdfOs";

const LABELS_CAMPOS: Record<CampoForm, string> = {
  protocolo: "Protocolo",
  ordemServico: "Ordem de Serviço",
  bairro: "Bairro",
  rua: "Rua / Avenida",
  numero: "Número",
  referencia: "Ponto de referência",
  observacoes: "Observações",
  pdfOs: "OS em PDF",
};

const BuracoNaRua: React.FC<BuracoNaRuaProps> = ({ onBack }) => {
  const [protocolo, setProtocolo] = useState("");
  const [ordemServico, setOrdemServico] = useState("");
  const [bairro, setBairro] = useState("");
  const [rua, setRua] = useState("");
  const [numero, setNumero] = useState("");
  const [referencia, setReferencia] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [pdfOs, setPdfOs] = useState<PdfAnexado | null>(null);
  const [extractingPdf, setExtractingPdf] = useState(false);
  const [pdfExtraction, setPdfExtraction] =
    useState<ResultadoExtracaoPdfOs | null>(null);
  const [formularioLiberado, setFormularioLiberado] = useState(false);

  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");

  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [showMissingFieldsModal, setShowMissingFieldsModal] = useState(false);
  const [camposAusentes, setCamposAusentes] = useState<string[]>([]);

  // Modal de resultado (sucesso/erro ao salvar)
  const [showResultModal, setShowResultModal] = useState(false);
  const [resultType, setResultType] = useState<"success" | "error">("success");
  const [resultMessage, setResultMessage] = useState("");

  const [mobileStep, setMobileStep] = useState<FormStep>("anexos");
  const currentStepIndex = Math.max(
    0,
    FORM_STEPS.findIndex((step) => step.id === mobileStep)
  );
  const isLastMobileStep = currentStepIndex === FORM_STEPS.length - 1;

  function goToMobileStep(step: FormStep) {
    setMobileStep(step);
    setStatusMessage(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goToPreviousMobileStep() {
    const previous = FORM_STEPS[Math.max(0, currentStepIndex - 1)];
    goToMobileStep(previous.id);
  }

  function goToNextMobileStep() {
    const next = FORM_STEPS[Math.min(FORM_STEPS.length - 1, currentStepIndex + 1)];
    goToMobileStep(next.id);
  }

  function setStatus(msg: string, type: StatusType = "info") {
    setStatusMessage(msg);
    setStatusType(type);
  }

  function handleInputChange(campo: Exclude<CampoForm, "pdfOs">, value: string) {
    const upper = value.toLocaleUpperCase("pt-BR");

    switch (campo) {
      case "protocolo":
        setProtocolo(upper);
        break;
      case "ordemServico":
        setOrdemServico(upper);
        break;
      case "bairro":
        setBairro(upper);
        break;
      case "rua":
        setRua(upper);
        break;
      case "numero":
        setNumero(upper);
        break;
      case "referencia":
        setReferencia(upper);
        break;
      case "observacoes":
        setObservacoes(upper);
        break;
    }

  }

  function aplicarDadosExtraidos(dados: DadosOsExtraidos): string[] {
    const aplicados: string[] = [];

    const aplicar = (
      valor: string | undefined,
      atual: string,
      setter: (value: string) => void,
      label: string
    ) => {
      const normalizado = valor?.trim();
      if (!normalizado || atual.trim()) return;

      setter(normalizado.toLocaleUpperCase("pt-BR"));
      aplicados.push(label);
    };

    aplicar(dados.protocolo, protocolo, setProtocolo, "Protocolo");
    aplicar(dados.ordemServico, ordemServico, setOrdemServico, "Ordem de Serviço");
    aplicar(dados.bairro, bairro, setBairro, "Bairro");
    aplicar(dados.rua, rua, setRua, "Rua");
    aplicar(dados.numero, numero, setNumero, "Número");
    aplicar(dados.referencia, referencia, setReferencia, "Ponto de referência");
    aplicar(dados.observacoes, observacoes, setObservacoes, "Observações");

    return aplicados;
  }

  async function handlePdfChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setStatus("Somente arquivo PDF é permitido para a Ordem de Serviço.", "error");
      e.target.value = "";
      return;
    }

    const agora = new Date();
    const dataAnexoTexto = agora.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    setPdfOs({
      file,
      nomeArquivo: file.name,
      dataAnexoTexto,
    });
    setFormularioLiberado(true);
    setMobileStep("identificacao");
    setPdfExtraction(null);
    e.target.value = "";

    try {
      setExtractingPdf(true);
      const resultado = await extrairDadosOsDoPdf(file);
      setPdfExtraction(resultado);

      const aplicados = aplicarDadosExtraidos(resultado.dados);

      if (aplicados.length > 0) {
        setStatus(
          `PDF anexado e dados preenchidos automaticamente: ${aplicados.join(
            ", "
          )}. Confira antes de salvar.`,
          "success"
        );
        return;
      }

      if (resultado.aviso) {
        setStatus(`PDF anexado. ${resultado.aviso}`, "info");
        return;
      }

      setStatus(
        "PDF anexado. Nenhum campo vazio foi preenchido automaticamente.",
        "info"
      );
    } catch (error) {
      console.error(error);
      setStatus(
        "PDF anexado, mas não foi possível ler o texto automaticamente. Preencha ou confira os campos manualmente.",
        "info"
      );
    } finally {
      setExtractingPdf(false);
    }
  }

  function handleRemovePdf() {
    setPdfOs(null);
    setPdfExtraction(null);
    setExtractingPdf(false);
    setStatus("PDF removido.", "info");
  }

  function abrirFormularioManual() {
    setFormularioLiberado(true);
    setMobileStep("identificacao");
    setStatus("Preenchimento manual liberado. Você pode informar os dados sem usar o extrator do PDF.", "info");
  }

  // showInfo: se false, não mostra "Formulário limpo."
  function handleClear(showInfo: boolean = true) {
    setProtocolo("");
    setOrdemServico("");
    setBairro("");
    setRua("");
    setNumero("");
    setReferencia("");
    setObservacoes("");
    setPdfOs(null);
    setPdfExtraction(null);
    setExtractingPdf(false);
    setFormularioLiberado(false);
    setMobileStep("anexos");
    if (showInfo) {
      setStatus("Formulário limpo.", "info");
    }
  }

  function obterCamposAusentes(): string[] {
    const valores: Record<CampoForm, string> = {
      protocolo,
      ordemServico,
      bairro,
      rua,
      numero,
      referencia,
      observacoes,
      pdfOs: pdfOs ? "OK" : "",
    };

    return (Object.keys(valores) as CampoForm[])
      .filter((campo) => !valores[campo].trim())
      .map((campo) => LABELS_CAMPOS[campo]);
  }

  async function verificarDuplicidade(
    protocoloInformado: string,
    ordemServicoInformada: string
  ): Promise<string[]> {
    const duplicidades: string[] = [];
    const ordensRef = collection(db, "ordens_servico");

    if (protocoloInformado) {
      const protocoloSnapshot = await getDocs(
        query(
          ordensRef,
          where("protocolo", "==", protocoloInformado),
          limit(1)
        )
      );

      if (!protocoloSnapshot.empty) {
        duplicidades.push(`Protocolo ${protocoloInformado}`);
      }
    }

    if (ordemServicoInformada) {
      const ordemSnapshot = await getDocs(
        query(
          ordensRef,
          where("ordemServico", "==", ordemServicoInformada),
          limit(1)
        )
      );

      if (!ordemSnapshot.empty) {
        duplicidades.push(`Ordem de Serviço ${ordemServicoInformada}`);
      }
    }

    return duplicidades;
  }

  async function uploadPdf(ordemId: string): Promise<{
    url: string | null;
    path: string | null;
    nomeArquivo: string | null;
    dataAnexoTexto: string | null;
    arquivoCompactado: boolean;
    nomeArquivoZip: string | null;
    mimeTypeOriginal: string | null;
    tamanhoOriginal: number | null;
    tamanhoCompactado: number | null;
  }> {
    if (!pdfOs) {
      return {
        url: null,
        path: null,
        nomeArquivo: null,
        dataAnexoTexto: null,
        arquivoCompactado: false,
        nomeArquivoZip: null,
        mimeTypeOriginal: null,
        tamanhoOriginal: null,
        tamanhoCompactado: null,
      };
    }

    const compactado = await compactFileToZip(pdfOs.file);
    const safeName = sanitizeForStoragePath(compactado.zipFileName || "ordem-servico.pdf.zip");
    const path = `calcamento/${ordemId}/os-pdf/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, compactado.blob, {
        upsert: false,
        contentType: ZIP_STORAGE_MIME,
      });

    if (uploadError) {
      console.error(uploadError);
      throw new Error(`Erro ao enviar o PDF "${pdfOs.nomeArquivo}" compactado em ZIP para o armazenamento.`);
    }

    const { data: publicData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(path);

    return {
      url: publicData.publicUrl,
      path,
      nomeArquivo: pdfOs.nomeArquivo,
      dataAnexoTexto: pdfOs.dataAnexoTexto,
      arquivoCompactado: true,
      nomeArquivoZip: compactado.zipFileName,
      mimeTypeOriginal: compactado.originalMimeType,
      tamanhoOriginal: compactado.originalSize,
      tamanhoCompactado: compactado.zipSize,
    };
  }


  function getPdfDataVazio(): Awaited<ReturnType<typeof uploadPdf>> {
    return {
      url: null,
      path: null,
      nomeArquivo: null,
      dataAnexoTexto: null,
      arquivoCompactado: false,
      nomeArquivoZip: null,
      mimeTypeOriginal: null,
      tamanhoOriginal: null,
      tamanhoCompactado: null,
    };
  }

  async function handleSave(continuarComCamposVazios = false) {
    setStatusMessage(null);

    if (!continuarComCamposVazios) {
      const ausentes = obterCamposAusentes();

      if (ausentes.length > 0) {
        setCamposAusentes(ausentes);
        setShowMissingFieldsModal(true);
        return;
      }
    }

    const protocoloNormalizado = protocolo.trim().toLocaleUpperCase("pt-BR");
    const ordemServicoNormalizada = ordemServico
      .trim()
      .toLocaleUpperCase("pt-BR");

    try {
      setSaving(true);

      const duplicidades = await verificarDuplicidade(
        protocoloNormalizado,
        ordemServicoNormalizada
      );

      if (duplicidades.length > 0) {
        setResultType("error");
        setResultMessage(
          `Cadastro não realizado. Já existe uma ordem cadastrada com ${duplicidades.join(
            " e "
          )}.`
        );
        setShowResultModal(true);
        return;
      }

      const slaConfigCadastro = getSlaConfig("CALCAMENTO");

      const ordensRef = collection(db, "ordens_servico");
      const ordemRef = doc(ordensRef);
      const pdfDataVazio = getPdfDataVazio();
      const anexoInicial: "PENDENTE" | "SEM_ANEXO" = pdfOs ? "PENDENTE" : "SEM_ANEXO";

      await setDoc(ordemRef, {
        tipo: "BURACO_RUA",
        protocolo: protocoloNormalizado || null,
        ordemServico: ordemServicoNormalizada || null,
        bairro: bairro.trim() || null,
        rua: rua.trim() || null,
        numero: numero.trim() || null,
        pontoReferencia: referencia.trim() || null,
        referencia: referencia.trim() || null,
        observacoes: observacoes.trim() || null,
        status: "ABERTA",
        slaServico: "CALCAMENTO",
        slaLabel: slaConfigCadastro.label,
        slaPrioridade: slaConfigCadastro.prioridade,
        slaConfigVersao: 1,
        slaHoras: getSlaHorasPorServico("CALCAMENTO"),
        slaPausas: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByEmail: auth.currentUser?.email?.toLowerCase() ?? null,
        createdByUid: auth.currentUser?.uid ?? null,
        fotos: [],
        fotosExecucao: [],
        anexoStatus: anexoInicial,
        ordemServicoPdfStatus: anexoInicial,
        ordemServicoPdfPendenteId: null,
        anexosPendentes: [],
        ordemServicoPdfUrl: pdfDataVazio.url,
        ordemServicoPdfPath: pdfDataVazio.path,
        ordemServicoPdfNomeArquivo: pdfDataVazio.nomeArquivo,
        ordemServicoPdfDataAnexo: pdfDataVazio.dataAnexoTexto,
        ordemServicoPdfCompactado: pdfDataVazio.arquivoCompactado,
        ordemServicoPdfNomeArquivoZip: pdfDataVazio.nomeArquivoZip,
        ordemServicoPdfMimeTypeOriginal: pdfDataVazio.mimeTypeOriginal,
        ordemServicoPdfTamanhoOriginal: pdfDataVazio.tamanhoOriginal,
        ordemServicoPdfTamanhoCompactado: pdfDataVazio.tamanhoCompactado,
        ordemServicoPdf: null,
      });

      let anexoStatusFinal: "OK" | "PENDENTE" | "SEM_ANEXO" = pdfOs ? "PENDENTE" : "SEM_ANEXO";

      if (pdfOs) {
        try {
          const pdfData = await uploadPdf(ordemRef.id);

          await updateDoc(ordemRef, {
            anexoStatus: "OK",
            ordemServicoPdfStatus: "OK",
            ordemServicoPdfPendenteId: null,
            anexosPendentes: [],
            ordemServicoPdfUrl: pdfData.url,
            ordemServicoPdfPath: pdfData.path,
            ordemServicoPdfNomeArquivo: pdfData.nomeArquivo,
            ordemServicoPdfDataAnexo: pdfData.dataAnexoTexto,
            ordemServicoPdfCompactado: pdfData.arquivoCompactado,
            ordemServicoPdfNomeArquivoZip: pdfData.nomeArquivoZip,
            ordemServicoPdfMimeTypeOriginal: pdfData.mimeTypeOriginal,
            ordemServicoPdfTamanhoOriginal: pdfData.tamanhoOriginal,
            ordemServicoPdfTamanhoCompactado: pdfData.tamanhoCompactado,
            ordemServicoPdf: {
              url: pdfData.url,
              path: pdfData.path,
              nomeArquivo: pdfData.nomeArquivo,
              dataAnexoTexto: pdfData.dataAnexoTexto,
              arquivoCompactado: pdfData.arquivoCompactado,
              nomeArquivoZip: pdfData.nomeArquivoZip,
              mimeTypeOriginal: pdfData.mimeTypeOriginal,
              tamanhoOriginal: pdfData.tamanhoOriginal,
              tamanhoCompactado: pdfData.tamanhoCompactado,
            },
            updatedAt: serverTimestamp(),
          });

          anexoStatusFinal = "OK";
        } catch (uploadError: unknown) {
          console.error(uploadError);

          const pendente = await salvarAnexoPendente({
            tipo: "PDF_OS",
            osId: ordemRef.id,
            collectionName: "ordens_servico",
            origem: "CALCAMENTO",
            storageBasePath: "calcamento",
            storageSubfolder: "os-pdf",
            nomeArquivo: pdfOs.nomeArquivo,
            mimeType: pdfOs.file.type || "application/pdf",
            tamanho: pdfOs.file.size,
            criadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
            observacao: "PDF da OS salvo localmente porque o envio ao Supabase falhou após a OS já ter sido cadastrada.",
            ultimoErro: resumirErroAnexo(uploadError),
            arquivo: pdfOs.file,
          });

          await updateDoc(ordemRef, {
            anexoStatus: "PENDENTE",
            ordemServicoPdfStatus: "PENDENTE",
            ordemServicoPdfPendenteId: pendente.id,
            anexosPendentes: [
              {
                id: pendente.id,
                tipo: "PDF_OS",
                nomeArquivo: pdfOs.nomeArquivo,
                criadoEmTexto: new Date().toLocaleString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              },
            ],
            updatedAt: serverTimestamp(),
          });

          anexoStatusFinal = "PENDENTE";
        }
      }

      handleClear(false);
      setCamposAusentes([]);
      setShowMissingFieldsModal(false);
      setStatusMessage(null);
      setResultType("success");
      setResultMessage(
        anexoStatusFinal === "PENDENTE"
          ? "Ordem de serviço de Calçamento cadastrada. O PDF não foi enviado agora e ficou salvo na fila local de anexos pendentes para reenvio."
          : "Ordem de serviço de Calçamento cadastrada com sucesso."
      );
      setShowResultModal(true);
    } catch (error: unknown) {
      console.error(error);

      const msg =
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a OS de Calçamento. Verifique a conexão e tente novamente.";

      setStatusMessage(null);
      setResultType("error");
      setResultMessage(msg);
      setShowResultModal(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-card">
      <header className="page-header">
        <div>
          <h2>Cadastro de Calçamento</h2>
          <p className="page-section-description">
            Registre ordens de serviço relacionadas a buracos e intervenções no
            calçamento e pavimentação de passeios.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={onBack}>
          Voltar para Dashboard
        </button>
      </header>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>
          {statusMessage}
        </div>
      )}

      <form
        className="page-form page-form-mobile-wizard"
        onSubmit={(e: FormEvent<HTMLFormElement>) => e.preventDefault()}
      >
        {formularioLiberado && (
          <>
        <div className="mobile-form-progress" aria-label="Etapas do cadastro">
          {FORM_STEPS.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={`mobile-form-step ${
                step.id === mobileStep ? "is-active" : ""
              } ${index < currentStepIndex ? "is-done" : ""}`}
              onClick={() => goToMobileStep(step.id)}
            >
              <span>{index + 1}</span>
              <strong>{step.short}</strong>
            </button>
          ))}
        </div>

        {/* Identificação */}
        <div className={`page-section mobile-form-panel ${mobileStep === "identificacao" ? "is-active" : ""}`}>
          <h3>Identificação da OS</h3>
          <p className="page-section-description">
            Dados principais da ordem de serviço de Calçamento.
          </p>

          <div className="page-form-grid">
            <div className="page-field">
              <label>Protocolo</label>
              <input
                type="text"
                value={protocolo}
                onChange={(e) => handleInputChange("protocolo", e.target.value)}
                placeholder="NÚMERO DO PROTOCOLO"
              />
            </div>

            <div className="page-field">
              <label>Ordem de Serviço</label>
              <input
                type="text"
                value={ordemServico}
                onChange={(e) =>
                  handleInputChange("ordemServico", e.target.value)
                }
                placeholder="NÚMERO DA OS"
              />
            </div>
          </div>
        </div>

        {/* Local */}
        <div className={`page-section mobile-form-panel ${mobileStep === "local" ? "is-active" : ""}`}>
          <h3>Local do serviço</h3>
          <p className="page-section-description">
            Informe onde o serviço de calçamento precisa ser executado.
          </p>

          <div className="page-form-grid">
            <div className="page-field">
              <label>Bairro</label>
              <input
                type="text"
                value={bairro}
                onChange={(e) => handleInputChange("bairro", e.target.value)}
                placeholder="BAIRRO"
              />
            </div>

            <div className="page-field">
              <label>Rua / Avenida</label>
              <input
                type="text"
                value={rua}
                onChange={(e) => handleInputChange("rua", e.target.value)}
                placeholder="NOME DA RUA OU AVENIDA"
              />
            </div>

            <div className="page-field">
              <label>Número</label>
              <input
                type="text"
                value={numero}
                onChange={(e) => handleInputChange("numero", e.target.value)}
                placeholder="Nº"
              />
            </div>

            <div className="page-field">
              <label>Ponto de referência</label>
              <input
                type="text"
                value={referencia}
                onChange={(e) =>
                  handleInputChange("referencia", e.target.value)
                }
                placeholder="PRÓXIMO A..., EM FRENTE A..."
              />
            </div>
          </div>
        </div>

        {/* Observações */}
        <div className={`page-section mobile-form-panel ${mobileStep === "detalhes" ? "is-active" : ""}`}>
          <h3>Observações importantes</h3>
          <p className="page-section-description">
            Detalhes que ajudem a equipe a entender melhor a condição do
            calçamento, acesso de máquinas, bloqueios de via, etc.
          </p>

          <div className="page-field">
            <label>Observações</label>
            <textarea
              value={observacoes}
              onChange={(e) => handleInputChange("observacoes", e.target.value)}
              placeholder="EX.: TRECHO COM GRANDE FLUXO, NECESSÁRIO APOIO DA GUARDA, BURACO PROFUNDO, RISCO PARA PEDESTRES..."
            />
          </div>
        </div>

          </>
        )}

        {/* PDF da OS */}
        <div className={`page-section mobile-form-panel ${mobileStep === "anexos" ? "is-active" : ""}`}>
          <h3>OS em PDF</h3>
          <p className="page-section-description">
            Anexe o PDF da ordem de serviço de Calçamento. Esse arquivo ficará vinculado ao cadastro e será aberto na Lista de OS.
          </p>

          <div className="page-photos-block">
            <div className="page-field photo-upload">
              <label>Anexar OS em PDF</label>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={handlePdfChange}
              />
              <p className="photo-hint">
                Somente arquivo PDF. O sistema tentará ler o arquivo e preencher os campos automaticamente antes de compactar em ZIP.
              </p>
            </div>

            {!formularioLiberado && !extractingPdf && (
              <div className="mobile-review-card">
                <div>
                  <span>Comece pela OS em PDF</span>
                  <strong>Anexe a ordem de serviço para o sistema preencher os dados automaticamente.</strong>
                </div>
                <button type="button" className="btn-secondary" onClick={abrirFormularioManual}>
                  Preencher manualmente
                </button>
              </div>
            )}

            {extractingPdf && (
              <div className="mobile-review-card">
                <div>
                  <span>Leitura automática</span>
                  <strong>Lendo texto do PDF...</strong>
                </div>
              </div>
            )}

            {pdfExtraction && !extractingPdf && (
              <div className="mobile-review-card">
                <div>
                  <span>Campos encontrados no PDF</span>
                  <strong>
                    {pdfExtraction.camposEncontrados.length > 0
                      ? pdfExtraction.camposEncontrados.join(", ")
                      : "Nenhum campo identificado automaticamente"}
                  </strong>
                </div>
                {pdfExtraction.dados.tipoServico && (
                  <div>
                    <span>Tipo sugerido pelo PDF</span>
                    <strong>{pdfExtraction.dados.tipoServico}</strong>
                  </div>
                )}
                {pdfExtraction.aviso && (
                  <div>
                    <span>Aviso</span>
                    <strong>{pdfExtraction.aviso}</strong>
                  </div>
                )}
              </div>
            )}

            {pdfOs && (
              <div className="mobile-review-card">
                <div>
                  <span>PDF anexado</span>
                  <strong>{pdfOs.nomeArquivo}</strong>
                </div>
                <div>
                  <span>Data do anexo</span>
                  <strong>{pdfOs.dataAnexoTexto}</strong>
                </div>
                <button type="button" className="btn-secondary" onClick={handleRemovePdf}>
                  Remover PDF
                </button>
              </div>
            )}
          </div>
        </div>

        {formularioLiberado && (
          <>
        <div
          className={`page-section mobile-form-panel mobile-confirmation-panel ${
            mobileStep === "confirmacao" ? "is-active" : ""
          }`}
        >
          <h3>Conferência final</h3>
          <p className="page-section-description">
            Confira os principais dados antes de salvar a ordem de serviço de Calçamento.
          </p>

          <div className="mobile-review-card">
            <div>
              <span>Protocolo</span>
              <strong>{protocolo || "Não informado"}</strong>
            </div>
            <div>
              <span>Ordem de Serviço</span>
              <strong>{ordemServico || "Não informada"}</strong>
            </div>
            <div>
              <span>Bairro</span>
              <strong>{bairro || "Não informado"}</strong>
            </div>
            <div>
              <span>Rua / Número</span>
              <strong>{rua || "Rua não informada"}{numero ? `, nº ${numero}` : ""}</strong>
            </div>
            <div>
              <span>Ponto de referência</span>
              <strong>{referencia || "Não informado"}</strong>
            </div>
            <div>
              <span>Observações</span>
              <strong>{observacoes || "Sem observações"}</strong>
            </div>
            <div>
              <span>PDF anexado</span>
              <strong>{pdfOs ? pdfOs.nomeArquivo : "Nenhum PDF anexado"}</strong>
            </div>
          </div>
        </div>

        {/* Botões desktop */}
        <div className="page-actions desktop-form-actions">
          <button
            type="button"
            className="btn-primary btn-save"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Salvando..." : "Salvar OS"}
          </button>
          <button
            type="button"
            className="btn-secondary btn-clear"
            disabled={saving}
            onClick={() => setShowConfirmClear(true)}
          >
            Limpar
          </button>
        </div>

        <div className="mobile-form-navigation">
          <button
            type="button"
            className="btn-secondary"
            disabled={saving || currentStepIndex === 0}
            onClick={goToPreviousMobileStep}
          >
            Voltar
          </button>

          {isLastMobileStep ? (
            <button
              type="button"
              className="btn-primary btn-save"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Salvando..." : "Salvar OS"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={saving}
              onClick={goToNextMobileStep}
            >
              Próximo
            </button>
          )}
        </div>
          </>
        )}
      </form>

      {/* MODAL PARA CAMPOS NÃO PREENCHIDOS */}
      {showMissingFieldsModal && (
        <div
          className="modal-backdrop"
          onClick={() => !saving && setShowMissingFieldsModal(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Campos não preenchidos</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => !saving && setShowMissingFieldsModal(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>Os seguintes campos não foram preenchidos:</p>
              <ul>
                {camposAusentes.map((campo) => (
                  <li key={campo}>{campo}</li>
                ))}
              </ul>
              <p>Deseja continuar mesmo assim ou voltar para editar?</p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowMissingFieldsModal(false)}
                disabled={saving}
              >
                Voltar para editar
              </button>
              <button
                type="button"
                className="btn-primary btn-save"
                onClick={async () => {
                  setShowMissingFieldsModal(false);
                  await handleSave(true);
                }}
                disabled={saving}
              >
                {saving ? "Salvando..." : "Continuar mesmo assim"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL CONFIRMAR LIMPAR */}
      {showConfirmClear && (
        <div className="modal-backdrop" onClick={() => setShowConfirmClear(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Confirmar limpeza</h3>
              <button type="button" className="modal-close" onClick={() => setShowConfirmClear(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>Tem certeza que deseja limpar todos os dados da OS?</p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowConfirmClear(false)}
                disabled={saving}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-secondary btn-clear"
                onClick={() => {
                  handleClear();
                  setShowConfirmClear(false);
                }}
                disabled={saving}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL RESULTADO (SUCESSO / ERRO AO SALVAR) */}
      {showResultModal && (
        <div className="modal-backdrop" onClick={() => setShowResultModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {resultType === "success" ? "Cadastro salvo com sucesso" : "Erro ao salvar OS"}
              </h3>
              <button type="button" className="modal-close" onClick={() => setShowResultModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>{resultMessage}</p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-primary" onClick={() => setShowResultModal(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default BuracoNaRua;
