# Backup Operacional do SANEAR

## Registros incluídos

A ferramenta seleciona somente ordens com status `CONCLUIDA` ou `CONCLUIDO` nas coleções:

- `ordens_servico` — Calçamento;
- `ordensServico` — Asfalto.

Ordens abertas, em andamento, aguardando o SANEAR ou canceladas não são apagadas por essa rotina.

## Campos preservados

O JSON mantém o documento integral do Firestore e também uma estrutura normalizada com:

- coleção e ID original;
- tipo e origem;
- protocolo e Ordem de Serviço;
- bairro, rua, número e ponto de referência;
- observações e status;
- criação, atualização e execução;
- UID e e-mail do operador;
- prazo e pausas de SLA;
- fotos de abertura;
- fotos de execução;
- páginas correspondentes no relatório PDF.

## Estrutura do ZIP

```text
SANEAR-BACKUP-AAAAMMDDTHHMMSS-HASH.zip
├── manifest.json
├── LEIA-ME.txt
├── dados
│   ├── ordens.json
│   └── ordens.csv
├── relatorio
│   └── ordens-concluidas.pdf
└── fotos
    ├── calcamento
    └── asfalto
```

## Exclusão segura

A exclusão só é liberada depois que o ZIP foi salvo. Antes de apagar cada documento, o sistema verifica novamente:

1. se o documento ainda existe;
2. se continua concluído;
3. se `updatedAt` continua igual ao valor incluído no backup.

Se a ordem tiver sido alterada depois da geração do ZIP, ela é preservada. A confirmação exige digitar `APAGAR`.

## Limitação do navegador

O sistema web pode abrir o seletor de arquivo em navegadores compatíveis. Nos demais, utiliza a pasta padrão de downloads. O navegador não consegue garantir sozinho que o arquivo foi copiado para um servidor interno ou mídia externa; essa conferência continua sendo responsabilidade do administrador.
