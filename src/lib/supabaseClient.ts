import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const camposAusentes = [
  ["VITE_SUPABASE_URL", supabaseUrl],
  ["VITE_SUPABASE_ANON_KEY", supabaseAnonKey],
]
  .filter(([, valor]) => !valor?.trim())
  .map(([nome]) => nome);

if (camposAusentes.length > 0) {
  throw new Error(
    `Configuração do Supabase incompleta. Variáveis ausentes: ${camposAusentes.join(
      ", "
    )}. Verifique o arquivo .env.local.`
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
