export type DadosOsExtraidos = {
  protocolo?: string;
  ordemServico?: string;
  bairro?: string;
  rua?: string;
  numero?: string;
  referencia?: string;
  observacoes?: string;
  tipoServico?: string;
};

export type ResultadoExtracaoPdfOs = {
  dados: DadosOsExtraidos;
  camposEncontrados: string[];
  textoExtraido: string;
  textoPreview: string;
  paginasLidas: number;
  aviso?: string;
};

type TextItemLike = {
  str?: string;
  transform?: number[];
};

type LinhaPdf = {
  texto: string;
  y: number;
};

type EnderecoParseado = {
  rua?: string;
  numero?: string;
  bairro?: string;
};

const ROTULOS_LIMITE = [
  "PROTOCOLO",
  "PROTOC[OÓ]LO",
  "PROTOCOLO DE ATENDIMENTO",
  "N[ÚU]MERO DO PROTOCOLO",
  "ORDEM DE SERVI[CÇ]O",
  "ORDEM SERVI[CÇ]O",
  "N[ÚU]MERO DA ORDEM",
  "N[ÚU]MERO DA O\\.?S\\.?",
  "N[ÚU]MERO DA OS",
  "N[ºO°.]?\\s*O\\.?S\\.?",
  "N[ºO°.]?\\s*OS",
  "OS",
  "ABERTA EM",
  "ABERTA POR",
  "LOCALIDADE",
  "LIGA[CÇ][ÃA]O",
  "ECONOMIAS",
  "BAIRRO",
  "ENDERE[CÇ]O",
  "ENDERECO",
  "LOGRADOURO",
  "RUA",
  "AVENIDA",
  "N[ÚU]MERO",
  "NUMERO",
  "N[ºO°.]",
  "PONTO REF\\.?",
  "PONTO DE REFER[ÊE]NCIA",
  "REFER[ÊE]NCIA",
  "REFERENCIA",
  "COMPLEMENTO",
  "ROTA\\/SEQ\\.?",
  "QUADRA",
  "LOTE",
  "LEITURA",
  "DATA",
  "CONSUMO",
  "HIDR[ÔO]M\\.?",
  "FABRICANTE",
  "DI[ÂA]METRO",
  "VAZ[ÃA]O",
  "MATERIAL",
  "SERVI[CÇ]O",
  "SERVI[CÇ]O SOLICITADO",
  "TIPO DE SERVI[CÇ]O",
  "SE[CÇ][ÃA]O",
  "EXECUTADO POR",
  "OBS\\.?",
  "OBSERVA[CÇ][ÃA]O",
  "OBSERVA[CÇ][ÕO]ES",
  "OBSERVACOES",
  "DESCRI[CÇ][ÃA]O",
  "DESCRICAO",
  "SOLICITANTE",
  "STATUS",
  "TELEFONE",
  "CPF",
  "CNPJ",
  "MATR[IÍ]CULA",
  "MATRICULA",
  "IMPRESSO EM",
].join("|");

const REGEX_PROXIMO_ROTULO = new RegExp(
  `\\s+(?:${ROTULOS_LIMITE})\\s*(?::|[-–—]|$)`,
  "i"
);

function normalizarEspacos(valor: string): string {
  return valor.replace(/\s+/g, " ").trim();
}

function limparValor(valor: string | undefined): string | undefined {
  if (!valor) return undefined;

  let limpo = normalizarEspacos(valor)
    .replace(/^[.:;\-–—#º°\s]+/, "")
    .replace(/^(?:N[º°.]|Nº|N°|NO\.)\s*/i, "")
    .replace(/\s+[|•]+\s*$/g, "")
    .trim();

  const corte = limpo.search(REGEX_PROXIMO_ROTULO);
  if (corte > 0) {
    limpo = limpo.slice(0, corte).trim();
  }

  limpo = limpo
    // Alguns PDFs do FOXFAT trazem ruído do código de barras como sequências F/G.
    // Esse trecho não faz parte da observação nem do endereço.
    .replace(/(?:[FGfg]\s*){12,}.*$/g, "")
    .replace(/\s+(DATA|STATUS|SOLICITANTE|TELEFONE|CPF|CNPJ|IMPRESSO EM)\s*:?.*$/i, "")
    .replace(/[;,\.\s]+$/g, "")
    .trim();

  if (!limpo) return undefined;

  const invalido = limpo.replace(/[\s./_-]/g, "");
  if (!invalido || invalido.length < 2) return undefined;

  return limpo.slice(0, 350).toLocaleUpperCase("pt-BR");
}

function montarLinhasPorCoordenada(items: TextItemLike[]): string[] {
  const linhas: LinhaPdf[] = [];

  for (const item of items) {
    const texto = item.str ? normalizarEspacos(item.str) : "";
    if (!texto) continue;

    const y = Array.isArray(item.transform) ? Math.round(item.transform[5] || 0) : 0;
    const existente = linhas.find((linha) => Math.abs(linha.y - y) <= 2);

    if (existente) {
      existente.texto = normalizarEspacos(`${existente.texto} ${texto}`);
    } else {
      linhas.push({ texto, y });
    }
  }

  return linhas
    .sort((a, b) => b.y - a.y)
    .map((linha) => linha.texto)
    .filter(Boolean);
}

function encontrarValorPorRotulos(
  linhas: string[],
  rotulos: string[],
  opcoes?: { pegarLinhaSeguinte?: boolean; somenteInicio?: boolean }
): string | undefined {
  const inicio = opcoes?.somenteInicio ? "^" : "(?:^|\\b)";
  const regexRotulo = new RegExp(
    `${inicio}(?:${rotulos.join("|")})\\s*(?::|[-–—]|N[ºO°.]?\\s*)?\\s*(.*)$`,
    "i"
  );
  const regexLimite = new RegExp(`^(?:${ROTULOS_LIMITE})\\b`, "i");

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    const match = linha.match(regexRotulo);
    if (!match) continue;

    const valorNaLinha = limparValor(match[1]);
    if (valorNaLinha) return valorNaLinha;

    if (opcoes?.pegarLinhaSeguinte && linhas[i + 1] && !regexLimite.test(linhas[i + 1])) {
      const proxima = limparValor(linhas[i + 1]);
      if (proxima) return proxima;
    }
  }

  return undefined;
}

function encontrarBlocoPorRotulos(
  linhas: string[],
  rotulos: string[],
  maxLinhas = 3
): string | undefined {
  const regexRotulo = new RegExp(
    `^(?:${rotulos.join("|")})\\s*(?::|[-–—])?\\s*(.*)$`,
    "i"
  );
  const regexLimite = new RegExp(`^(?:${ROTULOS_LIMITE})\\b`, "i");

  for (let i = 0; i < linhas.length; i += 1) {
    const match = linhas[i].match(regexRotulo);
    if (!match) continue;

    const partes: string[] = [];
    const inicial = limparValor(match[1]);
    if (inicial) partes.push(inicial);

    for (let j = i + 1; j < Math.min(linhas.length, i + 1 + maxLinhas); j += 1) {
      if (regexLimite.test(linhas[j])) break;
      const valor = limparValor(linhas[j]);
      if (valor) partes.push(valor);
    }

    const bloco = limparValor(partes.join(" "));
    if (bloco) return bloco.slice(0, 350);
  }

  return undefined;
}

function extrairPrimeiroRegex(texto: string, regex: RegExp): string | undefined {
  const match = texto.match(regex);
  return limparValor(match?.[1]);
}

function extrairLinhaPorRotulo(linhas: string[], rotulos: string[]): string | undefined {
  const regex = new RegExp(`^(?:${rotulos.join("|")})\\s*(?::|[-–—])?\\s*(.*)$`, "i");

  for (const linha of linhas) {
    const match = linha.match(regex);
    const valor = limparValor(match?.[1]);
    if (valor) return valor;
  }

  return undefined;
}

function parsearEndereco(endereco: string | undefined): EnderecoParseado {
  if (!endereco) return {};

  const valor = normalizarEspacos(endereco)
    .replace(/\s+(PONTO REF\.?|COMPLEMENTO|ROTA\/SEQ\.?|QUADRA|LOTE|LEITURA)\s*:?.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const comNumeroEBairro = valor.match(/^(.+?),\s*([A-Z0-9./-]+)\s*[-–—]\s*(.+)$/i);
  if (comNumeroEBairro) {
    return {
      rua: limparValor(comNumeroEBairro[1]),
      numero: limparValor(comNumeroEBairro[2]),
      bairro: limparValor(comNumeroEBairro[3]),
    };
  }

  const comHifen = valor.match(/^(.+?)\s*[-–—]\s*([^–—-]+)$/i);
  if (comHifen) {
    return {
      rua: limparValor(comHifen[1]),
      bairro: limparValor(comHifen[2]),
    };
  }

  const numero = valor.match(/^(.+?),\s*(?:N[ºO°.]?\s*)?([A-Z0-9./-]+)\b/i);
  if (numero) {
    return {
      rua: limparValor(numero[1]),
      numero: limparValor(numero[2]),
    };
  }

  return { rua: limparValor(valor) };
}

function identificarTipoServico(texto: string): string | undefined {
  const textoUpper = texto.toLocaleUpperCase("pt-BR");

  if (/HIDROJATO|HIDRO\s*JATO/.test(textoUpper)) return "HIDROJATO";
  if (/ASFALTO|PAVIMENTA[CÇ][ÃA]O ASF[ÁA]LTICA|RECAPEAMENTO/.test(textoUpper)) return "ASFALTO";
  if (/CAL[CÇ]AMENTO|BURACO|PASSEIO|PARALELEP[IÍ]PEDO|PAVIMENTO/.test(textoUpper)) return "CALÇAMENTO";
  if (/ESGOTO\s+RETORNANDO|RETORNO\s+DE\s+ESGOTO/.test(textoUpper)) return "ESGOTO RETORNANDO";
  if (/ESGOTO\s+ENTUPIDO|DESOBSTRU[CÇ][ÃA]O|ENTUPIMENTO/.test(textoUpper)) return "ESGOTO ENTUPIDO";

  return undefined;
}

function montarCamposEncontrados(dados: DadosOsExtraidos): string[] {
  const labels: Array<[keyof DadosOsExtraidos, string]> = [
    ["protocolo", "Protocolo"],
    ["ordemServico", "Ordem de Serviço"],
    ["bairro", "Bairro"],
    ["rua", "Rua"],
    ["numero", "Número"],
    ["referencia", "Referência"],
    ["observacoes", "Observações"],
    ["tipoServico", "Tipo de serviço"],
  ];

  return labels.filter(([campo]) => Boolean(dados[campo])).map(([, label]) => label);
}

function extrairDadosDoTexto(texto: string): DadosOsExtraidos {
  const linhas = texto
    .split(/\n+/)
    .map(normalizarEspacos)
    .filter(Boolean);

  const textoLinear = normalizarEspacos(texto);
  const endereco = extrairLinhaPorRotulo(
    linhas,
    ["ENDERE[CÇ]O", "ENDERECO", "LOGRADOURO", "LOCAL DO SERVI[CÇ]O", "LOCAL DO SERVICO", "LOCAL"]
  );
  const enderecoParseado = parsearEndereco(endereco);

  const observacao =
    encontrarBlocoPorRotulos(
      linhas,
      [
        "OBS\\.?",
        "OBSERVA[CÇ][ÃA]O",
        "OBSERVA[CÇ][ÕO]ES",
        "OBSERVACOES",
        "DESCRI[CÇ][ÃA]O",
        "DESCRICAO",
        "SERVI[CÇ]O SOLICITADO",
        "SOLICITACAO",
      ],
      4
    ) || extrairPrimeiroRegex(textoLinear, /\bObs\.?:\s*(.+?)(?:\s+Ponto Ref\.?\s*:|\s+Iniciado na data|\s+Finalizado na data|$)/i);

  const dados: DadosOsExtraidos = {
    protocolo:
      extrairPrimeiroRegex(textoLinear, /\bProtocolo de atendimento\s*:?\s*([0-9]+)/i) ||
      encontrarValorPorRotulos(
        linhas,
        ["PROTOCOLO DE ATENDIMENTO", "PROTOCOLO", "PROTOC[OÓ]LO", "N[ÚU]MERO DO PROTOCOLO", "NUMERO DO PROTOCOLO", "PROCESSO"],
        { pegarLinhaSeguinte: true, somenteInicio: true }
      ),
    ordemServico:
      extrairPrimeiroRegex(textoLinear, /\bN[úu]mero\s+da\s+O\.?S\.?\s*:?\s*([0-9]+)/i) ||
      encontrarValorPorRotulos(
        linhas,
        [
          "ORDEM DE SERVI[CÇ]O",
          "ORDEM SERVI[CÇ]O",
          "N[ÚU]MERO DA ORDEM",
          "NUMERO DA ORDEM",
          "N[ÚU]MERO DA O\\.?S\\.?",
          "NUMERO DA O\\.?S\\.?",
          "N[ÚU]MERO DA OS",
          "NUMERO DA OS",
          "N[ºO°.]?\\s*O\\.?S\\.?",
          "N[ºO°.]?\\s*OS",
          "OS",
        ],
        { pegarLinhaSeguinte: true, somenteInicio: true }
      ),
    bairro: enderecoParseado.bairro || encontrarValorPorRotulos(linhas, ["BAIRRO"], { pegarLinhaSeguinte: true, somenteInicio: true }),
    rua:
      enderecoParseado.rua ||
      encontrarValorPorRotulos(linhas, ["RUA", "AVENIDA", "LOGRADOURO"], {
        pegarLinhaSeguinte: true,
        somenteInicio: true,
      }),
    numero:
      enderecoParseado.numero ||
      encontrarValorPorRotulos(linhas, ["N[ÚU]MERO", "NUMERO", "N[ºO°.]"], {
        pegarLinhaSeguinte: true,
        somenteInicio: true,
      }),
    referencia: encontrarValorPorRotulos(
      linhas,
      ["PONTO REF\\.?", "PONTO DE REFER[ÊE]NCIA", "PONTO DE REFERENCIA", "REFER[ÊE]NCIA", "REFERENCIA"],
      { pegarLinhaSeguinte: false, somenteInicio: true }
    ),
    observacoes: observacao,
    tipoServico: identificarTipoServico(`${textoLinear} ${observacao || ""}`),
  };

  return dados;
}

async function carregarPdfJs() {
  const [pdfjsLib, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.mjs?url"),
  ]);

  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
  return pdfjsLib;
}

export async function extrairDadosOsDoPdf(file: File): Promise<ResultadoExtracaoPdfOs> {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = await carregarPdfJs();
  const documento = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const paginasParaLer = Math.min(documento.numPages, 3);
  const paginasTexto: string[] = [];

  for (let pageNumber = 1; pageNumber <= paginasParaLer; pageNumber += 1) {
    const pagina = await documento.getPage(pageNumber);
    const conteudo = await pagina.getTextContent();
    const linhas = montarLinhasPorCoordenada(conteudo.items as TextItemLike[]);
    const textoPagina = linhas.length
      ? linhas.join("\n")
      : (conteudo.items as TextItemLike[])
          .map((item) => item.str || "")
          .filter(Boolean)
          .join(" ");

    if (textoPagina.trim()) {
      paginasTexto.push(textoPagina);
    }
  }

  const textoCompleto = paginasTexto.join("\n");
  const textoExtraido = normalizarEspacos(textoCompleto);
  const dados = extrairDadosDoTexto(textoCompleto);
  const camposEncontrados = montarCamposEncontrados(dados);

  return {
    dados,
    camposEncontrados,
    textoExtraido,
    textoPreview: textoExtraido.slice(0, 450),
    paginasLidas: paginasParaLer,
    aviso:
      textoExtraido.length < 20
        ? "O PDF parece ser escaneado ou não possui texto selecionável. Nesse caso será necessário OCR em uma próxima etapa."
        : camposEncontrados.length === 0
          ? "O texto foi lido, mas nenhum campo conhecido foi identificado automaticamente."
          : undefined,
  };
}
