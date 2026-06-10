# Consulta de Backups — SANEAR Operacional

Aplicativo desktop offline para importar os arquivos ZIP gerados pelo APP Operacional e criar o banco local `sanear_operacional.db`.

## O que pode ser pesquisado

- protocolo;
- número da Ordem de Serviço;
- Calçamento ou Asfalto;
- bairro, rua, número e ponto de referência;
- observações;
- data de criação e execução;
- status;
- e-mail ou UID do operador;
- backup de origem.

## Instalação rápida no Windows

1. Instale o Python 3.11 ou superior e marque **Add Python to PATH**.
2. Execute `instalar-e-executar.bat`.
3. No programa, escolha a pasta onde os ZIPs oficiais são guardados.
4. Clique em **Importar pasta**.

O programa calcula o SHA-256 de cada ZIP e também lê o hash de conteúdo do `manifest.json`. Um backup repetido é ignorado.

## Reconstrução do banco

Caso `sanear_operacional.db` seja apagado ou corrompido:

1. abra o aplicativo;
2. escolha a pasta dos ZIPs;
3. clique em **Reconstruir banco**.

O banco será recriado somente com base nos arquivos oficiais.

## Gerar EXE

Execute `gerar-executavel.bat`. O arquivo será criado em:

```text
dist\Consulta_Backups_SANEAR.exe
```

## Observação

Não edite o conteúdo interno dos ZIPs oficiais. Alterações podem invalidar a conferência pelo hash e comprometer a reconstrução do histórico.
