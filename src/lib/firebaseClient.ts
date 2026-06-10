import { initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const camposObrigatorios: Array<[string, string | undefined]> = [
  ["VITE_FIREBASE_API_KEY", firebaseConfig.apiKey],
  ["VITE_FIREBASE_AUTH_DOMAIN", firebaseConfig.authDomain],
  ["VITE_FIREBASE_PROJECT_ID", firebaseConfig.projectId],
  ["VITE_FIREBASE_STORAGE_BUCKET", firebaseConfig.storageBucket],
  ["VITE_FIREBASE_MESSAGING_SENDER_ID", firebaseConfig.messagingSenderId],
  ["VITE_FIREBASE_APP_ID", firebaseConfig.appId],
];

const camposAusentes = camposObrigatorios
  .filter(([, valor]) => !valor?.trim())
  .map(([nome]) => nome);

if (camposAusentes.length > 0) {
  throw new Error(
    `Configuração do Firebase incompleta. Variáveis ausentes: ${camposAusentes.join(
      ", "
    )}. Verifique o arquivo .env.local.`
  );
}

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// A sessão permanece ao atualizar a página, mas termina quando todas as janelas
// da sessão do navegador são fechadas.
void setPersistence(auth, browserSessionPersistence).catch((error) => {
  console.error(
    "Erro ao configurar a persistência da sessão do Firebase Auth:",
    error
  );
});
