import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Se você estiver usando variáveis de ambiente (.env), pode trocar aqui.
// Por enquanto vou deixar direto, igual você pegou no console:
const firebaseConfig = {
  apiKey: "AIzaSyB2XPJfbxj3NjqB-FC8Fp7jjkeGdQcVQfs",
  authDomain: "sanear-operacional.firebaseapp.com",
  projectId: "sanear-operacional",
  storageBucket: "sanear-operacional.firebasestorage.app",
  messagingSenderId: "796977934426",
  appId: "1:796977934426:web:b908ed0c22728689dd2863",
  measurementId: "G-JZ9N4LCLJ3",
};

// Inicializa o app Firebase
const app = initializeApp(firebaseConfig);

// Exporta Auth (login)
export const auth = getAuth(app);

// >>> Persistência SOMENTE durante a sessão do navegador <<<
// Fecha todas as janelas do navegador = usuário desloga.
// Dar F5 / recarregar = continua logado normalmente.
setPersistence(auth, browserSessionPersistence).catch((error) => {
  console.error(
    "Erro ao configurar persistência de sessão do Firebase Auth:",
    error
  );
});

// Exporta Firestore (banco de dados)
export const db = getFirestore(app);
