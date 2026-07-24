import { useEffect, useMemo, useState } from "react";
import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";

import { db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import {
  atualizarErroAnexoPendente,
  listarAnexosPendentes,
  removerAnexoPendente,
  resumirErroAnexo,
  type AnexoPendenteRegistro,
  type TipoAnexoPendente,
} from "../lib/anexosPendentes";
import {
  compactBlobToZip,
  sanitizeZipFileName,
  ZIP_STORAGE_MIME,
} from "../lib/storageZip";

const STORAGE_BUCKET = "os-arquivos";
const COLLECTIONS_PERMITIDAS = ["ordens_servico", "ordensServico", "ordensHidrojato"] as const;

type FiltroTipo = "TODOS" | TipoAnexoPendente;
type StatusMessage = {
  type: "success" | "error" | "info";
  text: string;
};

function dispararAtualizacaoContador() {
  window.dispatchEvent(new Event("sanear-anexos-pendentes-change"));
}

function validarCollection(collectionName: string) {
  if (!COLLECTIONS_PERMITIDAS.includes(collectionName as (typeof COLLECTIONS_PERMITIDAS)[number])) {
    throw new Error(`Coleção inválida para reenvio: ${collectionName}`);
  }
}

function formatarData(iso?: string | null): string {
  if (!iso) return "-";
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "-";
  return data.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatarTamanho(bytes?: number | null): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function getTipoLabel(tipo: TipoAnexoPendente): string {
  if (tipo === "PDF_OS") return "PDF DA OS";
  return "FOTO DE EXECUÇÃO";
}

function getOrigemLabel(origem: string): string {
  const normalizado = origem
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  if (normalizado.includes("CALCAMENTO") || normalizado.includes("BURACO")) return "CALÇAMENTO";
  if (normalizado.includes("ASFALTO")) return "ASFALTO";
  if (normalizado.includes("HIDROJATO")) return "CAMINHÃO HIDROJATO";
  return origem || "SERVIÇO";
}

function montarStoragePath(registro: AnexoPendenteRegistro, zipFileName: string): string {
  const base = sanitizeZipFileName(registro.storageBasePath || "anexos");
  const osId = sanitizeZipFileName(registro.osId || "sem-os");
  const subfolder = sanitizeZipFileName(registro.storageSubfolder || "pendentes");
  const safeZip = sanitizeZipFileName(zipFileName || "anexo.zip");
  const random = Math.random().toString(36).slice(2);

  return `${base}/${osId}/${subfolder}/${Date.now()}-${random}-${safeZip}`;
}

async function enviarParaSupabase(registro: AnexoPendenteRegistro) {
  const compactado = await compactBlobToZip(
    registro.arquivoBlob,
    registro.nomeArquivo || "anexo",
    registro.mimeType || "application/octet-stream"
  );
  const path = montarStoragePath(registro, compactado.zipFileName);

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, compactado.blob, {
    upsert: false,
    contentType: ZIP_STORAGE_MIME,
  });

  if (error) {
    throw new Error(error.message || "Erro ao reenviar anexo ao Supabase.");
  }

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

  return {
    path,
    url: data.publicUrl,
    compactado,
  };
}

async function reenviarPdfOs(registro: AnexoPendenteRegistro) {
  validarCollection(registro.collectionName);

  const osRef = doc(db, registro.collectionName, registro.osId);
  const snap = await getDoc(osRef);
  if (!snap.exists()) {
    throw new Error("A OS não existe mais no banco de dados.");
  }

  const envio = await enviarParaSupabase(registro);
  const dataAnexoTexto = new Date().toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const dados = snap.data() as { anexosPendentes?: unknown };
  const anexosPendentes = Array.isArray(dados.anexosPendentes)
    ? dados.anexosPendentes.filter((item: any) => item?.id !== registro.id)
    : [];

  await updateDoc(osRef, {
    anexoStatus: "OK",
    ordemServicoPdfStatus: "OK",
    ordemServicoPdfPendenteId: null,
    anexosPendentes,
    ordemServicoPdfUrl: envio.url,
    ordemServicoPdfPath: envio.path,
    ordemServicoPdfNomeArquivo: registro.nomeArquivo,
    ordemServicoPdfDataAnexo: dataAnexoTexto,
    ordemServicoPdfCompactado: true,
    ordemServicoPdfNomeArquivoZip: envio.compactado.zipFileName,
    ordemServicoPdfMimeTypeOriginal: envio.compactado.originalMimeType,
    ordemServicoPdfTamanhoOriginal: envio.compactado.originalSize,
    ordemServicoPdfTamanhoCompactado: envio.compactado.zipSize,
    updatedAt: serverTimestamp(),
  });
}

async function reenviarFotoExecucao(registro: AnexoPendenteRegistro) {
  validarCollection(registro.collectionName);

  const osRef = doc(db, registro.collectionName, registro.osId);
  const snap = await getDoc(osRef);
  if (!snap.exists()) {
    throw new Error("A OS não existe mais no banco de dados.");
  }

  const dados = snap.data() as { fotosExecucao?: unknown };
  const fotosAtuais = Array.isArray(dados.fotosExecucao) ? dados.fotosExecucao : [];

  if (fotosAtuais.length >= 2) {
    throw new Error("Esta OS já possui 2 fotos de execução. Não é possível reenviar mais fotos.");
  }

  const envio = await enviarParaSupabase(registro);
  const dataAnexoTexto = new Date().toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const novoItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    nomeArquivo: registro.nomeArquivo,
    dataAnexoTexto,
    url: envio.url,
    path: envio.path,
    storagePath: envio.path,
    arquivoCompactado: true,
    nomeArquivoZip: envio.compactado.zipFileName,
    mimeTypeOriginal: envio.compactado.originalMimeType,
    tamanhoOriginal: envio.compactado.originalSize,
    tamanhoCompactado: envio.compactado.zipSize,
  };

  await updateDoc(osRef, {
    fotosExecucao: [...fotosAtuais, novoItem],
    updatedAt: serverTimestamp(),
  });
}

async function reenviarRegistro(registro: AnexoPendenteRegistro) {
  if (registro.tipo === "PDF_OS") {
    await reenviarPdfOs(registro);
  } else {
    await reenviarFotoExecucao(registro);
  }

  await removerAnexoPendente(registro.id);
  dispararAtualizacaoContador();
}

export default function AnexosPendentes() {
  const [anexos, setAnexos] = useState<AnexoPendenteRegistro[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [processingAll, setProcessingAll] = useState(false);
  const [filtroTipo, setFiltroTipo] = useState<FiltroTipo>("TODOS");
  const [busca, setBusca] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const anexosFiltrados = useMemo(() => {
    const termo = busca.trim().toUpperCase();

    return anexos.filter((item) => {
      const passaTipo = filtroTipo === "TODOS" || item.tipo === filtroTipo;
      if (!passaTipo) return false;
      if (!termo) return true;

      const texto = [
        item.osId,
        item.origem,
        item.collectionName,
        item.nomeArquivo,
        item.criadoPorEmail,
        item.ultimoErro,
      ]
        .join(" ")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();

      return texto.includes(termo.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    });
  }, [anexos, busca, filtroTipo]);

  const resumo = useMemo(() => {
    const pdfs = anexos.filter((item) => item.tipo === "PDF_OS").length;
    const fotos = anexos.filter((item) => item.tipo === "FOTO_EXECUCAO").length;
    const totalMb = anexos.reduce((acc, item) => acc + (item.tamanho || 0), 0);

    return { pdfs, fotos, total: anexos.length, totalMb };
  }, [anexos]);

  async function carregar() {
    try {
      setLoading(true);
      const lista = await listarAnexosPendentes();
      setAnexos(lista);
      dispararAtualizacaoContador();
    } catch (error) {
      console.error(error);
      setStatus({ type: "error", text: resumirErroAnexo(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void carregar();
  }, []);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function handleReenviar(registro: AnexoPendenteRegistro) {
    try {
      setProcessingId(registro.id);
      await reenviarRegistro(registro);
      setStatus({ type: "success", text: `Anexo ${registro.nomeArquivo} reenviado com sucesso.` });
      await carregar();
    } catch (error) {
      const erro = resumirErroAnexo(error);
      console.error(error);
      await atualizarErroAnexoPendente(registro.id, erro);
      setStatus({ type: "error", text: erro });
      await carregar();
    } finally {
      setProcessingId(null);
    }
  }

  async function handleReenviarTodos() {
    if (anexosFiltrados.length === 0) return;

    const confirmado = window.confirm(
      `Deseja tentar reenviar ${anexosFiltrados.length} anexo(s) pendente(s)?`
    );
    if (!confirmado) return;

    let enviados = 0;
    let falhas = 0;

    try {
      setProcessingAll(true);

      for (const registro of anexosFiltrados) {
        try {
          setProcessingId(registro.id);
          await reenviarRegistro(registro);
          enviados += 1;
        } catch (error) {
          falhas += 1;
          const erro = resumirErroAnexo(error);
          console.error(error);
          await atualizarErroAnexoPendente(registro.id, erro);
        }
      }

      setStatus({
        type: falhas > 0 ? "info" : "success",
        text: `Reenvio finalizado. Enviados: ${enviados}. Falhas: ${falhas}.`,
      });
      await carregar();
    } finally {
      setProcessingId(null);
      setProcessingAll(false);
    }
  }

  async function handleRemover(registro: AnexoPendenteRegistro) {
    const confirmado = window.confirm(
      `Remover este anexo somente da fila local?\n\nArquivo: ${registro.nomeArquivo}\nOS: ${registro.osId}`
    );
    if (!confirmado) return;

    try {
      setProcessingId(registro.id);
      await removerAnexoPendente(registro.id);
      setStatus({ type: "success", text: "Anexo removido da fila local." });
      await carregar();
    } catch (error) {
      console.error(error);
      setStatus({ type: "error", text: resumirErroAnexo(error) });
    } finally {
      setProcessingId(null);
    }
  }

  return (
    <section className="page-card anexos-pendentes-page">
      <div className="anexos-hero">
        <div>
          <span className="anexos-eyebrow">Fila local de recuperação</span>
          <h2>Anexos Pendentes</h2>
          <p>
            Reenvie PDFs e fotos que ficaram salvos neste computador quando houve falha de internet,
            Supabase ou conexão instável.
          </p>
        </div>
        <div className="anexos-hero-badge">
          <strong>{resumo.total}</strong>
          <span>pendente(s)</span>
        </div>
      </div>

      {status && <div className={`status-banner status-${status.type}`}>{status.text}</div>}

      <div className="anexos-summary-grid">
        <div className="anexos-summary-card">
          <span>PDF da OS</span>
          <strong>{resumo.pdfs}</strong>
        </div>
        <div className="anexos-summary-card">
          <span>Fotos de execução</span>
          <strong>{resumo.fotos}</strong>
        </div>
        <div className="anexos-summary-card">
          <span>Tamanho local</span>
          <strong>{formatarTamanho(resumo.totalMb)}</strong>
        </div>
      </div>

      <div className="anexos-toolbar">
        <div className="anexos-filter-group">
          <label>
            Tipo
            <select value={filtroTipo} onChange={(event) => setFiltroTipo(event.target.value as FiltroTipo)}>
              <option value="TODOS">TODOS OS ANEXOS</option>
              <option value="PDF_OS">PDF DA OS</option>
              <option value="FOTO_EXECUCAO">FOTOS DE EXECUÇÃO</option>
            </select>
          </label>
          <label>
            Buscar
            <input
              type="search"
              value={busca}
              onChange={(event) => setBusca(event.target.value)}
              placeholder="OS, serviço, arquivo, erro..."
            />
          </label>
        </div>

        <div className="anexos-toolbar-actions">
          <button type="button" className="btn-secondary" onClick={carregar} disabled={loading || processingAll}>
            Atualizar
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleReenviarTodos}
            disabled={loading || processingAll || anexosFiltrados.length === 0}
          >
            {processingAll ? "Reenviando..." : "Reenviar filtrados"}
          </button>
        </div>
      </div>

      <div className="anexos-alerta-local">
        <strong>Atenção:</strong> esta fila é local deste navegador. Se trocar de computador ou limpar os dados do navegador,
        os anexos pendentes salvos aqui podem não aparecer em outro lugar.
      </div>

      {loading ? (
        <div className="empty-state">
          <h3>Carregando anexos pendentes...</h3>
          <p>Consultando a fila local deste navegador.</p>
        </div>
      ) : anexosFiltrados.length === 0 ? (
        <div className="empty-state anexos-empty">
          <h3>Nenhum anexo pendente</h3>
          <p>Quando algum PDF ou foto falhar no envio, ele aparecerá aqui para reenvio.</p>
        </div>
      ) : (
        <div className="anexos-list">
          {anexosFiltrados.map((item) => {
            const processing = processingId === item.id || processingAll;
            return (
              <article className="anexos-item" key={item.id}>
                <div className="anexos-item-main">
                  <div className="anexos-item-topline">
                    <span className={`anexos-type-pill anexos-type-${item.tipo.toLowerCase()}`}>
                      {getTipoLabel(item.tipo)}
                    </span>
                    <span className="anexos-service-pill">{getOrigemLabel(item.origem)}</span>
                  </div>

                  <h3>{item.nomeArquivo}</h3>
                  <p>
                    OS <strong>{item.osId}</strong> · {formatarTamanho(item.tamanho)} · Criado em {formatarData(item.criadoEm)}
                  </p>
                  {item.criadoPorEmail && <p>Usuário: {item.criadoPorEmail}</p>}
                  {item.observacao && <p className="anexos-note">{item.observacao}</p>}
                  {item.ultimoErro && (
                    <div className="anexos-error-box">
                      <strong>Último erro:</strong> {item.ultimoErro}
                    </div>
                  )}
                </div>

                <div className="anexos-item-side">
                  <span className="anexos-attempts">Tentativas: {item.tentativas ?? 0}</span>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handleReenviar(item)}
                    disabled={processing}
                  >
                    {processing ? "Enviando..." : "Reenviar"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary anexos-danger-btn"
                    onClick={() => handleRemover(item)}
                    disabled={processing}
                  >
                    Remover local
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="anexos-footer-info">
        <strong>Como usar:</strong> depois que a internet voltar, clique em <b>Reenviar</b>. Se o envio der certo,
        o anexo sai da fila automaticamente e a OS é atualizada no Firestore.
      </div>
    </section>
  );
}
