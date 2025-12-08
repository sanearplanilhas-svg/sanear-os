import React, {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type MouseEvent,
  useRef,
} from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  doc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import { db, auth } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";

// pdf-lib para gerar o PDF com os dados da OS
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const STORAGE_BUCKET = "os-arquivos";

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

  // ainda mantido por compatibilidade, mas não usado para gerar o PDF de dados
  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;

  // fotos
  fotos?: any[] | null; // operador (abertura)
  fotosExecucao?: any[] | null; // terceirizada (execução)
};

type StatusType = "success" | "error" | "info";

type NormalizedPhoto = {
  id: string;
  label: string;
  url: string;
  sourceIndex: number; // índice original no array salvo no Firestore
};

// FRONTEND APENAS: labels amigáveis
const tipoLabelMap: Record<string, string> = {
  BURACO_RUA: "Calçamento",
  ASFALTO: "Asfalto",
};

function formatDateTime(value?: Timestamp | null): string {
  try {
    if (!value) return "-";
    const date = value.toDate();
    return date.toLocaleString("pt-BR", {
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

function normalizeFotos(fotos: any): NormalizedPhoto[] {
  if (!Array.isArray(fotos)) return [];
  return fotos
    .map((f, index) => {
      if (!f) return null;

      const url =
        (typeof f.base64 === "string" && f.base64) ||
        (typeof f.url === "string" && f.url) ||
        (typeof f.publicUrl === "string" && f.publicUrl) ||
        (typeof f.downloadURL === "string" && f.downloadURL) ||
        (typeof f === "string" ? f : "");

      if (!url) return null;

      const nomeArquivo =
        typeof f.nomeArquivo === "string" ? f.nomeArquivo : `Foto ${index + 1}`;
      const dataTexto =
        typeof f.dataAnexoTexto === "string"
          ? f.dataAnexoTexto
          : typeof f.timestamp === "string"
          ? f.timestamp
          : "";

      const label = dataTexto ? `${nomeArquivo} – ${dataTexto}` : nomeArquivo;
      const id = typeof f.id === "string" ? f.id : String(index);

      return {
        id,
        label,
        url,
        sourceIndex: index,
      } as NormalizedPhoto;
    })
    .filter((p): p is NormalizedPhoto => p !== null);
}

// helper para quebrar o texto dentro da largura no PDF
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

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

// remove acentos e caracteres estranhos para usar no path do Supabase
function sanitizeForStoragePath(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

type PhotoModalTipo = "abertura" | "execucao";

type PhotoModalState = {
  os: FirestoreOS;
  tipo: PhotoModalTipo; // operador (abertura) ou terceirizada (execução)
  currentIndex: number;
};

// Normaliza o nome dos campos de fotos da abertura (operador)
function resolveFotosAbertura(raw: any): any[] | null {
  return (
    raw.fotos ??
    raw.fotosAbertura ??
    raw.fotos_abertura ??
    raw.fotosServico ??
    raw.fotos_servico ??
    null
  );
}

// Normaliza o nome dos campos de fotos da execução (terceirizada)
function resolveFotosExecucao(raw: any): any[] | null {
  return (
    raw.fotosExecucao ??
    raw.fotos_execucao ??
    raw.fotosServicoExecucao ??
    raw.fotos_servico_execucao ??
    null
  );
}

const ListaOrdensServico: React.FC = () => {
  const [ordensBuraco, setOrdensBuraco] = useState<FirestoreOS[]>([]);
  const [ordensAsfalto, setOrdensAsfalto] = useState<FirestoreOS[]>([]);

  const [busca, setBusca] = useState("");
  const [loading, setLoading] = useState(true);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");

  // modal de detalhes (texto / edição)
  const [detailsModalOs, setDetailsModalOs] = useState<FirestoreOS | null>(null);

  // modal do PDF com dados da OS
  const [pdfModalOs, setPdfModalOs] = useState<FirestoreOS | null>(null);
  const [pdfModalUrl, setPdfModalUrl] = useState<string | null>(null);
  const [pdfModalLoading, setPdfModalLoading] = useState(false);

  // modal de fotos (abertura / execução)
  const [photoModal, setPhotoModal] = useState<PhotoModalState | null>(null);
  const addPhotoInputRef = useRef<HTMLInputElement | null>(null);

  // usuário atual (para controle de edição)
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  // estado de edição dentro do modal de detalhes
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);

  useEffect(() => {
    const user = auth.currentUser;
    setCurrentUserEmail(user?.email ?? null);

    // alinhado com App.tsx (sanear-role), com fallback para userRole
    const storedRole =
      localStorage.getItem("sanear-role") ?? localStorage.getItem("userRole");
    setCurrentUserRole(storedRole);
  }, []);

  useEffect(() => {
    // Calçamento (coleção ordens_servico)
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
            bairro: raw.bairro ?? null,
            rua: raw.rua ?? null,
            numero: raw.numero ?? null,
            pontoReferencia: raw.pontoReferencia ?? null,
            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
          };
        });
        setOrdensBuraco(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatusMessage(
          "Não foi possível carregar as ordens de Calçamento. Verifique sua conexão e tente novamente."
        );
        setStatusType("error");
      }
    );

    // Asfalto (ordensServico)
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
            bairro: raw.bairro ?? null,
            rua: raw.rua ?? null,
            numero: raw.numero ?? null,
            pontoReferencia: raw.pontoReferencia ?? raw.referencia ?? null,
            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
          };
        });
        setOrdensAsfalto(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatusMessage(
          "Não foi possível carregar as ordens de Asfalto. Verifique sua conexão e tente novamente."
        );
        setStatusType("error");
      }
    );

    return () => {
      unsubBuraco();
      unsubAsfalto();
    };
  }, []);

  // regra de permissão: criador OU admin OU diretor
  const canEditOs = (os: FirestoreOS): boolean => {
    const emailAtual = currentUserEmail?.toLowerCase() ?? null;
    const emailCriador = os.createdByEmail?.toLowerCase() ?? null;

    const isCreator =
      !!emailAtual && !!emailCriador && emailAtual === emailCriador;

    const role = currentUserRole?.toUpperCase() ?? "";
    const isAdmin = role === "ADMIN" || role === "ADM";
    const isDiretor =
      role === "DIRETOR" || role === "DIRETORIA" || role === "DIR";

    return isCreator || isAdmin || isDiretor;
  };

  const ordens = useMemo(() => {
    const todas = [...ordensBuraco, ...ordensAsfalto];
    return todas.sort((a, b) => {
      const aMillis =
        a.createdAt && typeof a.createdAt.toMillis === "function"
          ? a.createdAt.toMillis()
          : 0;
      const bMillis =
        b.createdAt && typeof b.createdAt.toMillis === "function"
          ? b.createdAt.toMillis()
          : 0;
      return bMillis - aMillis;
    });
  }, [ordensBuraco, ordensAsfalto]);

  const filtradas = useMemo(() => {
    const texto = busca.trim().toLowerCase();
    if (!texto) return ordens;

    return ordens.filter((os) => {
      const dataCriacao = formatDateTime(os.createdAt).toLowerCase();
      const dataExec = formatDateTime(os.dataExecucao).toLowerCase();

      return (
        os.ordemServico?.toLowerCase().includes(texto) ||
        os.protocolo?.toLowerCase().includes(texto) ||
        os.bairro?.toLowerCase().includes(texto) ||
        os.rua?.toLowerCase().includes(texto) ||
        dataCriacao.includes(texto) ||
        dataExec.includes(texto)
      );
    });
  }, [busca, ordens]);

  function handleSearchChange(e: ChangeEvent<HTMLInputElement>) {
    setBusca(e.target.value);
  }

  // gera um PDF novo com todos os dados da OS em formato de "tabela"
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
      (os.origem === "asfalto" ? "Asfalto" : "Calçamento");

    const rows: { label: string; value: string }[] = [
      { label: "Tipo", value: tipoLabel },
      {
        label: "Origem",
        value: os.origem === "asfalto" ? "Asfalto" : "Calçamento",
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
        value: formatDateTime(os.createdAt),
      },
      {
        label: "Data de execução",
        value: formatDateTime(os.dataExecucao),
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
        return;
      }

      const labelText = `${label}: `;
      const labelWidth = boldFont.widthOfTextAtSize(labelText, fontSize);
      const valueLines = wrapPdfText(value, font, fontSize, maxWidth - labelWidth);

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

  // abrir modal de PDF com dados da OS
  async function handleOpenPdfModal(
    os: FirestoreOS,
    e: MouseEvent<HTMLButtonElement>
  ) {
    e.stopPropagation();

    if (pdfModalUrl) {
      URL.revokeObjectURL(pdfModalUrl);
      setPdfModalUrl(null);
    }

    setPdfModalOs(os);
    setPdfModalLoading(true);

    try {
      const url = await generateOsDataPdfUrl(os);
      setPdfModalUrl(url);
    } catch (err) {
      console.error(err);
      setStatusMessage(
        "Não foi possível gerar o PDF com os dados da OS. Tente novamente."
      );
      setStatusType("error");
      setPdfModalOs(null);
    } finally {
      setPdfModalLoading(false);
    }
  }

  function closePdfModal() {
    if (pdfModalUrl) {
      URL.revokeObjectURL(pdfModalUrl);
    }
    setPdfModalUrl(null);
    setPdfModalOs(null);
    setPdfModalLoading(false);
  }

  // Imprimir usando o mesmo comportamento do Dashboard:
  // dispara a caixa de impressão do navegador para a tela atual
  function handlePrintCurrentPdf() {
    window.print();
  }

  async function handleDeleteOs(os: FirestoreOS) {
    const confirmDelete = window.confirm(
      "Tem certeza que deseja excluir esta ordem de serviço? Esta ação não pode ser desfeita."
    );
    if (!confirmDelete) return;

    try {
      const collectionName =
        os.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      await deleteDoc(doc(db, collectionName, os.id));
      setDetailsModalOs(null);
      setStatusMessage("Ordem de serviço excluída com sucesso.");
      setStatusType("success");
    } catch (error) {
      console.error(error);
      setStatusMessage(
        "Não foi possível excluir a ordem de serviço. Tente novamente."
      );
      setStatusType("error");
    }
  }

  function closeDetailsModal() {
    setDetailsModalOs(null);
    setIsEditingDetails(false);
  }

  // salvar alterações dos campos editados (modal de detalhes)
  async function handleSaveDetails() {
    if (!detailsModalOs) return;
    if (!canEditOs(detailsModalOs)) {
      setStatusMessage("Você não tem permissão para editar esta OS.");
      setStatusType("error");
      return;
    }

    try {
      setSavingDetails(true);

      const collectionName =
        detailsModalOs.origem === "asfalto"
          ? "ordensServico"
          : "ordens_servico";

      await updateDoc(doc(db, collectionName, detailsModalOs.id), {
        ordemServico: detailsModalOs.ordemServico || null,
        protocolo: detailsModalOs.protocolo || null,
        bairro: detailsModalOs.bairro || null,
        rua: detailsModalOs.rua || null,
        numero: detailsModalOs.numero || null,
        pontoReferencia: detailsModalOs.pontoReferencia || null,
        observacoes: detailsModalOs.observacoes || null,
        status: detailsModalOs.status || null,
        updatedAt: serverTimestamp(),
      });

      setStatusMessage("Ordem de serviço atualizada com sucesso.");
      setStatusType("success");
      setIsEditingDetails(false);
    } catch (error) {
      console.error(error);
      setStatusMessage(
        "Não foi possível atualizar a ordem de serviço. Tente novamente."
      );
      setStatusType("error");
    } finally {
      setSavingDetails(false);
    }
  }

  // fotos só para usar nos botões / modal de fotos
  const fotosAberturaDetalhes: NormalizedPhoto[] = useMemo(() => {
    if (!detailsModalOs) return [];
    return normalizeFotos(detailsModalOs.fotos);
  }, [detailsModalOs]);

  const fotosExecucaoDetalhes: NormalizedPhoto[] = useMemo(() => {
    if (!detailsModalOs) return [];
    return normalizeFotos(detailsModalOs.fotosExecucao);
  }, [detailsModalOs]);

  const canEditCurrent =
    detailsModalOs && canEditOs(detailsModalOs) ? true : false;
  const readOnlyEditableFields = !isEditingDetails || !canEditCurrent;

  // ------- MODAL DE FOTOS (ABERTURA / EXECUÇÃO) ---------

  function openPhotoModalForOs(os: FirestoreOS, preferido?: PhotoModalTipo) {
    const temAbertura = normalizeFotos(os.fotos).length > 0;
    const temExecucao = normalizeFotos(os.fotosExecucao).length > 0;

    let tipo: PhotoModalTipo = "abertura";

    if (preferido) {
      tipo = preferido;
    } else if (!temAbertura && temExecucao) {
      tipo = "execucao";
    } else {
      tipo = "abertura";
    }

    setPhotoModal({
      os,
      tipo,
      currentIndex: 0,
    });
  }

  function openPhotoModalFromDetails(tipo: PhotoModalTipo) {
    if (!detailsModalOs) return;
    openPhotoModalForOs(detailsModalOs, tipo);
  }

  function openPhotoModalFromRow(os: FirestoreOS) {
    openPhotoModalForOs(os);
  }

  function closePhotoModal() {
    setPhotoModal(null);
  }

  function getFotosFromModalState(state: PhotoModalState | null): NormalizedPhoto[] {
    if (!state) return [];
    const { os, tipo } = state;
    return normalizeFotos(tipo === "abertura" ? os.fotos : os.fotosExecucao);
  }

  function goToNextPhoto() {
    setPhotoModal((prev) => {
      if (!prev) return prev;
      const fotos = getFotosFromModalState(prev);
      if (fotos.length === 0) return prev;
      const nextIndex = (prev.currentIndex + 1) % fotos.length;
      return { ...prev, currentIndex: nextIndex };
    });
  }

  function goToPrevPhoto() {
    setPhotoModal((prev) => {
      if (!prev) return prev;
      const fotos = getFotosFromModalState(prev);
      if (fotos.length === 0) return prev;
      const prevIndex = (prev.currentIndex - 1 + fotos.length) % fotos.length;
      return { ...prev, currentIndex: prevIndex };
    });
  }

  async function handleDeleteCurrentPhoto() {
    if (!photoModal) return;
    if (!canEditOs(photoModal.os)) {
      setStatusMessage("Você não tem permissão para excluir fotos desta OS.");
      setStatusType("error");
      return;
    }

    const fotosNormalizadas = getFotosFromModalState(photoModal);
    if (fotosNormalizadas.length === 0) return;

    const confirmDelete = window.confirm(
      "Tem certeza que deseja excluir esta foto?"
    );
    if (!confirmDelete) return;

    const { os, tipo, currentIndex } = photoModal;
    const fotoAtual = fotosNormalizadas[currentIndex];

    try {
      const collectionName =
        os.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      const originalArray: any[] =
        (tipo === "abertura" ? os.fotos : os.fotosExecucao) || [];

      const updatedArray = originalArray.filter(
        (_f, idx) => idx !== fotoAtual.sourceIndex
      );

      await updateDoc(doc(db, collectionName, os.id), {
        [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
        updatedAt: serverTimestamp(),
      });

      setDetailsModalOs((prev) => {
        if (!prev || prev.id !== os.id) return prev;
        return {
          ...prev,
          [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
        } as FirestoreOS;
      });

      const normalizadosNovos = normalizeFotos(updatedArray);
      let newIndex = currentIndex;
      if (normalizadosNovos.length === 0) {
        newIndex = 0;
      } else if (newIndex >= normalizadosNovos.length) {
        newIndex = normalizadosNovos.length - 1;
      }

      setPhotoModal((prev) =>
        prev && prev.os.id === os.id && prev.tipo === tipo
          ? {
              ...prev,
              os: {
                ...prev.os,
                [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
              },
              currentIndex: newIndex,
            }
          : prev
      );

      setStatusMessage("Foto excluída com sucesso.");
      setStatusType("success");
    } catch (error) {
      console.error(error);
      setStatusMessage(
        "Não foi possível excluir a foto. Tente novamente mais tarde."
      );
      setStatusType("error");
    }
  }

  function triggerAddPhotos() {
    if (!photoModal) return;
    addPhotoInputRef.current?.click();
  }

  async function handleAddPhotosChange(e: ChangeEvent<HTMLInputElement>) {
    if (!photoModal) {
      e.target.value = "";
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) {
      e.target.value = "";
      return;
    }

    const { os, tipo } = photoModal;

    const validFiles = Array.from(files).filter((file) => {
      if (file.type && file.type.startsWith("image/")) return true;
      const name = file.name.toLowerCase();
      const exts = [
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".bmp",
        ".heic",
        ".heif",
      ];
      return exts.some((ext) => name.endsWith(ext));
    });

    if (validFiles.length === 0) {
      setStatusMessage("Somente arquivos de imagem são permitidos.");
      setStatusType("error");
      e.target.value = "";
      return;
    }

    try {
      const basePath = os.origem === "asfalto" ? "asfalto" : "buraco-rua";
      const subfolder = tipo === "abertura" ? "fotos" : "fotos-execucao";

      const agora = new Date();
      const dataAnexoTexto = agora.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const novosItens: any[] = [];

      for (const file of validFiles) {
        const originalName = file.name || "foto.jpg";
        const safeName = sanitizeForStoragePath(originalName);

        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const path = `${basePath}/${os.id}/${subfolder}/${id}-${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, file, { upsert: true });

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

        novosItens.push({
          id,
          nomeArquivo: originalName,
          dataAnexoTexto,
          url,
        });
      }

      const collectionName =
        os.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      const originalArray: any[] =
        (tipo === "abertura" ? os.fotos : os.fotosExecucao) || [];

      const updatedArray = [...originalArray, ...novosItens];

      await updateDoc(doc(db, collectionName, os.id), {
        [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
        updatedAt: serverTimestamp(),
      });

      setDetailsModalOs((prev) => {
        if (!prev || prev.id !== os.id) return prev;
        return {
          ...prev,
          [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
        } as FirestoreOS;
      });

      const normalized = normalizeFotos(updatedArray);

      setPhotoModal((prev) =>
        prev && prev.os.id === os.id && prev.tipo === tipo
          ? {
              ...prev,
              os: {
                ...prev.os,
                [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
              },
              currentIndex: normalized.length > 0 ? normalized.length - 1 : 0,
            }
          : prev
      );

      setStatusMessage("Foto(s) adicionada(s) com sucesso.");
      setStatusType("success");
    } catch (error) {
      console.error(error);
      setStatusMessage(
        "Não foi possível adicionar as fotos. Tente novamente mais tarde."
      );
      setStatusType("error");
    } finally {
      e.target.value = "";
    }
  }

  // ----------- RENDER -------------
  return (
    <section className="page-card">
      <header className="page-header">
        <div>
          <h2>Lista de Ordens de Serviço</h2>
          <p className="page-section-description">
            Visualize todas as OS cadastradas, gere o PDF com os dados completos,
            consulte as datas de criação e execução e veja os detalhes.
          </p>
        </div>
      </header>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>
          {statusMessage}
        </div>
      )}

      {/* Barra de pesquisa */}
      <div className="os-toolbar">
        <div className="os-search">
          <input
            className="os-search-input"
            type="text"
            placeholder="Buscar por número da OS, protocolo, endereço ou data..."
            value={busca}
            onChange={handleSearchChange}
          />
        </div>
      </div>

      {/* Tabela principal */}
      <div className="os-main">
        {loading && (
          <div className="os-empty">Carregando ordens de serviço...</div>
        )}

        {!loading && filtradas.length === 0 && (
          <div className="os-empty">
            Nenhuma ordem encontrada para os filtros atuais.
          </div>
        )}

        {!loading && filtradas.length > 0 && (
          <div className="os-table-wrapper">
            <table className="os-table">
              <thead>
                <tr>
                  <th>Nº OS</th>
                  <th>Bairro</th>
                  <th>Rua / Avenida</th>
                  <th>Dados da OS</th>
                  <th>Data de criação</th>
                  <th>Data de execução</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtradas.map((os) => {
                  const qtdAbertura = normalizeFotos(os.fotos).length;
                  const qtdExecucao = normalizeFotos(os.fotosExecucao).length;
                  const totalFotos = qtdAbertura + qtdExecucao;

                  return (
                    <tr
                      key={os.id}
                      className="os-table-row"
                      onClick={() => {
                        setDetailsModalOs(os);
                        setIsEditingDetails(false);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{os.ordemServico || os.protocolo || "-"}</td>
                      <td>{os.bairro || "-"}</td>
                      <td>{os.rua || "-"}</td>
                      <td>
                        <div className="os-row-actions">
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={(event) => handleOpenPdfModal(os, event)}
                          >
                            Ver dados
                          </button>
                        </div>
                      </td>
                      <td>{formatDateTime(os.createdAt)}</td>
                      <td>{formatDateTime(os.dataExecucao)}</td>
                      <td>
                        <div
                          className="os-row-actions"
                          style={{ gap: "0.5rem" }}
                        >
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              openPhotoModalFromRow(os);
                            }}
                          >
                            Ver fotos
                            {totalFotos > 0 ? ` (${totalFotos})` : ""}
                          </button>

                          {canEditOs(os) ? (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDetailsModalOs(os);
                                setIsEditingDetails(true);
                              }}
                            >
                              Editar
                            </button>
                          ) : (
                            <span className="os-table-muted">
                              Sem permissão
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal de PDF com dados da OS */}
      {pdfModalOs && (
        <div className="modal-backdrop" onClick={closePdfModal}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "95vw",
              width: "95vw",
              height: "90vh",
              padding: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "0.5rem 1rem",
                borderBottom: "1px solid #e5e7eb",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <h3 className="modal-title" style={{ margin: 0 }}>
                OS{" "}
                {pdfModalOs.ordemServico ||
                  pdfModalOs.protocolo ||
                  pdfModalOs.id}
              </h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={closePdfModal}
                >
                  Fechar
                </button>
                {!pdfModalLoading && pdfModalUrl && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handlePrintCurrentPdf}
                  >
                    Imprimir
                  </button>
                )}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              {pdfModalLoading && (
                <div className="os-empty">Gerando PDF com dados da OS...</div>
              )}
              {!pdfModalLoading && pdfModalUrl && (
                <iframe
                  src={pdfModalUrl}
                  title="PDF com dados da OS"
                  style={{
                    width: "100%",
                    height: "100%",
                    border: "none",
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal de detalhes completos da OS (edição / visualização) */}
      {detailsModalOs && (
        <div className="modal-backdrop" onClick={closeDetailsModal}>
          <div
            className="modal"
            style={{ maxWidth: "900px", width: "90%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                Detalhes da OS{" "}
                {detailsModalOs.ordemServico ||
                  detailsModalOs.protocolo ||
                  detailsModalOs.id}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeDetailsModal}
                disabled={savingDetails}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              {/* Identificação */}
              <div className="page-section">
                <h3>Identificação</h3>
                <div className="page-form-grid">
                  <div className="page-field">
                    <label>Tipo</label>
                    <input
                      className="field-readonly"
                      readOnly
                      value={
                        tipoLabelMap[detailsModalOs.tipo || ""] ||
                        detailsModalOs.tipo ||
                        (detailsModalOs.origem === "asfalto"
                          ? "Asfalto"
                          : "Calçamento")
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Nº OS</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.ordemServico ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev
                            ? { ...prev, ordemServico: e.target.value }
                            : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Protocolo</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.protocolo ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, protocolo: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Status</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.status || "ABERTA"}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, status: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Data de criação</label>
                    <input
                      className="field-readonly"
                      readOnly
                      value={formatDateTime(detailsModalOs.createdAt)}
                    />
                  </div>

                  <div className="page-field">
                    <label>Data de execução</label>
                    <input
                      className="field-readonly"
                      readOnly
                      value={formatDateTime(detailsModalOs.dataExecucao)}
                    />
                  </div>
                </div>
              </div>

              {/* Local */}
              <div className="page-section">
                <h3>Local do serviço</h3>
                <div className="page-form-grid">
                  <div className="page-field">
                    <label>Bairro</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.bairro ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, bairro: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Rua / Avenida</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.rua ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, rua: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Número</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.numero ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, numero: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Ponto de referência</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.pontoReferencia ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev
                            ? { ...prev, pontoReferencia: e.target.value }
                            : prev
                        )
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Observações */}
              <div className="page-section">
                <h3>Observações</h3>
                <div className="page-field">
                  <textarea
                    className="field-readonly"
                    readOnly={readOnlyEditableFields}
                    value={detailsModalOs.observacoes ?? ""}
                    onChange={(e) =>
                      setDetailsModalOs((prev) =>
                        prev
                          ? { ...prev, observacoes: e.target.value }
                          : prev
                      )
                    }
                  />
                </div>
              </div>

              {/* Fotos da abertura */}
              <div className="page-section">
                <h3>Fotos da abertura da OS (Operador)</h3>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => openPhotoModalFromDetails("abertura")}
                  >
                    Ver fotos cadastradas
                    {fotosAberturaDetalhes.length > 0
                      ? ` (${fotosAberturaDetalhes.length})`
                      : ""}
                  </button>
                  {fotosAberturaDetalhes.length === 0 && (
                    <span className="field-hint">
                      Nenhuma foto cadastrada na abertura desta OS.
                    </span>
                  )}
                </div>
              </div>

              {/* Fotos da execução (terceirizada) */}
              <div className="page-section">
                <h3>Fotos da execução (Terceirizada)</h3>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => openPhotoModalFromDetails("execucao")}
                  >
                    Ver fotos cadastradas
                    {fotosExecucaoDetalhes.length > 0
                      ? ` (${fotosExecucaoDetalhes.length})`
                      : ""}
                  </button>
                  {fotosExecucaoDetalhes.length === 0 && (
                    <span className="field-hint">
                      Nenhuma foto de execução cadastrada pela terceirizada para
                      esta OS.
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeDetailsModal}
                disabled={savingDetails}
              >
                Fechar
              </button>

              {canEditCurrent && isEditingDetails && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveDetails}
                  disabled={savingDetails}
                >
                  {savingDetails ? "Salvando..." : "Salvar alterações"}
                </button>
              )}

              <button
                type="button"
                className="btn-primary btn-danger"
                onClick={() => handleDeleteOs(detailsModalOs)}
                disabled={savingDetails}
              >
                Excluir OS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE FOTOS (ABERTURA / EXECUÇÃO) */}
      {photoModal && (
        <div className="modal-backdrop" onClick={closePhotoModal}>
          <div
            className="modal modal-photo"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                Fotos da OS{" "}
                {photoModal.os.ordemServico ||
                  photoModal.os.protocolo ||
                  photoModal.os.id}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={closePhotoModal}
              >
                ×
              </button>
            </div>

            {/* Abas Operador / Terceirizada */}
            <div
              style={{
                padding: "0.75rem 1rem 0.5rem",
                borderBottom: "1px solid #e5e7eb",
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              {(() => {
                const fotosAbertura = normalizeFotos(photoModal.os.fotos);
                const fotosExec = normalizeFotos(photoModal.os.fotosExecucao);
                const totalAbertura = fotosAbertura.length;
                const totalExec = fotosExec.length;

                return (
                  <>
                    <button
                      type="button"
                      className={
                        photoModal.tipo === "abertura"
                          ? "btn-primary"
                          : "btn-secondary"
                      }
                      onClick={() =>
                        setPhotoModal((prev) =>
                          prev
                            ? {
                                ...prev,
                                tipo: "abertura",
                                currentIndex: 0,
                              }
                            : prev
                        )
                      }
                      disabled={totalAbertura === 0}
                    >
                      Fotos do Operador
                      {totalAbertura > 0 ? ` (${totalAbertura})` : ""}
                    </button>
                    <button
                      type="button"
                      className={
                        photoModal.tipo === "execucao"
                          ? "btn-primary"
                          : "btn-secondary"
                      }
                      onClick={() =>
                        setPhotoModal((prev) =>
                          prev
                            ? {
                                ...prev,
                                tipo: "execucao",
                                currentIndex: 0,
                              }
                            : prev
                        )
                      }
                      disabled={totalExec === 0}
                    >
                      Fotos da Terceirizada
                      {totalExec > 0 ? ` (${totalExec})` : ""}
                    </button>
                  </>
                );
              })()}
            </div>

            <div className="modal-body modal-photo-body">
              {(() => {
                const fotos = getFotosFromModalState(photoModal);

                if (fotos.length === 0) {
                  return (
                    <p className="field-hint">
                      {photoModal.tipo === "abertura"
                        ? "Nenhuma foto cadastrada pelo operador para esta OS."
                        : "Nenhuma foto cadastrada pela terceirizada para esta OS."}
                    </p>
                  );
                }

                const foto = fotos[photoModal.currentIndex] ?? fotos[0];

                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "1rem",
                    }}
                  >
                    {fotos.length > 1 && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={goToPrevPhoto}
                      >
                        ←
                      </button>
                    )}

                    <div
                      style={{
                        maxWidth: "100%",
                        width: "100%",
                        textAlign: "center",
                      }}
                    >
                      <img
                        src={foto.url}
                        alt={foto.label}
                        style={{
                          width: "100%",
                          maxHeight: "70vh",
                          objectFit: "contain",
                          borderRadius: "0.75rem",
                        }}
                      />
                      <p className="photo-modal-timestamp">
                        {foto.label}{" "}
                        {fotos.length > 1 && (
                          <>
                            {" "}
                            · Foto {photoModal.currentIndex + 1} de{" "}
                            {fotos.length}
                          </>
                        )}
                      </p>
                    </div>

                    {fotos.length > 1 && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={goToNextPhoto}
                      >
                        →
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>

            <div
              className="modal-footer"
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={closePhotoModal}
                >
                  Fechar
                </button>
                {canEditOs(photoModal.os) &&
                  getFotosFromModalState(photoModal).length > 0 && (
                    <button
                      type="button"
                      className="btn-primary btn-danger"
                      onClick={handleDeleteCurrentPhoto}
                    >
                      Excluir foto
                    </button>
                  )}
              </div>

              {canEditOs(photoModal.os) && (
                <div>
                  <input
                    ref={addPhotoInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={handleAddPhotosChange}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={triggerAddPhotos}
                  >
                    Adicionar fotos
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default ListaOrdensServico;
