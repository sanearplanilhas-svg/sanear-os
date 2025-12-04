import React, { useState, type ChangeEvent, type FormEvent } from "react";
import {
  collection,
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";

type BuracoNaRuaProps = {
  onBack: () => void; // obrigatório
};

type BuracoFormData = {
  protocolo: string;
  ordemServico: string;
  bairro: string;
  rua: string;
  numero: string;
  pontoReferencia: string;
  observacoes: string;
};

type CampoForm =
  | "protocolo"
  | "ordemServico"
  | "bairro"
  | "rua"
  | "numero"
  | "pontoReferencia"
  | "observacoes";

const LABELS_CAMPOS: Record<CampoForm, string> = {
  protocolo: "Protocolo",
  ordemServico: "Ordem de serviço",
  bairro: "Bairro",
  rua: "Rua / Avenida",
  numero: "Número",
  pontoReferencia: "Ponto de referência",
  observacoes: "Observações",
};

type NaoDeclaradoState = Record<CampoForm, boolean>;

type FotoItem = {
  file: File;
  url: string; // URL gerada via URL.createObjectURL
  uploadedUrl?: string; // URL pública no Supabase (após upload)
};

type StatusType = "success" | "error" | "info" | null;

const BuracoNaRua: React.FC<BuracoNaRuaProps> = ({ onBack }) => {
  const [formData, setFormData] = useState<BuracoFormData>({
    protocolo: "",
    ordemServico: "",
    bairro: "",
    rua: "",
    numero: "",
    pontoReferencia: "",
    observacoes: "",
  });

  const [naoDeclarado, setNaoDeclarado] = useState<NaoDeclaradoState>({
    protocolo: false,
    ordemServico: false,
    bairro: false,
    rua: false,
    numero: false,
    pontoReferencia: false,
    observacoes: false,
  });

  const [fotos, setFotos] = useState<FotoItem[]>([]);
  const [selectedFoto, setSelectedFoto] = useState<FotoItem | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>(null);

  const [campoEmEdicao, setCampoEmEdicao] = useState<CampoForm | null>(null);
  const [holdNaoDeclarado, setHoldNaoDeclarado] = useState(false);

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingNaoDeclaradoField, setPendingNaoDeclaradoField] =
    useState<CampoForm | null>(null);

  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);

  const [showResultModal, setShowResultModal] = useState(false);
  const [resultModalType, setResultModalType] = useState<StatusType>(null);
  const [resultModalMessage, setResultModalMessage] = useState("");

  const [erroCamposObrigatorios, setErroCamposObrigatorios] = useState(false);

  function showStatus(message: string, type: StatusType, useModal = false) {
    if (useModal) {
      setResultModalMessage(message);
      setResultModalType(type);
      setShowResultModal(true);
    } else {
      setStatusMessage(message);
      setStatusType(type);
      setTimeout(() => {
        setStatusMessage(null);
      }, 4000);
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const filesArray = Array.from(files);

    const validFiles: File[] = [];
    for (const file of filesArray) {
      if (file.type === "image/jpeg" || file.type === "image/png") {
        validFiles.push(file);
      } else {
        showStatus(
          `O arquivo "${file.name}" não é uma imagem válida (apenas JPEG ou PNG).`,
          "error"
        );
      }
    }

    const fotoItems: FotoItem[] = validFiles.map((file) => ({
      file,
      url: URL.createObjectURL(file),
    }));

    setFotos((prev) => [...prev, ...fotoItems]);

    if (!selectedFoto && fotoItems.length > 0) {
      setSelectedFoto(fotoItems[0]);
    }

    event.target.value = "";
  };

  const handleFotoClick = (foto: FotoItem) => {
    setSelectedFoto(foto);
  };

  const handleRemoveFoto = (foto: FotoItem) => {
    URL.revokeObjectURL(foto.url);

    setFotos((prev) => prev.filter((f) => f !== foto));

    setSelectedFoto((prevSelected) =>
      prevSelected && prevSelected === foto ? null : prevSelected
    );
  };

  const handleRemoveAllFotos = () => {
    fotos.forEach((foto) => URL.revokeObjectURL(foto.url));
    setFotos([]);
    setSelectedFoto(null);
  };

  const handleBlurField = (campo: CampoForm) => {
    setCampoEmEdicao((current) => (current === campo ? null : current));
  };

  const handleEditField = (campo: CampoForm) => {
    if (holdNaoDeclarado) {
      setCampoEmEdicao(campo);
      return;
    }

    setNaoDeclarado((prev) => ({
      ...prev,
      [campo]: false,
    }));
    setCampoEmEdicao(campo);
  };

  const handleChangeCampo =
    (campo: CampoForm) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const novoValor = e.target.value;

      setFormData((prev) => ({
        ...prev,
        [campo]: novoValor,
      }));

      if (novoValor.trim().length > 0) {
        setNaoDeclarado((prev) => ({
          ...prev,
          [campo]: false,
        }));
      }
    };

  const handleChangeNaoDeclarado = (campo: CampoForm) => {
    if (!holdNaoDeclarado) {
      setPendingNaoDeclaradoField(campo);
      setShowConfirmModal(true);
      return;
    }

    setNaoDeclarado((prev) => {
      const novoValor = !prev[campo];

      const newState = {
        ...prev,
        [campo]: novoValor,
      };

      if (novoValor) {
        setFormData((prevData) => ({
          ...prevData,
          [campo]: "",
        }));
      }

      return newState;
    });

    setCampoEmEdicao(null);
  };

  const handleConfirmNaoDeclarado = (confirm: boolean) => {
    if (!pendingNaoDeclaradoField) {
      setShowConfirmModal(false);
      return;
    }

    if (confirm) {
      setHoldNaoDeclarado(true);

      const campo = pendingNaoDeclaradoField;
      setNaoDeclarado((prev) => {
        const novoValor = !prev[campo];
        const newState = {
          ...prev,
          [campo]: novoValor,
        };

        if (novoValor) {
          setFormData((prevData) => ({
            ...prevData,
            [campo]: "",
          }));
        }

        return newState;
      });

      setCampoEmEdicao(null);
    }

    setPendingNaoDeclaradoField(null);
    setShowConfirmModal(false);
  };

  const handleClearHoldNaoDeclarado = () => {
    setHoldNaoDeclarado(false);
    setPendingNaoDeclaradoField(null);
  };

  const handleClear = (showInfo: boolean = true) => {
    setFormData({
      protocolo: "",
      ordemServico: "",
      bairro: "",
      rua: "",
      numero: "",
      pontoReferencia: "",
      observacoes: "",
    });

    setNaoDeclarado({
      protocolo: false,
      ordemServico: false,
      bairro: false,
      rua: false,
      numero: false,
      pontoReferencia: false,
      observacoes: false,
    });

    fotos.forEach((foto) => URL.revokeObjectURL(foto.url));
    setFotos([]);
    setSelectedFoto(null);

    setStatusMessage(null);
    setStatusType(null);

    setErroCamposObrigatorios(false);

    if (showInfo) {
      showStatus("Formulário limpo com sucesso.", "info");
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErroCamposObrigatorios(false);

    const obrigatorios: CampoForm[] = [
      "bairro",
      "rua",
      "numero",
      "pontoReferencia",
    ];

    const faltaAlgumObrigatorio = obrigatorios.some((campo) => {
      const valor = formData[campo].trim();
      const nd = naoDeclarado[campo];

      return !nd && valor.length === 0;
    });

    if (faltaAlgumObrigatorio) {
      setErroCamposObrigatorios(true);
      showStatus("Preencha todos os campos obrigatórios.", "error");
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);
    setStatusType(null);

    try {
      const user = auth.currentUser;
      if (!user || !user.email) {
        throw new Error("Usuário não autenticado ou sem e-mail.");
      }

      if (!formData.bairro || !formData.rua || !formData.numero) {
        console.warn(
          "Campos de endereço incompletos. Continuando, mas atenção ao registro."
        );
      }

      const protocoloSeg = formData.protocolo.trim().replace(/\//g, "_") || "sem_protocolo";
      const osSeg = formData.ordemServico.trim().replace(/\//g, "_") || "sem_os";
      const now = new Date();
      const timestamp = now.getTime();

      const docId = `${protocoloSeg}_${osSeg}_${timestamp}`;

      const fotosUrls: string[] = [];

      if (fotos.length > 0) {
        for (const foto of fotos) {
          const storagePath = `buraco_na_rua/${docId}/${foto.file.name.replace(
            /\s+/g,
            "_"
          )}`;

          const { data: uploadData, error: uploadError } = await supabase.storage
            .from("sanear-fotos")
            .upload(storagePath, foto.file);

          if (uploadError) {
            console.error("Erro no upload da foto:", uploadError);
            throw new Error("Erro ao fazer upload das imagens.");
          }

          if (!uploadData?.path) {
            console.warn(
              "Upload retornou sucesso, mas sem 'path'. Verifique configuração do bucket."
            );
            continue;
          }

          const { data: publicUrlData } = supabase.storage
            .from("sanear-fotos")
            .getPublicUrl(uploadData.path);

          if (!publicUrlData?.publicUrl) {
            console.warn(
              "Não foi possível obter a URL pública da imagem. Verifique as configurações do bucket."
            );
            continue;
          }

          fotosUrls.push(publicUrlData.publicUrl);
        }
      }

      const docRef = doc(collection(db, "ordens_servico_buraco_na_rua"), docId);

      const firestorePayload = {
        protocolo: formData.protocolo || null,
        protocoloNaoDeclarado: naoDeclarado.protocolo || false,

        ordemServico: formData.ordemServico || null,
        ordemServicoNaoDeclarado: naoDeclarado.ordemServico || false,

        bairro: formData.bairro || null,
        bairroNaoDeclarado: naoDeclarado.bairro || false,

        rua: formData.rua || null,
        ruaNaoDeclarado: naoDeclarado.rua || false,

        numero: formData.numero || null,
        numeroNaoDeclarado: naoDeclarado.numero || false,

        pontoReferencia: formData.pontoReferencia || null,
        pontoReferenciaNaoDeclarado: naoDeclarado.pontoReferencia || false,

        observacoes: formData.observacoes || null,
        observacoesNaoDeclarado: naoDeclarado.observacoes || false,

        fotosUrls,
        userEmail: user.email,
        createdAt: serverTimestamp(),
      };

      await setDoc(docRef, firestorePayload);

      showStatus("Ordem de serviço salva com sucesso!", "success", true);

      handleClear(false);
    } catch (error: any) {
      console.error(error);
      const msg =
        error?.message || "Ocorreu um erro ao salvar a ordem de serviço.";
      showStatus(msg, "error", true);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <button
          type="button"
          className="btn-secondary page-back-button"
          onClick={onBack}
        >
          Voltar para Dashboard
        </button>
        <div className="page-header-text">
          <h1>Registro de OS - Calçamento (Buraco na Rua)</h1>
          <p>
            Preencha as informações relacionadas ao buraco aberto no
            calçamento ou rua para registro e acompanhamento.
          </p>
        </div>
      </header>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>
          {statusMessage}
        </div>
      )}

      {erroCamposObrigatorios && (
        <div className="status-banner status-error">
          Existem campos obrigatórios sem preenchimento. Verifique os campos
          sinalizados com *.
        </div>
      )}

      <div className="layout-columns">
        <section className="form-section">
          <form onSubmit={handleSubmit} className="buraco-form">
            <div className="form-row">
              <div className="field">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.protocolo}
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.protocolo}
                      onChange={() => handleChangeNaoDeclarado("protocolo")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.protocolo && (
                  <div className="input-wrapper">
                    <input
                      type="text"
                      placeholder="Ex.: 2025/000123"
                      value={formData.protocolo}
                      onChange={handleChangeCampo("protocolo")}
                      onBlur={() => handleBlurField("protocolo")}
                      onFocus={() => handleEditField("protocolo")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                    />
                    {campoEmEdicao !== "protocolo" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("protocolo")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="field">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.ordemServico}
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.ordemServico}
                      onChange={() => handleChangeNaoDeclarado("ordemServico")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.ordemServico && (
                  <div className="input-wrapper">
                    <input
                      type="text"
                      placeholder="Ex.: OS-2025-00456"
                      value={formData.ordemServico}
                      onChange={handleChangeCampo("ordemServico")}
                      onBlur={() => handleBlurField("ordemServico")}
                      onFocus={() => handleEditField("ordemServico")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                    />
                    {campoEmEdicao !== "ordemServico" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("ordemServico")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="form-row">
              <div className="field field-half">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.bairro} *
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.bairro}
                      onChange={() => handleChangeNaoDeclarado("bairro")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.bairro && (
                  <div className="input-wrapper">
                    <input
                      type="text"
                      placeholder="Nome do bairro"
                      value={formData.bairro}
                      onChange={handleChangeCampo("bairro")}
                      onBlur={() => handleBlurField("bairro")}
                      onFocus={() => handleEditField("bairro")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                    />
                    {campoEmEdicao !== "bairro" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("bairro")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="field field-half">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.rua} *
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.rua}
                      onChange={() => handleChangeNaoDeclarado("rua")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.rua && (
                  <div className="input-wrapper">
                    <input
                      type="text"
                      placeholder="Rua ou Avenida"
                      value={formData.rua}
                      onChange={handleChangeCampo("rua")}
                      onBlur={() => handleBlurField("rua")}
                      onFocus={() => handleEditField("rua")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                    />
                    {campoEmEdicao !== "rua" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("rua")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="form-row">
              <div className="field field-small">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.numero} *
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.numero}
                      onChange={() => handleChangeNaoDeclarado("numero")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.numero && (
                  <div className="input-wrapper">
                    <input
                      type="text"
                      placeholder="Nº"
                      value={formData.numero}
                      onChange={handleChangeCampo("numero")}
                      onBlur={() => handleBlurField("numero")}
                      onFocus={() => handleEditField("numero")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                    />
                    {campoEmEdicao !== "numero" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("numero")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="field">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.pontoReferencia} *
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.pontoReferencia}
                      onChange={() => handleChangeNaoDeclarado("pontoReferencia")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.pontoReferencia && (
                  <div className="input-wrapper">
                    <input
                      type="text"
                      placeholder="Ponto de referência próximo"
                      value={formData.pontoReferencia}
                      onChange={handleChangeCampo("pontoReferencia")}
                      onBlur={() => handleBlurField("pontoReferencia")}
                      onFocus={() => handleEditField("pontoReferencia")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                    />
                    {campoEmEdicao !== "pontoReferencia" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("pontoReferencia")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="form-row">
              <div className="field">
                <div className="field-label-row">
                  <span className="field-label">
                    {LABELS_CAMPOS.observacoes}
                  </span>
                  <label className="nd-check">
                    <input
                      type="checkbox"
                      checked={naoDeclarado.observacoes}
                      onChange={() => handleChangeNaoDeclarado("observacoes")}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Não declarada
                  </label>
                </div>

                {!naoDeclarado.observacoes && (
                  <div className="input-wrapper">
                    <textarea
                      placeholder="Descreva detalhes adicionais sobre o buraco, riscos, fluxo de veículos, etc."
                      value={formData.observacoes}
                      onChange={handleChangeCampo("observacoes")}
                      onBlur={() => handleBlurField("observacoes")}
                      onFocus={() => handleEditField("observacoes")}
                      disabled={holdNaoDeclarado && !campoEmEdicao}
                      rows={5}
                    />
                    {campoEmEdicao !== "observacoes" && (
                      <button
                        type="button"
                        className="edit-button"
                        onClick={() => handleEditField("observacoes")}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="form-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowClearConfirmModal(true)}
                disabled={isSubmitting}
              >
                Limpar formulário
              </button>

              <button
                type="submit"
                className="btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Salvando..." : "Salvar OS"}
              </button>
            </div>
          </form>
        </section>

        <section className="photos-section">
          <h2>Fotos do local</h2>
          <p className="field-hint">
            Adicione fotos para facilitar a identificação do problema e a
            conferência da execução. Somente arquivos JPEG e PNG são aceitos.
          </p>

          <div className="upload-area">
            <label className="upload-label">
              <input
                type="file"
                accept="image/jpeg,image/png"
                multiple
                onChange={handleFileChange}
              />
              <span>Selecionar fotos</span>
            </label>

            {fotos.length > 0 && (
              <button
                type="button"
                className="btn-secondary"
                onClick={handleRemoveAllFotos}
              >
                Remover todas
              </button>
            )}
          </div>

          {fotos.length > 0 ? (
            <div className="photos-grid">
              <div className="photo-preview">
                {selectedFoto ? (
                  <img
                    src={selectedFoto.url}
                    alt={selectedFoto.file.name}
                    className="photo-preview-image"
                  />
                ) : (
                  <div className="photo-preview-placeholder">
                    Selecione uma miniatura ao lado para visualizar.
                  </div>
                )}
              </div>

              <div className="photo-thumbs">
                {fotos.map((foto, index) => (
                  <div
                    key={`${foto.url}-${index}`}
                    className={`photo-thumb ${
                      selectedFoto === foto ? "selected" : ""
                    }`}
                    onClick={() => handleFotoClick(foto)}
                  >
                    <img
                      src={foto.url}
                      alt={foto.file.name}
                      className="photo-thumb-image"
                    />
                    <button
                      type="button"
                      className="photo-thumb-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveFoto(foto);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="no-photos">
              Nenhuma foto adicionada ainda. Clique em "Selecionar fotos" para
              anexar imagens do local.
            </div>
          )}
        </section>
      </div>

      {showConfirmModal && (
        <div
          className="modal-backdrop"
          onClick={() => handleConfirmNaoDeclarado(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Confirmar "Não declarada"</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => handleConfirmNaoDeclarado(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>
                Marcar um campo como <strong>"Não declarada"</strong> significa
                que essa informação não foi fornecida pelo solicitante ou não se
                aplica à situação.
              </p>
              <p className="field-hint">
                Você poderá alterar esse status mais tarde, se necessário. Esta
                confirmação será válida até você atualizar a página.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleConfirmNaoDeclarado(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => handleConfirmNaoDeclarado(true)}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {holdNaoDeclarado && (
        <div className="hold-banner">
          Atenção: atualmente marcando campos como{" "}
          <strong>"Não declarada"</strong> sem novas confirmações.{" "}
          <button
            type="button"
            className="link-button"
            onClick={handleClearHoldNaoDeclarado}
          >
            Desativar este modo
          </button>
        </div>
      )}

      {showClearConfirmModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowClearConfirmModal(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Limpar formulário</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowClearConfirmModal(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>
                Tem certeza de que deseja limpar todos os campos do formulário?
              </p>
              <p className="field-hint">
                Esta ação não pode ser desfeita. As informações preenchidas
                serão perdidas.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowClearConfirmModal(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  handleClear();
                  setShowClearConfirmModal(false);
                }}
              >
                Limpar tudo
              </button>
            </div>
          </div>
        </div>
      )}

      {showResultModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowResultModal(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {resultModalType === "success"
                  ? "Sucesso"
                  : resultModalType === "error"
                  ? "Erro"
                  : "Informação"}
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
              <p>{resultModalMessage}</p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowResultModal(false)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default BuracoNaRua;
