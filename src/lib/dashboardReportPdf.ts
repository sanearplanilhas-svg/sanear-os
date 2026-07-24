import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage, RGB, PDFDocument as PDFDocumentType } from "pdf-lib";

type ReportSimpleRow = {
  label: string;
  value: number | string;
};

type ReportMetric = {
  label: string;
  value: string;
  note?: string;
};

type ReportRankingRow = {
  name: string;
  total: number;
  abertas: number;
  concluidas: number;
  atrasadas: number;
  aguardandoSanear?: number;
  percentAtraso?: number;
};

type ReportServiceRow = {
  name: string;
  areaLabel: string;
  total: number;
  abertas: number;
  concluidas: number;
  atrasadas: number;
  percentConclusao: number;
};

type ReportAttentionRow = {
  moduleLabel: string;
  title: string;
  location: string;
  statusLabel: string;
  hours: string;
};

type ReportInsightRow = {
  title: string;
  description: string;
};

type ReportSlaConfigRow = {
  service: string;
  prazo: string;
  prioridade: string;
  area: string;
};

export type DashboardReportPayload = {
  title: string;
  subtitle: string;
  sectionTitle: string;
  periodLabel: string;
  generatedAtLabel: string;
  metrics: ReportMetric[];
  statusRows: ReportSimpleRow[];
  slaRows: ReportSimpleRow[];
  moduleRows: ReportSimpleRow[];
  serviceRows: ReportServiceRow[];
  bairroRanking: ReportRankingRow[];
  bairroAtrasoRanking: ReportRankingRow[];
  attentionRows: ReportAttentionRow[];
  insightRows: ReportInsightRow[];
  slaConfigRows: ReportSlaConfigRow[];
};

type PdfContext = {
  page: PDFPage;
  regularFont: PDFFont;
  boldFont: PDFFont;
  width: number;
  height: number;
  margin: number;
  y: number;
};

const COLORS = {
  navy: rgb(0.05, 0.09, 0.16),
  blue: rgb(0.14, 0.39, 0.92),
  blueDark: rgb(0.11, 0.25, 0.55),
  text: rgb(0.06, 0.09, 0.16),
  muted: rgb(0.39, 0.45, 0.55),
  border: rgb(0.86, 0.9, 0.96),
  soft: rgb(0.96, 0.98, 1),
  warning: rgb(0.86, 0.5, 0.05),
  success: rgb(0.09, 0.64, 0.29),
  white: rgb(1, 1, 1),
} satisfies Record<string, RGB>;

function sanitizePdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•]/g, "-")
    .replace(/[↩️🚧🚛🛣️🧱📊]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fileSafeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function drawText(
  ctx: PdfContext,
  text: string,
  x: number,
  y: number,
  size: number,
  options: { bold?: boolean; color?: RGB; maxWidth?: number } = {}
): void {
  ctx.page.drawText(sanitizePdfText(text), {
    x,
    y,
    size,
    font: options.bold ? ctx.boldFont : ctx.regularFont,
    color: options.color ?? COLORS.text,
    maxWidth: options.maxWidth,
  });
}

function measureText(ctx: PdfContext, text: string, size: number, bold = false): number {
  return (bold ? ctx.boldFont : ctx.regularFont).widthOfTextAtSize(sanitizePdfText(text), size);
}

function wrapText(ctx: PdfContext, text: string, maxWidth: number, size: number, bold = false): string[] {
  const words = sanitizePdfText(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measureText(ctx, next, size, bold) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

async function addPage(ctx: PdfContext, pdfDoc: PDFDocumentType): Promise<void> {
  ctx.page = pdfDoc.addPage([ctx.width, ctx.height]);
  ctx.y = ctx.height - ctx.margin;
  drawPageFooter(ctx, pdfDoc.getPageCount());
}

function drawPageFooter(ctx: PdfContext, pageNumber: number): void {
  ctx.page.drawLine({
    start: { x: ctx.margin, y: 34 },
    end: { x: ctx.width - ctx.margin, y: 34 },
    thickness: 0.6,
    color: COLORS.border,
  });
  drawText(ctx, `SANEAR Operacional - Página ${pageNumber}`, ctx.margin, 22, 8, { color: COLORS.muted });
}

async function ensureSpace(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  needed: number
): Promise<void> {
  if (ctx.y - needed < 54) {
    await addPage(ctx, pdfDoc);
  }
}

async function sectionTitle(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  title: string,
  options: { minFollowingSpace?: number } = {}
): Promise<void> {
  const headerHeight = 22;
  const minFollowingSpace = options.minFollowingSpace ?? 32;
  await ensureSpace(ctx, pdfDoc, headerHeight + minFollowingSpace + 14);

  ctx.y -= 10;
  ctx.page.drawRectangle({
    x: ctx.margin,
    y: ctx.y - headerHeight + 6,
    width: ctx.width - ctx.margin * 2,
    height: headerHeight,
    color: COLORS.soft,
    borderColor: COLORS.border,
    borderWidth: 0.7,
  });
  drawText(ctx, title, ctx.margin + 12, ctx.y - 8, 10.8, { bold: true, color: COLORS.blueDark });
  ctx.y -= headerHeight + 10;
}

async function drawParagraph(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  text: string,
  options: { size?: number; color?: RGB; bold?: boolean; indent?: number } = {}
): Promise<void> {
  const size = options.size ?? 9;
  const indent = options.indent ?? 0;
  const lines = wrapText(ctx, text, ctx.width - ctx.margin * 2 - indent, size, options.bold ?? false);
  await ensureSpace(ctx, pdfDoc, lines.length * (size + 4) + 4);
  for (const line of lines) {
    drawText(ctx, line, ctx.margin + indent, ctx.y, size, {
      bold: options.bold,
      color: options.color,
    });
    ctx.y -= size + 4;
  }
}

async function drawMetricCards(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  metrics: ReportMetric[]
): Promise<void> {
  const columns = 3;
  const gap = 10;
  const cardWidth = (ctx.width - ctx.margin * 2 - gap * (columns - 1)) / columns;
  const cardHeight = 68;

  for (let index = 0; index < metrics.length; index += columns) {
    await ensureSpace(ctx, pdfDoc, cardHeight + 12);
    const row = metrics.slice(index, index + columns);

    row.forEach((metric, offset) => {
      const x = ctx.margin + offset * (cardWidth + gap);
      ctx.page.drawRectangle({
        x,
        y: ctx.y - cardHeight + 8,
        width: cardWidth,
        height: cardHeight,
        color: COLORS.soft,
        borderColor: COLORS.border,
        borderWidth: 0.8,
      });
      drawText(ctx, metric.label.toUpperCase(), x + 10, ctx.y - 12, 7.5, { bold: true, color: COLORS.muted });
      drawText(ctx, metric.value, x + 10, ctx.y - 36, 19, { bold: true, color: COLORS.blueDark });
      if (metric.note) drawText(ctx, metric.note, x + 10, ctx.y - 54, 8, { color: COLORS.muted, maxWidth: cardWidth - 20 });
    });

    ctx.y -= cardHeight + 10;
  }
}

async function drawSimpleTable(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  title: string,
  rows: ReportSimpleRow[],
  options: { maxRows?: number; barColor?: RGB } = {}
): Promise<void> {
  await sectionTitle(ctx, pdfDoc, title, { minFollowingSpace: rows.length > 0 ? Math.min(rows.length, 2) * 22 + 26 : 26 });
  if (rows.length === 0) {
    await drawParagraph(ctx, pdfDoc, "Nenhum dado encontrado para este período.", { color: COLORS.muted });
    return;
  }

  const maxRows = options.maxRows ?? rows.length;
  const visibleRows = rows.slice(0, maxRows);
  const maxValue = Math.max(...visibleRows.map((row) => Number(row.value) || 0), 1);
  const rowHeight = 22;
  const tableWidth = ctx.width - ctx.margin * 2;

  for (const row of visibleRows) {
    await ensureSpace(ctx, pdfDoc, rowHeight + 6);
    ctx.page.drawRectangle({
      x: ctx.margin,
      y: ctx.y - rowHeight + 6,
      width: tableWidth,
      height: rowHeight,
      borderColor: COLORS.border,
      borderWidth: 0.5,
    });
    drawText(ctx, row.label, ctx.margin + 8, ctx.y - 9, 9, { bold: true, maxWidth: tableWidth * 0.44 });
    drawText(ctx, String(row.value), ctx.margin + tableWidth * 0.48, ctx.y - 9, 9, { bold: true, color: COLORS.blueDark });

    const numericValue = Number(row.value) || 0;
    const barWidth = Math.max(0, (tableWidth * 0.34) * (numericValue / maxValue));
    ctx.page.drawRectangle({
      x: ctx.margin + tableWidth * 0.61,
      y: ctx.y - 12,
      width: barWidth,
      height: 7,
      color: options.barColor ?? COLORS.blue,
    });
    ctx.y -= rowHeight;
  }

  if (rows.length > visibleRows.length) {
    await drawParagraph(ctx, pdfDoc, `Mais ${rows.length - visibleRows.length} item(ns) omitidos nesta versão resumida.`, {
      size: 8,
      color: COLORS.muted,
    });
  }
}

async function drawRankingTable(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  title: string,
  rows: ReportRankingRow[],
  maxRows: number
): Promise<void> {
  await sectionTitle(ctx, pdfDoc, title, { minFollowingSpace: rows.length > 0 ? Math.min(rows.length, 2) * 22 + 26 : 26 });
  if (rows.length === 0) {
    await drawParagraph(ctx, pdfDoc, "Nenhum bairro encontrado para este período.", { color: COLORS.muted });
    return;
  }

  await drawTableHeader(ctx, pdfDoc, ["Bairro", "Total", "Abertas", "Concluídas", "Atrasadas", "% atraso"], [230, 48, 58, 68, 62, 58]);

  for (const row of rows.slice(0, maxRows)) {
    await drawTableRow(ctx, pdfDoc, [
      row.name,
      String(row.total),
      String(row.abertas),
      String(row.concluidas),
      String(row.atrasadas),
      `${row.percentAtraso ?? 0}%`,
    ], [230, 48, 58, 68, 62, 58]);
  }
}

async function drawServiceTable(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  rows: ReportServiceRow[]
): Promise<void> {
  await sectionTitle(ctx, pdfDoc, "Desempenho por serviço", { minFollowingSpace: rows.length > 0 ? 74 : 30 });
  await drawTableHeader(ctx, pdfDoc, ["Serviço", "Área", "Total", "Abertas", "Atrasadas", "Conclusão"], [130, 120, 52, 62, 68, 82]);

  for (const row of rows) {
    await drawTableRow(ctx, pdfDoc, [
      row.name,
      row.areaLabel,
      String(row.total),
      String(row.abertas),
      String(row.atrasadas),
      `${row.percentConclusao}%`,
    ], [130, 120, 52, 62, 68, 82]);
  }
}

async function drawAttentionTable(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  rows: ReportAttentionRow[]
): Promise<void> {
  await sectionTitle(ctx, pdfDoc, "Prioridades operacionais", { minFollowingSpace: rows.length > 0 ? 88 : 32 });
  if (rows.length === 0) {
    await drawParagraph(ctx, pdfDoc, "Nenhuma OS crítica encontrada no filtro atual.", { color: COLORS.success, bold: true });
    return;
  }

  await drawTableHeader(ctx, pdfDoc, ["Serviço", "OS", "Local", "Status", "Tempo"], [85, 88, 195, 92, 55]);
  for (const row of rows.slice(0, 8)) {
    await drawTableRow(ctx, pdfDoc, [row.moduleLabel, row.title, row.location, row.statusLabel, row.hours], [85, 88, 195, 92, 55]);
  }
}

async function drawInsights(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  rows: ReportInsightRow[]
): Promise<void> {
  await sectionTitle(ctx, pdfDoc, "Leitura gerencial automática", { minFollowingSpace: rows.length > 0 ? 90 : 32 });
  if (rows.length === 0) {
    await drawParagraph(ctx, pdfDoc, "Sem alertas gerenciais relevantes para este filtro.", { color: COLORS.muted });
    return;
  }

  for (const row of rows) {
    await ensureSpace(ctx, pdfDoc, 48);
    drawText(ctx, row.title, ctx.margin + 12, ctx.y, 10, { bold: true, color: COLORS.blueDark });
    ctx.y -= 14;
    await drawParagraph(ctx, pdfDoc, row.description, { size: 8.6, color: COLORS.muted, indent: 12 });
    ctx.y -= 2;
  }
}

async function drawSlaConfig(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  rows: ReportSlaConfigRow[]
): Promise<void> {
  await sectionTitle(ctx, pdfDoc, "Prazos por serviço", { minFollowingSpace: rows.length > 0 ? 88 : 30 });
  await drawTableHeader(ctx, pdfDoc, ["Serviço", "Prazo", "Prioridade", "Área"], [165, 90, 90, 165]);
  for (const row of rows) {
    await drawTableRow(ctx, pdfDoc, [row.service, row.prazo, row.prioridade, row.area], [165, 90, 90, 165]);
  }
}

async function drawTableHeader(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  headers: string[],
  widths: number[]
): Promise<void> {
  await ensureSpace(ctx, pdfDoc, 26);
  const rowHeight = 20;
  let x = ctx.margin;
  ctx.page.drawRectangle({
    x: ctx.margin,
    y: ctx.y - rowHeight + 6,
    width: widths.reduce((sum, width) => sum + width, 0),
    height: rowHeight,
    color: COLORS.navy,
  });

  headers.forEach((header, index) => {
    drawText(ctx, header, x + 5, ctx.y - 8, 7.7, { bold: true, color: COLORS.white, maxWidth: widths[index] - 10 });
    x += widths[index];
  });

  ctx.y -= rowHeight;
}

async function drawTableRow(
  ctx: PdfContext,
  pdfDoc: PDFDocumentType,
  cells: string[],
  widths: number[]
): Promise<void> {
  const wrappedCells = cells.map((cell, index) => wrapText(ctx, cell, widths[index] - 10, 7.7));
  const maxLines = Math.max(...wrappedCells.map((cell) => cell.length));
  const rowHeight = Math.max(20, maxLines * 10 + 8);
  await ensureSpace(ctx, pdfDoc, rowHeight + 4);

  let x = ctx.margin;
  ctx.page.drawRectangle({
    x: ctx.margin,
    y: ctx.y - rowHeight + 6,
    width: widths.reduce((sum, width) => sum + width, 0),
    height: rowHeight,
    borderColor: COLORS.border,
    borderWidth: 0.45,
  });

  wrappedCells.forEach((lines, cellIndex) => {
    lines.slice(0, 3).forEach((line, lineIndex) => {
      drawText(ctx, line, x + 5, ctx.y - 8 - lineIndex * 9, 7.7, {
        bold: cellIndex === 0,
        color: cellIndex === 0 ? COLORS.text : COLORS.muted,
      });
    });
    x += widths[cellIndex];
  });

  ctx.y -= rowHeight;
}

function downloadPdf(bytes: Uint8Array, filename: string): void {
  const pdfBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(pdfBuffer).set(bytes);
  const blob = new Blob([pdfBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function generateDashboardReportPdf(payload: DashboardReportPayload): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const ctx: PdfContext = {
    page: pdfDoc.addPage([595.28, 841.89]),
    regularFont,
    boldFont,
    width: 595.28,
    height: 841.89,
    margin: 36,
    y: 805,
  };

  drawPageFooter(ctx, 1);

  ctx.page.drawRectangle({
    x: 0,
    y: 714,
    width: ctx.width,
    height: 128,
    color: COLORS.navy,
  });
  ctx.page.drawRectangle({
    x: 0,
    y: 714,
    width: 9,
    height: 128,
    color: COLORS.blue,
  });

  drawText(ctx, payload.title, ctx.margin, 790, 22, { bold: true, color: COLORS.white });
  drawText(ctx, payload.subtitle, ctx.margin, 768, 10, { color: COLORS.white, maxWidth: 500 });
  drawText(ctx, `Seção: ${payload.sectionTitle}`, ctx.margin, 742, 9, { color: COLORS.white });
  drawText(ctx, `Período: ${payload.periodLabel}`, ctx.margin, 728, 9, { color: COLORS.white });
  drawText(ctx, `Gerado em: ${payload.generatedAtLabel}`, ctx.margin + 310, 728, 9, { color: COLORS.white });
  ctx.y = 690;

  await drawMetricCards(ctx, pdfDoc, payload.metrics);
  await drawInsights(ctx, pdfDoc, payload.insightRows);
  await drawSimpleTable(ctx, pdfDoc, "Resumo por status", payload.statusRows, { barColor: COLORS.blue });
  await drawSimpleTable(ctx, pdfDoc, "SLA e prioridades", payload.slaRows, { barColor: COLORS.warning });
  await drawSimpleTable(ctx, pdfDoc, "Distribuição por módulo", payload.moduleRows, { barColor: COLORS.success });
  await drawServiceTable(ctx, pdfDoc, payload.serviceRows);
  await drawRankingTable(ctx, pdfDoc, "Bairros com maior demanda", payload.bairroRanking, 10);
  await drawRankingTable(ctx, pdfDoc, "Bairros críticos por atraso", payload.bairroAtrasoRanking, 8);
  await drawAttentionTable(ctx, pdfDoc, payload.attentionRows);
  await drawSlaConfig(ctx, pdfDoc, payload.slaConfigRows);

  const bytes = await pdfDoc.save();
  const filename = `relatorio-gerencial-sanear-${fileSafeName(payload.periodLabel || "periodo")}.pdf`;
  downloadPdf(bytes, filename);
}
