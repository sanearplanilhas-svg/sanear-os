import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "firebase/auth";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  Timestamp,
  limit,
} from "firebase/firestore";

import "./App.css";
import { auth, db } from "./lib/firebaseClient";

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

type NotifKind = "created" | "concluded";

type NotifItem = {
  id: string; // único
  kind: NotifKind;
  osId: string;
  collectionName: "ordens_servico" | "ordensServico";
  origemLabel: "Calçamento" | "Asfalto";
  numero: string;
  tsMillis: number;
  message: string;
};

function normalizeText(value?: string | null): string {
  return (value ?? "")
    .toString()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function inferOrigemLabel(
  tipo: any,
  fallback: "Calçamento" | "Asfalto"
): "Calçamento" | "Asfalto" {
  const t = normalizeText(typeof tipo === "string" ? tipo : "");
  if (t.includes("BURACO") || t.includes("CALCAMENTO") || t === "BURACO_RUA") {
    return "Calçamento";
  }
  if (t.includes("ASFALTO") || t === "ASFALTO") {
    return "Asfalto";
  }
  return fallback;
}

function formatNotifTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getNumeroOs(data: any, fallbackId: string) {
  return (
    data?.ordemServico ??
    data?.protocolo ??
    data?.numeroOS ??
    data?.os ??
    fallbackId
  );
}

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

      if (stored) return stored;
    }
    return "dashboard";
  });

  // Papel simulado (para exibir no topo)
  const [simulatedRole, setSimulatedRole] = useState<SimulatedRole>("operador");

  // ==== NOTIFICAÇÕES (feed) ====
  const [notifOpen, setNotifOpen] = useState(false);

  const [createdBuraco, setCreatedBuraco] = useState<NotifItem[]>([]);
  const [createdAsfalto, setCreatedAsfalto] = useState<NotifItem[]>([]);
  const [concludedBuraco, setConcludedBuraco] = useState<NotifItem[]>([]);
  const [concludedAsfalto, setConcludedAsfalto] = useState<NotifItem[]>([]);

  // Marca d’água baseada em timestamps do Firestore (mitiga drift de relógio do cliente)
  const [serverNowMs, setServerNowMs] = useState<number>(Date.now());
  const serverNowRef = useRef<number>(Date.now());

  const notifications = useMemo(() => {
    const all = [
      ...createdBuraco,
      ...createdAsfalto,
      ...concludedBuraco,
      ...concludedAsfalto,
    ];

    // remove duplicados por id
    const map = new Map<string, NotifItem>();
    for (const n of all) map.set(n.id, n);

    return Array.from(map.values()).sort((a, b) => b.tsMillis - a.tsMillis);
  }, [createdBuraco, createdAsfalto, concludedBuraco, concludedAsfalto]);

  const unreadCount = notifications.length;

  // Mantém uma aproximação do "agora" do servidor a partir dos últimos registros gravados.
  // Isso evita que um relógio local adiantado faça você "perder" notificações (ex.: você cria uma OS e não aparece pra você).
  useEffect(() => {
    if (!user) return;

    const zeroTs = Timestamp.fromMillis(0);

    const update = (ms: number | null | undefined) => {
      if (!ms || !Number.isFinite(ms)) return;
      if (ms > serverNowRef.current) {
        serverNowRef.current = ms;
        setServerNowMs(ms);
      }
    };

    const qLatestCreatedBuraco = query(
      collection(db, "ordens_servico"),
      where("createdAt", ">", zeroTs),
      orderBy("createdAt", "desc"),
      limit(1)
    );

    const u1 = onSnapshot(
      qLatestCreatedBuraco,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.createdAt as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow created ordens_servico:", err)
    );

    const qLatestCreatedAsfalto = query(
      collection(db, "ordensServico"),
      where("createdAt", ">", zeroTs),
      orderBy("createdAt", "desc"),
      limit(1)
    );

    const u2 = onSnapshot(
      qLatestCreatedAsfalto,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.createdAt as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow created ordensServico:", err)
    );

    const qLatestExecBuraco = query(
      collection(db, "ordens_servico"),
      where("dataExecucao", ">", zeroTs),
      orderBy("dataExecucao", "desc"),
      limit(1)
    );

    const u3 = onSnapshot(
      qLatestExecBuraco,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.dataExecucao as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow exec ordens_servico:", err)
    );

    const qLatestExecAsfalto = query(
      collection(db, "ordensServico"),
      where("dataExecucao", ">", zeroTs),
      orderBy("dataExecucao", "desc"),
      limit(1)
    );

    const u4 = onSnapshot(
      qLatestExecAsfalto,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.dataExecucao as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow exec ordensServico:", err)
    );

    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, [user]);

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

  // Fecha o popover ao clicar fora
  useEffect(() => {
    if (!notifOpen) return;
    const handler = () => setNotifOpen(false);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [notifOpen]);

  // Listener de novas OS (criadas) e OS concluídas (dataExecucao)
  useEffect(() => {
    if (!user) return;

    const seenKey = `sanear-lastSeenOS-${user.uid}`;
    const raw = localStorage.getItem(seenKey);
    let lastSeenMs = raw ? Number(raw) : 0;

    // Se o relógio do PC estiver adiantado (ou o valor salvo estiver "no futuro"), você pode perder notificações.
    // Aqui nós corrigimos automaticamente usando a melhor aproximação de tempo do servidor que tivermos.
    const approxServerNow = serverNowRef.current || serverNowMs || 0;
    if (approxServerNow && lastSeenMs > approxServerNow + 60_000) {
      lastSeenMs = approxServerNow;
      localStorage.setItem(seenKey, String(lastSeenMs));
    }

    // Primeira vez no navegador: não mostra histórico como "novo"
    if (!lastSeenMs || Number.isNaN(lastSeenMs)) {
      localStorage.setItem(seenKey, String(serverNowRef.current || serverNowMs || Date.now()));
      setCreatedBuraco([]);
      setCreatedAsfalto([]);
      setConcludedBuraco([]);
      setConcludedAsfalto([]);
      return;
    }

    const lastSeenTs = Timestamp.fromMillis(lastSeenMs);

    const buildCreatedNotifs = (
      colName: "ordens_servico" | "ordensServico",
      fallbackOrigem: "Calçamento" | "Asfalto",
      snap: any
    ) => {
      const items: NotifItem[] = snap.docs.map((d: any) => {
        const data = d.data() as any;
        const ts = (data.createdAt as Timestamp | null) ?? null;
        const tsMillis = ts ? ts.toMillis() : Date.now();

        const origemLabel = inferOrigemLabel(data.tipo, fallbackOrigem);
        const numero = String(getNumeroOs(data, d.id));

        return {
          id: `created-${colName}-${d.id}-${tsMillis}`,
          kind: "created",
          osId: d.id,
          collectionName: colName,
          origemLabel,
          numero,
          tsMillis,
          message: `Uma nova OS de ${origemLabel} foi criada (OS ${numero}).`,
        };
      });
      return items;
    };

    const buildConcludedNotifs = (
      colName: "ordens_servico" | "ordensServico",
      fallbackOrigem: "Calçamento" | "Asfalto",
      snap: any
    ) => {
      const items: NotifItem[] = snap.docs.map((d: any) => {
        const data = d.data() as any;
        const ts =
          (data.dataExecucao as Timestamp | null) ??
          (data.updatedAt as Timestamp | null) ??
          null;

        const tsMillis = ts ? ts.toMillis() : Date.now();

        const origemLabel = inferOrigemLabel(data.tipo, fallbackOrigem);
        const numero = String(getNumeroOs(data, d.id));

        return {
          id: `concluded-${colName}-${d.id}-${tsMillis}`,
          kind: "concluded",
          osId: d.id,
          collectionName: colName,
          origemLabel,
          numero,
          tsMillis,
          message: `A OS ${numero} foi marcada como concluída (${origemLabel}).`,
        };
      });
      return items;
    };

    // CRIADAS
    const qCreatedBuraco = query(
      collection(db, "ordens_servico"),
      where("createdAt", ">", lastSeenTs),
      orderBy("createdAt", "desc"),
      limit(20)
    );

    const qCreatedAsfalto = query(
      collection(db, "ordensServico"),
      where("createdAt", ">", lastSeenTs),
      orderBy("createdAt", "desc"),
      limit(20)
    );

    // CONCLUÍDAS (usa dataExecucao como “evento de conclusão”)
    const qConcludedBuraco = query(
      collection(db, "ordens_servico"),
      where("dataExecucao", ">", lastSeenTs),
      orderBy("dataExecucao", "desc"),
      limit(20)
    );

    const qConcludedAsfalto = query(
      collection(db, "ordensServico"),
      where("dataExecucao", ">", lastSeenTs),
      orderBy("dataExecucao", "desc"),
      limit(20)
    );

    const u1 = onSnapshot(
      qCreatedBuraco,
      (snap) => setCreatedBuraco(buildCreatedNotifs("ordens_servico", "Calçamento", snap)),
      (err) => console.error("Notif created ordens_servico:", err)
    );

    const u2 = onSnapshot(
      qCreatedAsfalto,
      (snap) => setCreatedAsfalto(buildCreatedNotifs("ordensServico", "Asfalto", snap)),
      (err) => console.error("Notif created ordensServico:", err)
    );

    const u3 = onSnapshot(
      qConcludedBuraco,
      (snap) => setConcludedBuraco(buildConcludedNotifs("ordens_servico", "Calçamento", snap)),
      (err) => console.error("Notif concluded ordens_servico:", err)
    );

    const u4 = onSnapshot(
      qConcludedAsfalto,
      (snap) => setConcludedAsfalto(buildConcludedNotifs("ordensServico", "Asfalto", snap)),
      (err) => console.error("Notif concluded ordensServico:", err)
    );

    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, [user, serverNowMs]);

  function markAllAsSeen() {
    if (!user) return;
    const key = `sanear-lastSeenOS-${user.uid}`;

    const maxFromFeed = notifications.reduce((acc, n) => Math.max(acc, n.tsMillis || 0), 0);
    const approxServerNow = serverNowRef.current || serverNowMs || Date.now();
    const watermark = Math.max(maxFromFeed, approxServerNow, 0);

    localStorage.setItem(key, String(watermark));

    setCreatedBuraco([]);
    setCreatedAsfalto([]);
    setConcludedBuraco([]);
    setConcludedAsfalto([]);
    setNotifOpen(false);
  }

  function openNotification(n: NotifItem) {
    // marca como visto (prático e simples)
    markAllAsSeen();

    // manda abrir na Lista + detalhes da OS
    window.sessionStorage.setItem(
      "sanear-open-os",
      JSON.stringify({ id: n.osId, col: n.collectionName })
    );

    setActiveMenu("listaOS");
  }

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

      if (rememberMe) localStorage.setItem("sanear-email", email);
      else localStorage.removeItem("sanear-email");
    } catch (error: any) {
      console.error(error);
      let msg = "Não foi possível fazer login. Verifique os dados.";
      if (error?.code === "auth/invalid-credential") msg = "E-mail ou senha inválidos.";
      else if (error?.code === "auth/user-not-found") msg = "Usuário não encontrado.";
      else if (error?.code === "auth/wrong-password") msg = "Senha incorreta.";
      setLoginError(msg);
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
      setUser(null);
      setActiveMenu("dashboard");

      setNotifOpen(false);
      setCreatedBuraco([]);
      setCreatedAsfalto([]);
      setConcludedBuraco([]);
      setConcludedAsfalto([]);

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("sanear-active-menu");
      }
    } catch (error) {
      console.error(error);
    }
  }

  function renderContent() {
    switch (activeMenu) {
      case "dashboard":
        return <Dashboard />;
      case "buraco":
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

        {showForgotModal && (
          <div className="modal-backdrop" onClick={() => setShowForgotModal(false)}>
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

        {showCreateModal && (
          <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
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

  return (
    <div className="app-shell">
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
              className={`sidebar-link ${activeMenu === "dashboard" ? "active" : ""}`}
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
              className={`sidebar-link ${activeMenu === "buraco" ? "active" : ""}`}
              onClick={() => setActiveMenu("buraco")}
            >
              <span>Calçamento</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${activeMenu === "asfalto" ? "active" : ""}`}
              onClick={() => setActiveMenu("asfalto")}
            >
              <span>Asfalto</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${activeMenu === "hidrojato" ? "active" : ""}`}
              onClick={() => setActiveMenu("hidrojato")}
            >
              <span>Caminhão Hidrojato</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${activeMenu === "esgoto_entupido" ? "active" : ""}`}
              onClick={() => setActiveMenu("esgoto_entupido")}
            >
              <span>Esgoto Entupido</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${activeMenu === "esgoto_retornando" ? "active" : ""}`}
              onClick={() => setActiveMenu("esgoto_retornando")}
            >
              <span>Esgoto Retornando</span>
            </button>

            <button
              type="button"
              className={`sidebar-link ${activeMenu === "listaOS" ? "active" : ""}`}
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
              className={`sidebar-link ${activeMenu === "terceirizada" ? "active" : ""}`}
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
              className={`sidebar-link ${activeMenu === "usuario" ? "active" : ""}`}
              onClick={() => setActiveMenu("usuario")}
            >
              <span>Usuário</span>
              <small>Perfil &amp; Acesso</small>
            </button>
          </div>
        </div>
      </aside>

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
              <div className="topbar-user-name">{user?.displayName || "Usuário"}</div>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                {user?.email}
              </div>
            </div>

            <span className="topbar-user-role">Perfil: {simulatedRole.toUpperCase()}</span>

            {/* NOTIFICAÇÕES */}
            <div className="notif2-wrapper" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="notif2-btn"
                onClick={() => setNotifOpen((p) => !p)}
                aria-label="Notificações"
                title="Notificações"
              >
                🔔
                {unreadCount > 0 && (
                  <span className="notif2-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
                )}
              </button>

              {notifOpen && (
                <div className="notif2-popover">
                  <div className="notif2-head">
                    <div>
                      <div className="notif2-title">Notificações</div>
                      <div className="notif2-sub">
                        Novas OS criadas e OS concluídas desde a última visualização.
                      </div>
                    </div>

                    <button type="button" className="notif2-clear" onClick={markAllAsSeen}>
                      Marcar tudo como visto
                    </button>
                  </div>

                  {notifications.length === 0 ? (
                    <div className="notif2-empty">Nenhuma notificação nova.</div>
                  ) : (
                    <div className="notif2-list">
                      {notifications.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          className="notif2-item"
                          onClick={() => openNotification(n)}
                        >
                          <div className="notif2-item-title">{n.message}</div>
                          <div className="notif2-item-meta">
                            {formatNotifTime(n.tsMillis)}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button type="button" className="btn-secondary" onClick={handleLogout}>
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
