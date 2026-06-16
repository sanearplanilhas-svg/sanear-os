import React, { useState, type ChangeEvent, type FormEvent } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  setDoc,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import { SLA_HORAS_PADRAO } from "../lib/sla";

type CaminhaoHidrojatoProps = {
  onBack: () => void;
};

type PdfAnexado = {
  file: File;
  nomeArquivo: string;
  dataAnexoTexto: string;
};

type StatusType = "success" | "error" | "info";

const STORAGE_BUCKET = "os-arquivos";
const COLLECTION_NAME = "ordensHidrojato";
const STORAGE_BASE_PATH = "hidrojato";

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

function sanitizeForStoragePath(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

const CaminhaoHidrojato: React.FC<CaminhaoHidrojatoProps> = ({ onBack }) => {
  const [protocolo, setProtocolo] = useState("");
  const [ordemServico, setOrdemServico] = useState("");
  const [bairro, setBairro] = useState("");
  const [rua, setRua] = useState("");
  const [numero, setNumero] = useState("");
  const [referencia, setReferencia] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [pdfOs, setPdfOs] = useState<PdfAnexado | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");

  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [showMissingFieldsModal, setShowMissingFieldsModal] = useState(false);
  const [camposAusentes, setCamposAusentes] = useState<string[]>([]);

  const [showResultModal, setShowResultModal] = useState(false);
  const [resultType, setResultType] = useState<"success" | "error">("success");
  const [resultMessage, setResultMessage] = useState("");

  const [mobileStep, setMobileStep] = useState<FormStep>("identificacao");
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

  function handlePdfChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;

    if (!file) return;

    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setPdfOs(null);
      setStatus("Somente arquivo PDF é permitido para a OS.", "error");
      e.target.value = "";
      return;
    }

    const dataAnexoTexto = new Date().toLocaleString("pt-BR", {
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
    setStatus("PDF da OS anexado com sucesso.", "success");
    e.target.value = "";
  }

  function handleRemoverPdf() {
    setPdfOs(null);
    setStatus("PDF removido.", "info");
  }

  function handleClear(showInfo: boolean = true) {
    setProtocolo("");
    setOrdemServico("");
    setBairro("");
    setRua("");
    setNumero("");
    setReferencia("");
    setObservacoes("");
    setPdfOs(null);
    setMobileStep("identificacao");

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
    const ordensRef = collection(db, COLLECTION_NAME);

    if (protocoloInformado) {
      const protocoloSnapshot = await getDocs(
        query(ordensRef, where("protocolo", "==", protocoloInformado), limit(1))
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
  }> {
    if (!pdfOs) {
      return {
        url: null,
        path: null,
        nomeArquivo: null,
        dataAnexoTexto: null,
      };
    }

    const safeName = sanitizeForStoragePath(pdfOs.nomeArquivo || "ordem-servico.pdf");
    const path = `${STORAGE_BASE_PATH}/${ordemId}/os-pdf/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, pdfOs.file, {
        upsert: true,
        contentType: "application/pdf",
      });

    if (uploadError) {
      console.error(uploadError);
      throw new Error(`Erro ao enviar o PDF "${pdfOs.nomeArquivo}" para o armazenamento.`);
    }

    const { data: publicData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(path);

    return {
      url: publicData.publicUrl,
      path,
      nomeArquivo: pdfOs.nomeArquivo,
      dataAnexoTexto: pdfOs.dataAnexoTexto,
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
    const ordemServicoNormalizada = ordemServico.trim().toLocaleUpperCase("pt-BR");

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

      const ordensRef = collection(db, COLLECTION_NAME);
      const ordemRef = doc(ordensRef);
      const pdfData = await uploadPdf(ordemRef.id);

      await setDoc(ordemRef, {
        tipo: "HIDROJATO",
        protocolo: protocoloNormalizado || null,
        ordemServico: ordemServicoNormalizada || null,
        bairro: bairro.trim() || null,
        rua: rua.trim() || null,
        numero: numero.trim() || null,
        referencia: referencia.trim() || null,
        pontoReferencia: referencia.trim() || null,
        observacoes: observacoes.trim() || null,
        status: "ABERTA",
        areaExecucao: "SERVICO_SANEAR",
        destinoExecucao: "SERVICO_SANEAR",
        exibirNaTerceirizada: false,
        slaHoras: SLA_HORAS_PADRAO,
        slaPausas: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByEmail: auth.currentUser?.email?.toLowerCase() ?? null,
        createdByUid: auth.currentUser?.uid ?? null,
        fotos: [],
        fotosExecucao: [],
        ordemServicoPdfUrl: pdfData.url,
        ordemServicoPdfPath: pdfData.path,
        ordemServicoPdfNomeArquivo: pdfData.nomeArquivo,
        ordemServicoPdfDataAnexo: pdfData.dataAnexoTexto,
        ordemServicoPdf: pdfData.url
          ? {
              url: pdfData.url,
              path: pdfData.path,
              nomeArquivo: pdfData.nomeArquivo,
              dataAnexoTexto: pdfData.dataAnexoTexto,
            }
          : null,
      });

      handleClear(false);
      setCamposAusentes([]);
      setShowMissingFieldsModal(false);
      setStatusMessage(null);
      setResultType("success");
      setResultMessage("Ordem de serviço de Caminhão Hidrojato cadastrada com sucesso.");
      setShowResultModal(true);
    } catch (error: unknown) {
      console.error(error);

      const msg =
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a OS de Caminhão Hidrojato. Verifique a conexão e tente novamente.";

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
          <h2>Cadastro de Caminhão Hidrojato</h2>
          <p className="page-section-description">
            Registre ordens de serviço para atendimento com caminhão hidrojato,
            mantendo o mesmo padrão operacional dos módulos de Calçamento e Asfalto.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={onBack}>
          Voltar para Dashboard
        </button>
      </header>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>{statusMessage}</div>
      )}

      <form
        className="page-form page-form-mobile-wizard"
        onSubmit={(e: FormEvent<HTMLFormElement>) => e.preventDefault()}
      >
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

        <div className={`page-section mobile-form-panel ${mobileStep === "identificacao" ? "is-active" : ""}`}>
          <h3>Identificação da OS</h3>
          <p className="page-section-description">
            Dados principais da ordem de serviço do caminhão hidrojato.
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
                onChange={(e) => handleInputChange("ordemServico", e.target.value)}
                placeholder="NÚMERO DA OS"
              />
            </div>
          </div>
        </div>

        <div className={`page-section mobile-form-panel ${mobileStep === "local" ? "is-active" : ""}`}>
          <h3>Local do serviço</h3>
          <p className="page-section-description">
            Informe onde o caminhão hidrojato precisa executar o atendimento.
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
                onChange={(e) => handleInputChange("referencia", e.target.value)}
                placeholder="PRÓXIMO A..., EM FRENTE A..."
              />
            </div>
          </div>
        </div>

        <div className={`page-section mobile-form-panel ${mobileStep === "detalhes" ? "is-active" : ""}`}>
          <h3>Observações importantes</h3>
          <p className="page-section-description">
            Detalhes que ajudem a equipe a entender melhor o serviço, acesso do
            caminhão, obstruções, risco, horário recomendado ou necessidade de apoio.
          </p>

          <div className="page-field">
            <label>Observações</label>
            <textarea
              value={observacoes}
              onChange={(e) => handleInputChange("observacoes", e.target.value)}
              placeholder="EX.: REDE ENTUPIDA, ACESSO ESTREITO, NECESSÁRIO APOIO, SERVIÇO URGENTE, HORÁRIO COMERCIAL..."
            />
          </div>
        </div>

        <div className={`page-section mobile-form-panel ${mobileStep === "anexos" ? "is-active" : ""}`}>
          <h3>OS em PDF</h3>
          <p className="page-section-description">
            Anexe o PDF da ordem de serviço que deverá ficar vinculado ao atendimento do hidrojato.
          </p>

          <div className="page-photos-block">
            <div className="page-field photo-upload">
              <label>Anexar OS em PDF</label>
              <input type="file" accept="application/pdf,.pdf" onChange={handlePdfChange} />
              <p className="photo-hint">
                Somente arquivo PDF. O arquivo será salvo no Storage e vinculado à OS cadastrada.
              </p>
            </div>

            {pdfOs && (
              <div className="status-banner status-info" style={{ marginTop: "0.75rem" }}>
                <strong>PDF anexado:</strong> {pdfOs.nomeArquivo} — {pdfOs.dataAnexoTexto}
                <div style={{ marginTop: "0.6rem" }}>
                  <button type="button" className="btn-secondary" onClick={handleRemoverPdf}>
                    Remover PDF
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div
          className={`page-section mobile-form-panel mobile-confirmation-panel ${
            mobileStep === "confirmacao" ? "is-active" : ""
          }`}
        >
          <h3>Conferência final</h3>
          <p className="page-section-description">
            Confira os dados antes de salvar a ordem de serviço de Caminhão Hidrojato.
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
      </form>

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

      {showConfirmClear && (
        <div className="modal-backdrop" onClick={() => setShowConfirmClear(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Confirmar limpeza</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowConfirmClear(false)}
              >
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

      {showResultModal && (
        <div className="modal-backdrop" onClick={() => setShowResultModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {resultType === "success" ? "Cadastro salvo com sucesso" : "Erro ao salvar OS"}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowResultModal(false)}
              >
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

export default CaminhaoHidrojato;
