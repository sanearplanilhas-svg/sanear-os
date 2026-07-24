import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const ignoredGeneratedFolders = new Set([
  'node_modules',
  'dist',
  'dev-dist',
  'dist-ssr',
  'build',
  '.vite',
  '.turbo',
  '.cache',
]);

const forbiddenNames = new Set([
  '.git',
  '.vercel',
  '.firebase',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  'sanear-os',
]);

const forbiddenExtensions = ['.zip', '.rar', '.7z', '.bak', '.backup'];
const allowedFiles = new Set(['.env.example']);
const found = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).replaceAll(path.sep, '/');

    if (allowedFiles.has(relative) || allowedFiles.has(entry.name)) {
      continue;
    }

    if (ignoredGeneratedFolders.has(entry.name)) {
      continue;
    }

    if (forbiddenNames.has(entry.name) || forbiddenExtensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(relative);
      if (entry.isDirectory()) continue;
    }

    if (entry.isDirectory()) {
      walk(full);
    }
  }
}

walk(root);

if (found.length > 0) {
  console.error('\nForam encontrados arquivos/pastas que não devem ficar no projeto limpo:\n');
  for (const item of found) console.error(`- ${item}`);
  console.error('\nRemova esses itens antes de enviar ou versionar o projeto.\n');
  process.exit(1);
}

console.log('Projeto limpo: nenhum segredo, backup compactado, pasta duplicada ou configuração local foi encontrado.');
