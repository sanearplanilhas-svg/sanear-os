import React, { useState, type ChangeEvent, type FormEvent } from "react";
import {
  collection,
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";

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

  const [naoDeclarado, setNaoDeclarado] = useState<Record<CampoForm, boolean>>({
    protocolo: false,
    ordemServico: false, // mantido no state, mas não usamos mais na UI
    bairro: false,
    rua: false,
    numero: false,
    referencia: false,
    observacoes: false,
  });

  const [fotos, setFotos] = useState<FotoAnexada[]>([]);
  const [fotoEmPreview, setFotoEmPreview] = useState<FotoAnexada | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");

  const [showConfirmSave, setShowConfirmSave] = useState(false);
  const [showConfirmClear, setShowConfirmClear] = useState(false);

  // Modal de resultado (sucesso/erro ao salvar)
  const [showResultModal, setShowResultModal] = useState(false);
  const [resultType, setResultType] = useState<"success" | "error">("success");
  const [resultMessage, setResultMessage] = useState("");

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

    // se digitou algo, desmarca "não declarado"
    setNaoDeclarado((prev) => ({
      ...prev,
      [campo]: false,
    }));
  }

  function toggleNaoDeclarado(campo: CampoForm) {
    setNaoDeclarado((prev) => {
      const novoValor = !prev[campo];

      if (novoValor) {
        // se marcou "não declarado", limpa o campo
        switch (campo) {
          case "protocolo":
            setProtocolo("");
            break;
          case "ordemServico":
            setOrdemServico("");
            break;
          case "bairro":
            setBairro("");
            break;
          case "rua":
            setRua("");
            break;
          case "numero":
            setNumero("");
            break;
          case "referencia":
            setReferencia("");
            break;
          case "observacoes":
            setObservacoes("");
            break;
        }
      }

      return {
        ...prev,
        [campo]: novoValor,
      };
    });
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
    setNaoDeclarado({
      protocolo: false,
      ordemServico: false,
      bairro: false,
      rua: false,
      numero: false,
      referencia: false,
      observacoes: false,
    });

    if (showInfo) {
      setStatus("Formulário limpo.", "info");
    }
  }

  async function handleSave() {
    setStatusMessage(null);

    const erros: string[] = [];

    const valores: Record<CampoForm, string> = {
      protocolo,
      ordemServico,
      bairro,
      rua,
      numero,
      referencia,
      observacoes,
    };

    // 1) Ordem de Serviço OBRIGATÓRIA (sem "não declarado")
    if (!ordemServico.trim()) {
      erros.push("Preencha o campo Ordem de Serviço (obrigatório).");
    }

    // 2) Demais campos seguem regra: valor OU "não declarado"
    (Object.keys(valores) as CampoForm[]).forEach((campo) => {
      if (campo === "ordemServico") return; // já validado acima

      const valor = valores[campo].trim();
      const marcado = naoDeclarado[campo];

      if (!valor && !marcado) {
        erros.push(
          `Preencha o campo ${LABELS_CAMPOS[campo]} ou marque "NÃO DECLARADO PELO CADASTRANTE".`
        );
      }
    });

    if (erros.length > 0) {
      setStatus(erros.join(" "), "error");
      return;
    }

    try {
      setSaving(true);

      const ordensRef = collection(db, "ordensServico");
      const ordemRef = doc(ordensRef);

      // 1) Upload fotos Supabase (opcional)
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

      // 2) Salvar Firestore (sem mais campos de PDF)
      await setDoc(ordemRef, {
        tipo: "ASFALTO",
        protocolo: protocolo.trim() || null,
        ordemServico: ordemServico.trim() || null,
        bairro: bairro.trim() || null,
        rua: rua.trim() || null,
        numero: numero.trim() || null,
        referencia: referencia.trim() || null,
        observacoes: observacoes.trim() || null,
        status: "ABERTA",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        fotos: fotosData,
      });

      // Sucesso: limpa formulário sem mostrar "Formulário limpo."
      handleClear(false);

      // limpa banner e abre modal de sucesso
      setStatusMessage(null);
      setResultType("success");
      setResultMessage("Ordem de serviço de Asfalto cadastrada com sucesso.");
      setShowResultModal(true);
    } catch (error: any) {
      console.error(error);

      const msg =
        error?.message ??
        "Não foi possível salvar a OS de Asfalto. Verifique a conexão e tente novamente.";

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
        className="page-form"
        onSubmit={(e: FormEvent<HTMLFormElement>) => e.preventDefault()}
      >
        {/* Identificação */}
        <div className="page-section">
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
                disabled={naoDeclarado.protocolo}
              />
              <label className="field-hint">
                <input
                  type="checkbox"
                  checked={naoDeclarado.protocolo}
                  onChange={() => toggleNaoDeclarado("protocolo")}
                />{" "}
                NÃO DECLARADO PELO CADASTRANTE
              </label>
            </div>

            <div className="page-field">
              <label>
                Ordem de Serviço{" "}
                <span style={{ color: "var(--danger, #b91c1c)" }}>*</span>
              </label>
              <input
                type="text"
                value={ordemServico}
                onChange={(e) =>
                  handleInputChange("ordemServico", e.target.value)
                }
                placeholder="NÚMERO DA OS (OBRIGATÓRIO)"
              />
              <p className="field-hint">Campo obrigatório.</p>
            </div>
          </div>
        </div>

        {/* Local */}
        <div className="page-section">
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
                disabled={naoDeclarado.bairro}
              />
              <label className="field-hint">
                <input
                  type="checkbox"
                  checked={naoDeclarado.bairro}
                  onChange={() => toggleNaoDeclarado("bairro")}
                />{" "}
                NÃO DECLARADO PELO CADASTRANTE
              </label>
            </div>

            <div className="page-field">
              <label>Rua / Avenida</label>
              <input
                type="text"
                value={rua}
                onChange={(e) => handleInputChange("rua", e.target.value)}
                placeholder="NOME DA RUA OU AVENIDA"
                disabled={naoDeclarado.rua}
              />
              <label className="field-hint">
                <input
                  type="checkbox"
                  checked={naoDeclarado.rua}
                  onChange={() => toggleNaoDeclarado("rua")}
                />{" "}
                NÃO DECLARADO PELO CADASTRANTE
              </label>
            </div>

            <div className="page-field">
              <label>Número</label>
              <input
                type="text"
                value={numero}
                onChange={(e) => handleInputChange("numero", e.target.value)}
                placeholder="Nº"
                disabled={naoDeclarado.numero}
              />
              <label className="field-hint">
                <input
                  type="checkbox"
                  checked={naoDeclarado.numero}
                  onChange={() => toggleNaoDeclarado("numero")}
                />{" "}
                NÃO DECLARADO PELO CADASTRANTE
              </label>
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
                disabled={naoDeclarado.referencia}
              />
              <label className="field-hint">
                <input
                  type="checkbox"
                  checked={naoDeclarado.referencia}
                  onChange={() => toggleNaoDeclarado("referencia")}
                />{" "}
                NÃO DECLARADO PELO CADASTRANTE
              </label>
            </div>
          </div>
        </div>

        {/* Observações */}
        <div className="page-section">
          <h3>Observações importantes</h3>
          <p className="page-section-description">
            Detalhes que ajudem a equipe a entender melhor a condição do asfalto,
            acesso de máquinas, bloqueios de via, etc.
          </p>

          <div className="page-field">
            <label>Observações</label>
            <textarea
              value={observacoes}
              onChange={(e) =>
                handleInputChange("observacoes", e.target.value)
              }
              placeholder="EX.: TRECHO COM GRANDE FLUXO, NECESSÁRIO APOIO DA GUARDA, BURACO PROFUNDO, RISCO PARA PEDESTRES..."
              disabled={naoDeclarado.observacoes}
            />
            <label className="field-hint">
              <input
                type="checkbox"
                checked={naoDeclarado.observacoes}
                onChange={() => toggleNaoDeclarado("observacoes")}
              />{" "}
              NÃO DECLARADO PELO CADASTRANTE
            </label>
          </div>
        </div>

        {/* Fotos */}
        <div className="page-section">
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
                      <span className="photo-timestamp">
                        {foto.timestamp}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Botões */}
        <div className="page-actions">
          <button
            type="button"
            className="btn-primary btn-save"
            disabled={saving}
            onClick={() => setShowConfirmSave(true)}
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
      </form>

      {/* MODAL DE PRÉ-VISUALIZAÇÃO DA FOTO */}
      {fotoEmPreview && (
        <div className="modal-backdrop" onClick={handleClosePreview}>
          <div
            className="modal modal-photo"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">Pré-visualização da foto</h3>
              <button
                type="button"
                className="modal-close"
                onClick={handleClosePreview}
              >
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
              <p className="field-hint">
                Anexada em {fotoEmPreview.timestamp}
              </p>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleClosePreview}
              >
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

      {/* MODAL CONFIRMAR SALVAR */}
      {showConfirmSave && (
        <div
          className="modal-backdrop"
          onClick={() => !saving && setShowConfirmSave(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">Confirmar salvamento</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => !saving && setShowConfirmSave(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>Tem certeza que deseja salvar esta ordem de serviço?</p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowConfirmSave(false)}
                disabled={saving}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary btn-save"
                onClick={async () => {
                  setShowConfirmSave(false);
                  await handleSave();
                }}
                disabled={saving}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL CONFIRMAR LIMPAR */}
      {showConfirmClear && (
        <div
          className="modal-backdrop"
          onClick={() => setShowConfirmClear(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
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

      {/* MODAL RESULTADO (SUCESSO / ERRO AO SALVAR) */}
      {showResultModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowResultModal(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                {resultType === "success"
                  ? "Cadastro salvo com sucesso"
                  : "Erro ao salvar OS"}
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
    </section>
  );
};

export default Asfalto;
