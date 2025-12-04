// src/pages/TerceirizadaVisao.tsx
import React, { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import { db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";

// bucket do Supabase onde as OS estão sendo gravadas
const STORAGE_BUCKET = "os-arquivos";

// pdf-lib para gerar o PDF com dados da OS
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type OrigemOS = "buraco" | "asfalto";

type FirestoreOS = {
  id: string;
  origem: OrigemOS;

  tipo?: string;
  protocolo?: string | null;
  ordemServico?: string | null;
  bairro?: string | null;
  rua?: string | null;
  numero?: string | null;
  pontoReferencia?: string | null;
  observacoes?: string | null;
  status?: string | null;
  createdAt?: Timestamp | null;
  createdByEmail?: string | null;
  dataExecucao?: Timestamp | null;

  // PDF da papeleta (URL pública Supabase / Storage) – mantido por compatibilidade
  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;

  // Fotos da execução (terceirizada) – usadas na ListaOrdensServico
  fotosExecucao?: any[] | null;
};

type LocalPhoto = {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: string;
};

const tipoLabelMap: Record<string, string> = {
  BURACO_RUA: "Buraco na rua",
  ASFALTO: "Asfalto",
};

const tipoBadgeClassMap: Record<string, string> = {
  BURACO_RUA: "os-badge os-badge-buraco",
  ASFALTO: "os-badge os-badge-asfalto",
};

function isDoneStatus(status?: string | null): boolean {
  const s = (status || "").toUpperCase();
  return s === "CONCLUIDA" || s === "CONCLUIDO";
}

function statusClass(status?: string | null): string {
  const s = (status || "").toUpperCase();
  if (s === "CONCLUIDA" || s === "CONCLUIDO") {
    return "os-status-badge os-status-concluida";
  }
  if (s === "ANDAMENTO" || s === "EM_ANDAMENTO") {
    return "os-status-badge os-status-andamento";
  }
  if (s === "CANCELADA" || s === "CANCELADO") {
    return "os-status-badge os-status-cancelada";
  }
  return "os-status-badge os-status-aberta";
}

function formatCreatedAt(createdAt?: Timestamp | null): string {
  if (!createdAt) return "-";
  try {
    const d = createdAt.toDate();
    return d.toLocaleString("pt-BR", {
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

const generateLocalId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// remove acentos e caracteres estranhos para usar no path do Supabase
function sanitizeForStoragePath(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

// converte um dataURL (base64) em Blob para upload no Supabase
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/data:(.*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

// quebra texto dentro da largura no PDF
function wrapPdfText(
  text: string,
  font: any,
  fontSize: number,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    if (width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

// gera um PDF novo com todos os dados da OS (tabela) e devolve um ObjectURL
async function generateOsDataPdfUrl(os: FirestoreOS): Promise<string> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSizeTitle = 16;
  const fontSize = 10;
  const lineHeight = fontSize + 4;

  const marginLeft = 40;
  const marginRight = 40;
  const maxWidth = width - marginLeft - marginRight;

  let y = height - 60;

  // Título
  const titulo = `ORDEM DE SERVIÇO - ${
    os.ordemServico || os.protocolo || os.id
  }`;
  const titleWidth = boldFont.widthOfTextAtSize(titulo, fontSizeTitle);
  page.drawText(titulo, {
    x: (width - titleWidth) / 2,
    y,
    size: fontSizeTitle,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  y -= lineHeight * 2;

  const tipoLabel =
    tipoLabelMap[os.tipo || ""] ||
    os.tipo ||
    (os.origem === "asfalto" ? "Asfalto" : "Buraco na rua");

  const rows: { label: string; value: string }[] = [
    { label: "Tipo", value: tipoLabel },
    {
      label: "Origem",
      value: os.origem === "asfalto" ? "Asfalto" : "Buraco na rua",
    },
    { label: "Nº OS", value: os.ordemServico || "-" },
    { label: "Protocolo", value: os.protocolo || "-" },
    { label: "Bairro", value: os.bairro || "-" },
    { label: "Rua / Avenida", value: os.rua || "-" },
    { label: "Número", value: os.numero || "-" },
    { label: "Ponto de referência", value: os.pontoReferencia || "-" },
    { label: "Status", value: os.status || "ABERTA" },
    {
      label: "Data de criação",
      value: formatCreatedAt(os.createdAt),
    },
    {
      label: "Data de execução",
      value: formatCreatedAt(os.dataExecucao),
    },
    {
      label: "Criado por",
      value: os.createdByEmail || "-",
    },
    {
      label: "Observações",
      value:
        (os.observacoes || "")
          .replace(/\s+/g, " ")
          .trim() || "-",
    },
  ];

  const labelGap = 4;

  rows.forEach(({ label, value }) => {
    if (y < 80) {
      // se chegar muito perto do rodapé, poderia abrir nova página;
      // aqui simplificamos e paramos para não quebrar nada.
      return;
    }

    const labelText = `${label}: `;
    const labelWidth = boldFont.widthOfTextAtSize(labelText, fontSize);
    const valueLines = wrapPdfText(
      value,
      font,
      fontSize,
      maxWidth - labelWidth
    );

    // primeira linha: label + primeira linha do value
    const firstValueLine = valueLines[0] ?? "";
    page.drawText(labelText, {
      x: marginLeft,
      y,
      size: fontSize,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    page.drawText(firstValueLine, {
      x: marginLeft + labelWidth + labelGap,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });

    // demais linhas só com o value
    let currentY = y;
    for (let i = 1; i < valueLines.length; i++) {
      currentY -= lineHeight;
      page.drawText(valueLines[i], {
        x: marginLeft + labelWidth + labelGap,
        y: currentY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }

    y = currentY - lineHeight;
  });

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as unknown as BlobPart], {
    type: "application/pdf",
  });
  return URL.createObjectURL(blob);
}

const TerceirizadaVisao: React.FC = () => {
  const [ordensBuraco, setOrdensBuraco] = useState<FirestoreOS[]>([]);
  const [ordensAsfalto, setOrdensAsfalto] = useState<FirestoreOS[]>([]);

  const [busca, setBusca] = useState("");
  const [loading, setLoading] = useState(true);

  // Abas de status: Abertas / Concluídas / Todas
  const [statusTab, setStatusTab] = useState<"ALL" | "OPEN" | "DONE">("OPEN");

  // Filtro por categoria de serviço (tipo)
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");

  // OS selecionada no modal
  const [modalOs, setModalOs] = useState<FirestoreOS | null>(null);

  // Fotos em memória, por OS (somente na sessão atual)
  const [photosByOsId, setPhotosByOsId] = useState<Record<string, LocalPhoto[]>>(
    {}
  );

  // Se deve mostrar o campo de upload no modal
  const [showPhotoUploader, setShowPhotoUploader] = useState(false);

  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  // Modal de informação (substitui alert())
  const [infoModal, setInfoModal] = useState<{
    title: string;
    message: string;
  } | null>(null);

  // ======= CARREGAR OS DE BURACO + ASFALTO =======
  useEffect(() => {
    // Buraco na Rua (calçamento) – coleção ordens_servico
    const qBuraco = query(
      collection(db, "ordens_servico"),
      orderBy("createdAt", "desc")
    );

    const unsubBuraco = onSnapshot(
      qBuraco,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = raw.ordemServicoPdf ?? null;

          return {
            id: d.id,
            origem: "buraco",
            tipo: raw.tipo || "BURACO_RUA",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,

            // Compatibilidade: tenta primeiro os campos novos (bairro, rua, pontoReferencia),
            // se não tiver, usa alternativas que possam existir em documentos antigos.
            bairro:
              raw.bairro ?? 
              raw.bairroLocal ?? 
              raw.bairro_os ?? 
              null,
            rua:
              raw.rua ?? 
              raw.logradouro ?? 
              raw.ruaAvenida ?? 
              null,
            numero:
              raw.numero ?? 
              raw.numeroCasa ?? 
              null,
            pontoReferencia:
              raw.pontoReferencia ?? 
              raw.referencia ?? 
              raw.ponto ?? 
              null,

            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
            fotosExecucao: raw.fotosExecucao ?? null,
          };
        });
        setOrdensBuraco(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setInfoModal({
          title: "Erro ao carregar ordens",
          message:
            "Não foi possível carregar as ordens de Buraco na rua. Verifique sua conexão e tente novamente.",
        });
      }
    );

    // Asfalto – coleção ordensServico
    const qAsfalto = query(
      collection(db, "ordensServico"),
      orderBy("createdAt", "desc")
    );

    const unsubAsfalto = onSnapshot(
      qAsfalto,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = raw.ordemServicoPdf ?? null;

          return {
            id: d.id,
            origem: "asfalto",
            tipo: raw.tipo || "ASFALTO",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,

            // Mesmo padrão de compatibilidade
            bairro:
              raw.bairro ?? 
              raw.bairroLocal ?? 
              raw.bairro_os ?? 
              null,
            rua:
              raw.rua ?? 
              raw.logradouro ?? 
              raw.ruaAvenida ?? 
              null,
            numero:
              raw.numero ?? 
              raw.numeroCasa ?? 
              null,
            pontoReferencia:
              raw.pontoReferencia ?? 
              raw.referencia ?? 
              raw.ponto ?? 
              null,

            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
            fotosExecucao: raw.fotosExecucao ?? null,
          };
        });
        setOrdensAsfalto(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setInfoModal({
          title: "Erro ao carregar ordens",
          message:
            "Não foi possível carregar as ordens de Asfalto. Verifique sua conexão e tente novamente.",
        });
      }
    );

    return () => {
      unsubBuraco();
      unsubAsfalto();
    };
  }, []);

  // Todas as ordens, combinadas
  const ordens = useMemo(() => {
    return [...ordensBuraco, ...ordensAsfalto];
  }, [ordensBuraco, ordensAsfalto]);

  // 1) Filtra por status (aba)
  const porStatus = useMemo(() => {
    return ordens.filter((os) => {
      if (statusTab === "ALL") return true;
      const done = isDoneStatus(os.status);
      if (statusTab === "OPEN") return !done;
      if (statusTab === "DONE") return done;
      return true;
    });
  }, [ordens, statusTab]);

  // 2) Contador por tipo (para o submenu de categorias)
  const countsPorTipo = useMemo(() => {
    const counts: Record<string, number> = {};
    porStatus.forEach((os) => {
      const tipo = os.tipo || "OUTRO";
      counts[tipo] = (counts[tipo] || 0) + 1;
    });
    return counts;
  }, [porStatus]);

  // 3) Filtra por categoria + texto
  const filtradas = useMemo(() => {
    const texto = busca.trim().toLowerCase();

    const base =
      categoryFilter === "ALL"
        ? porStatus
        : porStatus.filter((os) => (os.tipo || "OUTRO") === categoryFilter);

    if (!texto) return base;

    return base.filter((os) => {
      const dataAbertura = formatCreatedAt(os.createdAt).toLowerCase();
      return (
        os.protocolo?.toLowerCase().includes(texto) ||
        os.ordemServico?.toLowerCase().includes(texto) ||
        os.bairro?.toLowerCase().includes(texto) ||
        os.rua?.toLowerCase().includes(texto) ||
        dataAbertura.includes(texto)
      );
    });
  }, [busca, porStatus, categoryFilter]);

  // Agrupa as filtradas por tipo
  const gruposPorTipo = useMemo(() => {
    const grupos: Record<string, FirestoreOS[]> = {};
    filtradas.forEach((os) => {
      const tipo = os.tipo || "OUTRO";
      if (!grupos[tipo]) grupos[tipo] = [];
      grupos[tipo].push(os);
    });
    return grupos;
  }, [filtradas]);

  const tiposOrdenados = useMemo(
    () => Object.keys(gruposPorTipo).sort((a, b) => a.localeCompare(b)),
    [gruposPorTipo]
  );

  const tiposCategoriaOrdenados = useMemo(
    () => Object.keys(countsPorTipo).sort((a, b) => a.localeCompare(b)),
    [countsPorTipo]
  );

  // Fotos da OS aberta no modal (apenas para visualização/obrigatoriedade)
  const currentPhotos: LocalPhoto[] = useMemo(() => {
    if (!modalOs) return [];
    return photosByOsId[modalOs.id] || [];
  }, [modalOs, photosByOsId]);

  const totalAbertas = ordens.filter((os) => !isDoneStatus(os.status)).length;
  const totalConcluidas = ordens.filter((os) =>
    isDoneStatus(os.status)
  ).length;

  function handleOpenOsModal(os: FirestoreOS) {
    setModalOs(os);
    setShowPhotoUploader(false);
  }

  function handleCloseModal() {
    setModalOs(null);
    setShowPhotoUploader(false);
  }

  function handleModalFilesChange(e: ChangeEvent<HTMLInputElement>) {
    if (!modalOs) return;

    const files = e.target.files;
    if (!files || files.length === 0) return;

    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

    Array.from(files).forEach((file) => {
      if (!allowed.includes(file.type)) {
        setInfoModal({
          title: "Arquivo não suportado",
          message: `O arquivo "${file.name}" não é uma imagem válida. Use formatos JPG, PNG ou WEBP.`,
        });
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const nowText = new Date().toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        const photo: LocalPhoto = {
          id: generateLocalId(),
          name: file.name,
          dataUrl,
          createdAt: nowText,
        };

        setPhotosByOsId((prev) => {
          const prevForOs = prev[modalOs.id] || [];
          return {
            ...prev,
            [modalOs.id]: [...prevForOs, photo],
          };
        });
      };
      reader.readAsDataURL(file);
    });

    e.target.value = "";
  }

  function handleRemoveModalPhoto(id: string) {
    if (!modalOs) return;
    setPhotosByOsId((prev) => {
      const prevForOs = prev[modalOs.id] || [];
      return {
        ...prev,
        [modalOs.id]: prevForOs.filter((p) => p.id !== id),
      };
    });
  }

  async function handleServicoExecutado() {
    if (!modalOs) return;

    // exige pelo menos uma foto
    if (currentPhotos.length === 0) {
      setShowPhotoUploader(true);
      setInfoModal({
        title: "Foto obrigatória",
        message:
          "Para marcar esta OS como concluída, anexe pelo menos uma foto do serviço executado.",
      });
      return;
    }

    try {
      setIsUpdatingStatus(true);

      const collectionName =
        modalOs.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      const basePath =
        modalOs.origem === "asfalto" ? "asfalto" : "buraco-rua";
      const subfolder = "fotos-execucao";

      const agora = new Date();

      const novosItens: any[] = [];

      for (const photo of currentPhotos) {
        const originalName = photo.name || "foto.jpg";
        const safeName = sanitizeForStoragePath(originalName);

        const id = photo.id || generateLocalId();

        const path = `${basePath}/${modalOs.id}/${subfolder}/${id}-${safeName}`;

        const blob = dataUrlToBlob(photo.dataUrl);

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, blob, { upsert: true });

        if (uploadError) {
          console.error(uploadError);
          throw new Error(
            `Erro ao enviar foto "${originalName}" para o armazenamento.`
          );
        }

        const { data } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(path);

        const url = data.publicUrl;

        const dataAnexoTexto =
          photo.createdAt ||
          agora.toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

        novosItens.push({
          id,
          nomeArquivo: originalName,
          dataAnexoTexto,
          url,
        });
      }

      const originalArray: any[] = modalOs.fotosExecucao || [];
      const updatedArray = [...originalArray, ...novosItens];

      await updateDoc(doc(db, collectionName, modalOs.id), {
        status: "CONCLUIDA",
        dataExecucao: serverTimestamp(),
        fotosExecucao: updatedArray,
      });

      // Limpa fotos em memória para essa OS
      setPhotosByOsId((prev) => {
        const clone = { ...prev };
        delete clone[modalOs.id];
        return clone;
      });
      setShowPhotoUploader(false);

      // Atualiza o modal com o novo status e fotosExecucao
      setModalOs((prev) =>
        prev && prev.id === modalOs.id
          ? { ...prev, status: "CONCLUIDA", fotosExecucao: updatedArray }
          : prev
      );

      setInfoModal({
        title: "Status atualizado",
        message: "A OS foi marcada como serviço executado (concluída).",
      });
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao atualizar",
        message:
          "Não foi possível atualizar o status da OS. Verifique sua conexão e tente novamente.",
      });
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  // IMPRIMIR: gera PDF com os dados da OS (tabela) e envia para impressão
  async function handlePrintModal() {
    if (!modalOs) return;

    try {
      const url = await generateOsDataPdfUrl(modalOs);

      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.src = url;

      document.body.appendChild(iframe);

      iframe.onload = () => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        setTimeout(() => {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(url);
        }, 1000);
      };
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao imprimir",
        message:
          "Não foi possível gerar o PDF com os dados da OS para impressão. Tente novamente.",
      });
    }
  }

  return (
    <section className="page-card terceirizada-page">
      <header className="page-header">
        <div>
          <h2>Área terceirizada</h2>
          <p>
            Aqui a empresa terceirizada acompanha e registra a execução das
            ordens de serviço abertas pelo setor operacional.
          </p>
        </div>
      </header>

      {/* Hero / descrição */}
      <div className="terceirizada-banner">
        <div>
          <span className="terceirizada-pill">VISÃO DA TERCEIRIZADA</span>
          <h2>Fila de atendimento unificada</h2>
          <p className="page-section-description">
            Todas as OS de buraco, asfalto e esgoto em um só lugar. Ao concluir
            o serviço, será solicitado pelo menos uma foto do local atendido.
          </p>
        </div>

        <div className="terceirizada-highlight">
          <div className="terceirizada-icon">🚧</div>
          <p>
            É de suma importância que as Ordens de Serviço sejam marcadas como
            “Executada” na mesma data em que a execução for realizada. Pedimos
            especial atenção para que todos os registros permaneçam corretos e
            alinhados com a data real da execução.
          </p>
        </div>
      </div>

      {/* KPI cards rápidos */}
      <div className="os-kpi-row">
        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">OS em aberto</div>
            <div className="os-kpi-value">{totalAbertas}</div>
          </div>
          <span className="os-kpi-pill">Na fila de execução</span>
        </div>

        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">OS concluídas</div>
            <div className="os-kpi-value">{totalConcluidas}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-success">
            Serviço finalizado
          </span>
        </div>

        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">Total de OS</div>
            <div className="os-kpi-value">{ordens.length}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-neutral">
            Atualizado em tempo real
          </span>
        </div>
      </div>

      {/* FILTROS + BUSCA */}
      <div className="os-toolbar">
        {/* Linha 1 – abas de status */}
        <div className="os-status-tabs" style={{ marginBottom: "0.5rem" }}>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "OPEN" ? "is-active" : ""}`}
            onClick={() => {
              setStatusTab("OPEN");
              setCategoryFilter("ALL");
            }}
          >
            Abertas ({totalAbertas})
          </button>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "DONE" ? "is-active" : ""}`}
            onClick={() => {
              setStatusTab("DONE");
              setCategoryFilter("ALL");
            }}
          >
            Concluídas ({totalConcluidas})
          </button>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "ALL" ? "is-active" : ""}`}
            onClick={() => {
              setStatusTab("ALL");
              setCategoryFilter("ALL");
            }}
          >
            Todas ({ordens.length})
          </button>
        </div>

        {/* Linha 2 – submenu (tipos) + barra de busca */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          {tiposCategoriaOrdenados.length > 0 && (
            <div className="os-category-tabs">
              <button
                type="button"
                className={`os-category-tab ${categoryFilter === "ALL" ? "is-active" : ""}`}
                onClick={() => setCategoryFilter("ALL")}
              >
                Todas ({porStatus.length})
              </button>

              {tiposCategoriaOrdenados.map((tipo) => {
                let label: string;
                if (tipo === "ASFALTO") {
                  label = "asfalto";
                } else if (tipo === "BURACO_RUA") {
                  label = "Buraco na rua";
                } else {
                  label = tipoLabelMap[tipo] || tipo || "Outro";
                }

                const count = countsPorTipo[tipo];

                return (
                  <button
                    key={tipo}
                    type="button"
                    className={`os-category-tab ${categoryFilter === tipo ? "is-active" : ""}`}
                    onClick={() => setCategoryFilter(tipo)}
                  >
                    {label} ({count})
                  </button>
                );
              })}
            </div>
          )}

          <div className="os-search">
            <input
              className="os-search-input"
              type="text"
              placeholder="Buscar por protocolo, OS, bairro, rua ou data (dd/mm/aaaa)..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* LISTAGEM PRINCIPAL */}
      <div className="os-main">
        {!loading && filtradas.length === 0 && (
          <div className="os-empty">
            Nenhuma ordem encontrada para os filtros atuais.
          </div>
        )}

        {tiposOrdenados.map((tipo) => {
          const lista = gruposPorTipo[tipo];
          const label = tipoLabelMap[tipo] || tipo || "Outro";
          const badgeClass =
            tipoBadgeClassMap[tipo] || "os-badge os-badge-outro";

          return (
            <section key={tipo} className="os-group-section">
              <div className="os-group-header">
                <div>
                  <span className={badgeClass}>{label}</span>
                </div>
                <span className="os-group-count">
                  {lista.length} OS{" "}
                  {statusTab === "OPEN"
                    ? "em aberto"
                    : statusTab === "DONE"
                    ? "concluída(s)"
                    : "encontrada(s)"}
                </span>
              </div>

              <div className="os-list">
                {lista.map((os) => (
                  <article
                    key={os.id}
                    className="os-card"
                    onClick={() => handleOpenOsModal(os)}
                    role="button"
                  >
                    <div className="os-card-header">
                      <div>
                        <h3>
                          {os.protocolo ||
                            os.ordemServico ||
                            "Sem identificação"}
                        </h3>
                        <p className="os-card-address">
                          {[
                            os.rua,
                            os.numero ? "nº " + os.numero : "",
                            os.bairro ? " – " + os.bairro : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || "Endereço não informado"}
                        </p>
                      </div>
                      <div>
                        <span className={statusClass(os.status)}>
                          {os.status || "ABERTA"}
                        </span>
                      </div>
                    </div>

                    <div className="os-card-meta">
                      <span>Criado em {formatCreatedAt(os.createdAt)}</span>
                      {os.createdByEmail && (
                        <span>Por {os.createdByEmail}</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* MODAL DE DETALHES DA OS */}
      {modalOs && (
        <div className="modal-backdrop" onClick={handleCloseModal}>
          <div
            className="modal modal-photo"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                Detalhes da OS –{" "}
                {modalOs.protocolo ||
                  modalOs.ordemServico ||
                  "Sem identificação"}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={handleCloseModal}
              >
                ×
              </button>
            </div>

            <div className="modal-body modal-photo-body">
              <div className="page-form-grid">
                <div className="page-field">
                  <label>Tipo</label>
                  <input
                    className="field-readonly"
                    value={
                      tipoLabelMap[modalOs.tipo || ""] ||
                      modalOs.tipo ||
                      "-"
                    }
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Protocolo</label>
                  <input
                    className="field-readonly"
                    value={modalOs.protocolo || "-"}
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Ordem de serviço</label>
                  <input
                    className="field-readonly"
                    value={modalOs.ordemServico || "-"}
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Status atual</label>
                  <input
                    className="field-readonly"
                    value={modalOs.status || "ABERTA"}
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Endereço</label>
                  <input
                    className="field-readonly"
                    value={
                      [
                        modalOs.rua,
                        modalOs.numero ? "nº " + modalOs.numero : "",
                        modalOs.bairro ? " – " + modalOs.bairro : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || "-"
                    }
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Ponto de referência</label>
                  <input
                    className="field-readonly"
                    value={modalOs.pontoReferencia || "-"}
                    readOnly
                  />
                </div>
              </div>

              <div className="page-field">
                <label>Observações</label>
                <textarea
                  className="field-readonly"
                  value={modalOs.observacoes || "-"}
                  readOnly
                  rows={3}
                />
              </div>

              <div className="page-section">
                <h3>Fotos do serviço executado</h3>
                <p className="page-section-description">
                  Ao marcar como concluída, será solicitado anexar pelo menos
                  uma foto. As imagens abaixo ficam apenas nesta sessão.
                </p>

                {currentPhotos.length > 0 ? (
                  <div className="page-photos-block">
                    <div className="photo-preview-grid">
                      {currentPhotos.map((p) => (
                        <div key={p.id} className="photo-preview-item">
                          <img src={p.dataUrl} alt={p.name} />
                          <span className="photo-timestamp">
                            {p.createdAt}
                          </span>
                          <button
                            type="button"
                            className="btn-secondary"
                            style={{
                              position: "absolute",
                              top: "0.3rem",
                              right: "0.3rem",
                              padding: "0.1rem 0.5rem",
                              fontSize: "0.7rem",
                            }}
                            onClick={() => handleRemoveModalPhoto(p.id)}
                          >
                            Excluir
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="photo-hint">
                    Nenhuma foto anexada ainda para esta OS.
                  </p>
                )}

                <div
                  className="page-photos-block"
                  style={{ marginTop: "0.6rem" }}
                >
                  <div className="photo-upload">
                    <label
                      htmlFor="upload-fotos-modal"
                      className="btn-secondary"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        cursor: "pointer",
                      }}
                    >
                      📷 Adicionar fotos do serviço
                    </label>
                    <input
                      id="upload-fotos-modal"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/jpg"
                      multiple
                      onChange={handleModalFilesChange}
                      style={{ display: "none" }}
                    />
                    {showPhotoUploader && (
                      <p className="photo-hint">
                        Anexe pelo menos uma foto do serviço executado para
                        concluir esta OS.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={handlePrintModal}
              >
                Imprimir
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleServicoExecutado}
                disabled={isUpdatingStatus}
              >
                {isUpdatingStatus ? "Atualizando..." : "Serviço executado"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE AVISO / ERRO */}
      {infoModal && (
        <div className="modal-backdrop" onClick={() => setInfoModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{infoModal.title}</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setInfoModal(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>{infoModal.message}</p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setInfoModal(null)}
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default TerceirizadaVisao;
