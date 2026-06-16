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
type AsfaltoProps = {
  onBack: () => void;
};

type FotoAnexada = {
  id: string;
  url: string;
  timestamp: string;
  file: File;
};

type StatusType = "success" | "error" | "info";

const STORAGE_BUCKET = "os-arquivos";

const FORM_STEPS = [
  { id: "identificacao", label: "Identificação", short: "ID" },
  { id: "local", label: "Local", short: "Local" },
  { id: "detalhes", label: "Detalhes", short: "Obs." },
  { id: "anexos", label: "Fotos", short: "Fotos" },
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
  | "observacoes";

const LABELS_CAMPOS: Record<CampoForm, string> = {
  protocolo: "Protocolo",
  ordemServico: "Ordem de Serviço",
  bairro: "Bairro",
  rua: "Rua / Avenida",
  numero: "Número",
  referencia: "Ponto de referência",
  observacoes: "Observações",
};

const Asfalto: React.FC<AsfaltoProps> = ({ onBack }) => {
  const [protocolo, setProtocolo] = useState("");
  const [ordemServico, setOrdemServico] = useState("");
  const [bairro, setBairro] = useState("");
  const [rua, setRua] = useState("");
  const [numero, setNumero] = useState("");
  const [referencia, setReferencia] = useState("");
  const [observacoes, setObservacoes] = useState("");

  const [fotos, setFotos] = useState<FotoAnexada[]>([]);
  const [fotoEmPreview, setFotoEmPreview] = useState<FotoAnexada | null>(null);

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

  function handleInputChange(campo: CampoForm, value: string) {
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

  function handleFotosChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const arquivos = Array.from(files);
    const apenasImagens = arquivos.filter((file) =>
      file.type.startsWith("image/")
    );

    if (apenasImagens.length === 0) {
      setStatus("Apenas arquivos de imagem são permitidos.", "error");
      e.target.value = "";
      return;
    }

    const agora = new Date();
    const timestampStr = agora.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    apenasImagens.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        setFotos((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            url,
            timestamp: timestampStr,
            file,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });

    e.target.value = "";
    setStatus("Foto(s) anexada(s) com sucesso.", "success");
  }

  function handleOpenPreview(foto: FotoAnexada) {
    setFotoEmPreview(foto);
  }

  function handleClosePreview() {
    setFotoEmPreview(null);
  }

  function handleExcluirFoto(id: string) {
    setFotos((prev) => prev.filter((f) => f.id !== id));
    setFotoEmPreview(null);
    setStatus("Foto removida.", "info");
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
    setFotos([]);
    setFotoEmPreview(null);
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
    const ordensRef = collection(db, "ordensServico");

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

      const ordensRef = collection(db, "ordensServico");
      const ordemRef = doc(ordensRef);

      const fotosData: {
        id: string;
        nomeArquivo: string;
        dataAnexoTexto: string;
        url: string;
      }[] = [];

      for (const foto of fotos) {
        const path = `asfalto/${ordemRef.id}/fotos/${foto.id}-${foto.file.name}`;

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, foto.file, { upsert: true });

        if (uploadError) {
          console.error(uploadError);
          throw new Error(
            `Erro ao enviar foto "${foto.file.name}" para o armazenamento.`
          );
        }

        const { data: publicData } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(path);

        fotosData.push({
          id: foto.id,
          nomeArquivo: foto.file.name,
          dataAnexoTexto: foto.timestamp,
          url: publicData.publicUrl,
        });
      }

      await setDoc(ordemRef, {
        tipo: "ASFALTO",
        protocolo: protocoloNormalizado || null,
        ordemServico: ordemServicoNormalizada || null,
        bairro: bairro.trim() || null,
        rua: rua.trim() || null,
        numero: numero.trim() || null,
        referencia: referencia.trim() || null,
        observacoes: observacoes.trim() || null,
        status: "ABERTA",
        slaHoras: SLA_HORAS_PADRAO,
        slaPausas: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByEmail: auth.currentUser?.email?.toLowerCase() ?? null,
        createdByUid: auth.currentUser?.uid ?? null,
        fotos: fotosData,
      });

      handleClear(false);
      setCamposAusentes([]);
      setShowMissingFieldsModal(false);
      setStatusMessage(null);
      setResultType("success");
      setResultMessage("Ordem de serviço de Asfalto cadastrada com sucesso.");
      setShowResultModal(true);
    } catch (error: unknown) {
      console.error(error);

      const msg =
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a OS de Asfalto. Verifique a conexão e tente novamente.";

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
          <h2>Cadastro de Asfalto</h2>
          <p className="page-section-description">
            Registre ordens de serviço relacionadas a recapeamento, tapa-buraco,
            pavimentação e restauração de vias.
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
            Dados principais da ordem de serviço de Asfalto.
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
            Informe onde o serviço de asfalto precisa ser executado.
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
            Detalhes que ajudem a equipe a entender melhor a condição do asfalto,
            acesso de máquinas, bloqueios de via, etc.
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

        {/* Fotos */}
        <div className={`page-section mobile-form-panel ${mobileStep === "anexos" ? "is-active" : ""}`}>
          <h3>Fotos do local</h3>
          <p className="page-section-description">
            Anexe fotos da situação atual do asfalto (opcional). Clique em uma
            foto para ampliar e ter opção de exclusão.
          </p>

          <div className="page-photos-block">
            <div className="page-field photo-upload">
              <label>Anexar fotos</label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleFotosChange}
              />
              <p className="photo-hint">
                Você pode selecionar uma ou várias imagens. Somente arquivos de
                imagem são permitidos. Campo opcional.
              </p>
            </div>

            {fotos.length > 0 && (
              <>
                <p className="field-hint">
                  Clique em uma foto para abrir a pré-visualização com a opção
                  de excluir somente aquela imagem.
                </p>
                <div className="photo-preview-grid">
                  {fotos.map((foto) => (
                    <div
                      key={foto.id}
                      className="photo-preview-item"
                      onClick={() => handleOpenPreview(foto)}
                    >
                      <img src={foto.url} alt="Foto anexada" />
                      <span className="photo-timestamp">{foto.timestamp}</span>
                    </div>
                  ))}
                </div>
              </>
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
            Confira os principais dados antes de salvar a ordem de serviço de Asfalto.
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
              <span>Fotos anexadas</span>
              <strong>{fotos.length} foto{fotos.length === 1 ? "" : "s"}</strong>
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
      </form>

      {/* MODAL DE PRÉ-VISUALIZAÇÃO DA FOTO */}
      {fotoEmPreview && (
        <div className="modal-backdrop" onClick={handleClosePreview}>
          <div className="modal modal-photo" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Pré-visualização da foto</h3>
              <button type="button" className="modal-close" onClick={handleClosePreview}>
                ×
              </button>
            </div>

            <div className="modal-body modal-photo-body">
              <img
                src={fotoEmPreview.url}
                alt="Foto anexada"
                style={{
                  width: "100%",
                  maxHeight: "70vh",
                  objectFit: "contain",
                  borderRadius: "0.75rem",
                }}
              />
              <p className="field-hint">Anexada em {fotoEmPreview.timestamp}</p>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={handleClosePreview}>
                Fechar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => handleExcluirFoto(fotoEmPreview.id)}
              >
                Excluir esta foto
              </button>
            </div>
          </div>
        </div>
      )}

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

export default Asfalto;
