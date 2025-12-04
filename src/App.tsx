import React, { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "firebase/auth";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import "./App.css";
import { auth } from "./lib/firebaseClient";

import BuracoNaRua from "./pages/BuracoNaRua";
import Asfalto from "./pages/Asfalto";
import CaminhaoHidrojato from "./pages/CaminhaoHidrojato";
import EsgotoEntupido from "./pages/EsgotoEntupido";
import EsgotoRetornando from "./pages/EsgotoRetornando";
import TerceirizadaVisao from "./pages/TerceirizadaVisao";
import Usuario from "./pages/Usuario";
import Dashboard from "./pages/Dashboard";
import ListaOrdensServico from "./pages/ListaOrdensServico";

type MenuKey =
  | "dashboard"
  | "buraco"
  | "asfalto"
  | "hidrojato"
  | "esgoto_entupido"
  | "esgoto_retornando"
  | "terceirizada"
  | "usuario"
  | "listaOS";

type SimulatedRole = "diretor" | "operador" | "terceirizada" | "adm";

const App: React.FC = () => {
  // ---- AUTH ----
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ---- LOGIN FORM ----
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Modais da tela de login
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Navegação interna
  const [activeMenu, setActiveMenu] = useState<MenuKey>(() => {
    if (typeof window !== "undefined") {
      const stored = window.sessionStorage.getItem(
        "sanear-active-menu"
      ) as MenuKey | null;

      if (stored) {
        return stored;
      }
    }
    return "dashboard";
  });

  // Papel simulado (para exibir no topo)
  const [simulatedRole, setSimulatedRole] = useState<SimulatedRole>("operador");

  // Observa o estado de autenticação do Firebase
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthLoading(false);

      if (firebaseUser?.email) {
        setEmail(firebaseUser.email);
      }
    });

    return () => unsubscribe();
  }, []);

  // Sempre que trocar de página interna, grava na sessão do navegador.
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("sanear-active-menu", activeMenu);
    }
  }, [activeMenu]);

  // Carregar e-mail salvo (lembrar e-mail)
  useEffect(() => {
    const storedEmail = localStorage.getItem("sanear-email");
    if (storedEmail) {
      setEmail(storedEmail);
      setRememberMe(true);
    }
  }, []);

  // Carregar papel salvo (Usuario.tsx grava sanear-role)
  useEffect(() => {
    const storedRole = localStorage.getItem("sanear-role") as
      | SimulatedRole
      | null;
    if (
      storedRole === "diretor" ||
      storedRole === "operador" ||
      storedRole === "terceirizada" ||
      storedRole === "adm"
    ) {
      setSimulatedRole(storedRole);
    } else {
      setSimulatedRole("operador");
    }
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError(null);

    if (!email || !password) {
      setLoginError("Preencha e-mail e senha para entrar.");
      return;
    }

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      setUser(cred.user);
      setActiveMenu("dashboard");

      if (rememberMe) {
        localStorage.setItem("sanear-email", email);
      } else {
        localStorage.removeItem("sanear-email");
      }
    } catch (error: any) {
      console.error(error);
      let msg = "Não foi possível fazer login. Verifique os dados.";
      if (error?.code === "auth/invalid-credential") {
        msg = "E-mail ou senha inválidos.";
      } else if (error?.code === "auth/user-not-found") {
        msg = "Usuário não encontrado.";
      } else if (error?.code === "auth/wrong-password") {
        msg = "Senha incorreta.";
      }
      setLoginError(msg);
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
      setUser(null);
      setActiveMenu("dashboard");

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("sanear-active-menu");
      }
    } catch (error) {
      console.error(error);
    }
  }

  // ---- CONTEÚDO PRINCIPAL (PÁGINAS) ----
  function renderContent() {
    switch (activeMenu) {
      case "dashboard":
        return <Dashboard />;

      case "buraco":
        // IMPORTANTE: passa onBack para satisfazer o tipo BuracoNaRuaProps
        return <BuracoNaRua onBack={() => setActiveMenu("dashboard")} />;

      case "asfalto":
        return <Asfalto onBack={() => setActiveMenu("dashboard")} />;

      case "hidrojato":
        return <CaminhaoHidrojato />;

      case "esgoto_entupido":
        return <EsgotoEntupido />;

      case "esgoto_retornando":
        return <EsgotoRetornando />;

      case "terceirizada":
        return <TerceirizadaVisao />;

      case "usuario":
        return <Usuario />;

      case "listaOS":
        return <ListaOrdensServico />;

      default:
        return <Dashboard />;
    }
  }

  // ================= ESTADOS: CARREGANDO / NÃO LOGADO =================

  if (authLoading) {
    return (
      <div className="login-page">
        <div className="login-left">
          <div className="login-box">
            <h1 className="login-title">Sanear Operacional</h1>
            <p>Carregando...</p>
          </div>
        </div>
        <div className="login-right">
          <img
            src="/watermark.png"
            alt="Sanear Operacional"
            className="login-watermark-image"
          />
        </div>
      </div>
    );
  }

  if (!user) {
    // ================= TELA DE LOGIN =================
    return (
      <>
        <div className="login-page">
          <div className="login-left">
            <div className="login-box">
              <h1 className="login-title">Sanear Operacional</h1>
              <p className="login-subtitle">
                Acesse o painel para registrar e acompanhar as ordens de serviço
                de água, esgoto e pavimentação da cidade.
              </p>

              <form className="login-form" onSubmit={handleLogin}>
                <div className="field">
                  <span className="field-label">E-mail</span>
                  <div className="input-wrapper">
                    <span className="input-icon">📧</span>
                    <input
                      type="email"
                      placeholder="seu@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">Senha</span>
                  <div className="input-wrapper">
                    <span className="input-icon">🔒</span>
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="Digite sua senha"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="input-icon-right"
                      onClick={() => setShowPassword((prev) => !prev)}
                    >
                      {showPassword ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>

                <div className="login-extra-row">
                  <label className="remember-me">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                    />
                    <span>Lembrar este e-mail</span>
                  </label>

                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setShowForgotModal(true)}
                  >
                    Esqueceu sua senha?
                  </button>
                </div>

                {loginError && (
                  <div
                    style={{
                      marginTop: "0.75rem",
                      fontSize: "0.85rem",
                      color: "#b91c1c",
                    }}
                  >
                    {loginError}
                  </div>
                )}

                <button type="submit" className="btn-primary">
                  Entrar
                </button>

                <p className="signup-text">
                  Ainda não tem acesso?{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Crie agora
                  </button>
                </p>
              </form>
            </div>
          </div>

          <div className="login-right">
            <img
              src="/watermark.png"
              alt="Sanear Operacional"
              className="login-watermark-image"
            />
          </div>
        </div>

        {/* Modal: Esqueceu a senha */}
        {showForgotModal && (
          <div
            className="modal-backdrop"
            onClick={() => setShowForgotModal(false)}
          >
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">Esqueceu a senha</h3>
                <button
                  type="button"
                  className="modal-close"
                  onClick={() => setShowForgotModal(false)}
                >
                  ×
                </button>
              </div>
              <div className="modal-body">
                <p>Escreva aqui como será o processo de recuperar senha.</p>
                <p className="field-hint">
                  Depois podemos integrar com o envio de e-mail do Firebase.
                </p>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowForgotModal(false)}
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Criar acesso */}
        {showCreateModal && (
          <div
            className="modal-backdrop"
            onClick={() => setShowCreateModal(false)}
          >
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">Solicitar acesso</h3>
                <button
                  type="button"
                  className="modal-close"
                  onClick={() => setShowCreateModal(false)}
                >
                  ×
                </button>
              </div>
              <div className="modal-body">
                <p>Escreva aqui como o usuário solicita um novo acesso.</p>
                <p className="field-hint">
                  Ex.: apenas Diretor / ADM podem cadastrar usuários.
                </p>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ================= APP LOGADO =================

  return (
    <div className="app-shell">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo-circle">S</div>
          <div className="sidebar-brand-text">
            <h1>Sanear Operacional</h1>
            <span>Gestão de Ordens de Serviço</span>
          </div>
        </div>

        <div>
          <p className="sidebar-section-title">Visão geral</p>
          <div className="sidebar-nav">
            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "dashboard" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("dashboard")}
            >
              <span>Dashboard</span>
              <small>Resumo</small>
            </button>
          </div>
        </div>

        <div>
          <p className="sidebar-section-title">Operacional</p>
          <div className="sidebar-nav">
            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "buraco" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("buraco")}
            >
              <span>Calçamento</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "asfalto" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("asfalto")}
            >
              <span>Asfalto</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "hidrojato" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("hidrojato")}
            >
              <span>Caminhão Hidrojato</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "esgoto_entupido" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("esgoto_entupido")}
            >
              <span>Esgoto Entupido</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "esgoto_retornando" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("esgoto_retornando")}
            >
              <span>Esgoto Retornando</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "listaOS" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("listaOS")}
            >
              <span>Lista de Ordens de Serviço</span>
            </button>
          </div>
        </div>

        <div>
          <p className="sidebar-section-title">Terceirizada</p>
          <div className="sidebar-nav">
            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "terceirizada" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("terceirizada")}
            >
              <span>Visão da Terceirizada</span>
              <small>Execução</small>
            </button>
          </div>
        </div>

        <div>
          <p className="sidebar-section-title">Configurações</p>
          <div className="sidebar-nav">
            <button
              type="button"
              className={`sidebar-link ${
                activeMenu === "usuario" ? "active" : ""
              }`}
              onClick={() => setActiveMenu("usuario")}
            >
              <span>Usuário</span>
              <small>Perfil &amp; Acesso</small>
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <h2>
              {activeMenu === "dashboard"
                ? "Dashboard"
                : activeMenu === "buraco"
                ? "Calçamento"
                : activeMenu === "asfalto"
                ? "Asfalto"
                : activeMenu === "hidrojato"
                ? "Caminhão Hidrojato"
                : activeMenu === "esgoto_entupido"
                ? "Esgoto Entupido"
                : activeMenu === "esgoto_retornando"
                ? "Esgoto Retornando"
                : activeMenu === "terceirizada"
                ? "Visão da Terceirizada"
                : activeMenu === "usuario"
                ? "Usuário"
                : activeMenu === "listaOS"
                ? "Lista de Ordens de Serviço"
                : "Sanear Operacional"}
            </h2>
            <span>Sanear • Setor Operacional</span>
          </div>

          <div className="topbar-user">
            <div>
              <div className="topbar-user-name">
                {user?.displayName || "Usuário"}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                {user?.email}
              </div>
            </div>
            <span className="topbar-user-role">
              Perfil: {simulatedRole.toUpperCase()}
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleLogout}
            >
              Sair
            </button>
          </div>
        </header>

        <div className="page-wrapper">{renderContent()}</div>
      </main>
    </div>
  );
};

export default App;
