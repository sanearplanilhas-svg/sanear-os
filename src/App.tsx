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
import ServicoSanearVisao from "./pages/ServicoSanearVisao";
import Usuario from "./pages/Usuario";
import Dashboard from "./pages/Dashboard";
import ListaOrdensServico from "./pages/ListaOrdensServico";
import Backup from "./pages/Backup";

type MenuKey =
  | "dashboard"
  | "buraco"
  | "asfalto"
  | "hidrojato"
  | "esgoto_entupido"
  | "esgoto_retornando"
  | "terceirizada"
  | "servico_sanear"
  | "usuario"
  | "listaOS"
  | "backup";

type SimulatedRole = "diretor" | "operador" | "terceirizada" | "adm";

type NotifKind = "created" | "concluded";

type NotifItem = {
  id: string; // único
  kind: NotifKind;
  osId: string;
  collectionName: "ordens_servico" | "ordensServico" | "ordensHidrojato";
  origemLabel: "Calçamento" | "Asfalto" | "Hidrojato";
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
  fallback: "Calçamento" | "Asfalto" | "Hidrojato"
): "Calçamento" | "Asfalto" | "Hidrojato" {
  const t = normalizeText(typeof tipo === "string" ? tipo : "");
  if (t.includes("BURACO") || t.includes("CALCAMENTO") || t === "BURACO_RUA") {
    return "Calçamento";
  }
  if (t.includes("ASFALTO") || t === "ASFALTO") {
    return "Asfalto";
  }
  if (t.includes("HIDROJATO") || t === "HIDROJATO") {
    return "Hidrojato";
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
function getMenuMeta(menu: MenuKey): { title: string; section: string } {
  switch (menu) {
    case "dashboard":
      return { title: "Dashboard", section: "Visão geral" };
    case "buraco":
      return { title: "Calçamento", section: "Operacional" };
    case "asfalto":
      return { title: "Asfalto", section: "Operacional" };
    case "hidrojato":
      return { title: "Caminhão Hidrojato", section: "Operacional" };
    case "esgoto_entupido":
      return { title: "Esgoto Entupido", section: "Operacional" };
    case "esgoto_retornando":
      return { title: "Esgoto Retornando", section: "Operacional" };
    case "listaOS":
      return { title: "Lista de Ordens de Serviço", section: "Operacional" };
    case "terceirizada":
      return { title: "Visão da Terceirizada", section: "Terceirizada" };
    case "servico_sanear":
      return { title: "Área de Serviço SANEAR", section: "Serviço SANEAR" };
    case "usuario":
      return { title: "Usuário", section: "Configurações" };
    case "backup":
      return { title: "Backup", section: "Configurações" };
    default:
      return { title: "Sanear Operacional", section: "Setor Operacional" };
  }
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const [createdBuraco, setCreatedBuraco] = useState<NotifItem[]>([]);
  const [createdAsfalto, setCreatedAsfalto] = useState<NotifItem[]>([]);
  const [createdHidrojato, setCreatedHidrojato] = useState<NotifItem[]>([]);
  const [concludedBuraco, setConcludedBuraco] = useState<NotifItem[]>([]);
  const [concludedAsfalto, setConcludedAsfalto] = useState<NotifItem[]>([]);
  const [concludedHidrojato, setConcludedHidrojato] = useState<NotifItem[]>([]);

  // Marca d’água baseada em timestamps do Firestore (mitiga drift de relógio do cliente)
  const [serverNowMs, setServerNowMs] = useState<number>(Date.now());
  const serverNowRef = useRef<number>(Date.now());

  const notifications = useMemo(() => {
    const all = [
      ...createdBuraco,
      ...createdAsfalto,
      ...createdHidrojato,
      ...concludedBuraco,
      ...concludedAsfalto,
      ...concludedHidrojato,
    ];

    // remove duplicados por id
    const map = new Map<string, NotifItem>();
    for (const n of all) map.set(n.id, n);

    return Array.from(map.values()).sort((a, b) => b.tsMillis - a.tsMillis);
  }, [createdBuraco, createdAsfalto, createdHidrojato, concludedBuraco, concludedAsfalto, concludedHidrojato]);

  const unreadCount = notifications.length;

  const pageMeta = getMenuMeta(activeMenu);

  const userDisplayName =
    user?.displayName ||
    (user?.email ? user.email.split("@")[0] : "Usuário") ||
    "Usuário";

  const userInitial = (userDisplayName || "U").trim().charAt(0).toUpperCase();

  const [sidebarClock, setSidebarClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setSidebarClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const isTerceirizada = simulatedRole === "terceirizada";

  const roleLabel = useMemo(() => {
    switch (simulatedRole) {
      case "adm":
        return "Administrador";
      case "diretor":
        return "Diretor";
      case "terceirizada":
        return "Terceirizada";
      default:
        return "Operador";
    }
  }, [simulatedRole]);

  const sidebarDate = useMemo(
    () =>
      sidebarClock.toLocaleDateString("pt-BR", {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
      }),
    [sidebarClock]
  );

  const sidebarTime = useMemo(
    () =>
      sidebarClock.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [sidebarClock]
  );

  type SidebarItemProps = {
    menu: MenuKey;
    icon: string;
    title: string;
    subtitle?: string;
    badge?: string | number;
    emphasis?: "normal" | "primary" | "warning";
  };

  function SidebarItem({
    menu,
    icon,
    title,
    subtitle,
    badge,
    emphasis = "normal",
  }: SidebarItemProps) {
    const active = activeMenu === menu;

    return (
      <button
        type="button"
        className={`sidebar-link ${active ? "active" : ""} sidebar-link-${emphasis}`}
        onClick={() => setActiveMenu(menu)}
        title={subtitle ? `${title} - ${subtitle}` : title}
      >
        <span className="sidebar-link-left">
          <span className="sidebar-link-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="sidebar-link-text">
            <span className="sidebar-link-title">{title}</span>
            {subtitle && <span className="sidebar-link-subtitle">{subtitle}</span>}
          </span>
        </span>

        {badge !== undefined && badge !== null && badge !== "" && (
          <span className="sidebar-link-badge">{badge}</span>
        )}
      </button>
    );
  }


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

    const qLatestCreatedHidrojato = query(
      collection(db, "ordensHidrojato"),
      where("createdAt", ">", zeroTs),
      orderBy("createdAt", "desc"),
      limit(1)
    );

    const u3 = onSnapshot(
      qLatestCreatedHidrojato,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.createdAt as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow created ordensHidrojato:", err)
    );

    const qLatestExecBuraco = query(
      collection(db, "ordens_servico"),
      where("dataExecucao", ">", zeroTs),
      orderBy("dataExecucao", "desc"),
      limit(1)
    );

    const u4 = onSnapshot(
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

    const u5 = onSnapshot(
      qLatestExecAsfalto,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.dataExecucao as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow exec ordensServico:", err)
    );

    const qLatestExecHidrojato = query(
      collection(db, "ordensHidrojato"),
      where("dataExecucao", ">", zeroTs),
      orderBy("dataExecucao", "desc"),
      limit(1)
    );

    const u6 = onSnapshot(
      qLatestExecHidrojato,
      (snap) => {
        const d = snap.docs[0];
        const ts = (d?.data() as any)?.dataExecucao as Timestamp | null | undefined;
        update(ts?.toMillis?.());
      },
      (err) => console.error("ServerNow exec ordensHidrojato:", err)
    );

    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
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

  
  // Navegação por evento (para páginas internas mudarem o menu sem props)
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<{ menu?: MenuKey }>;
      const next = e.detail?.menu;
      if (next) setActiveMenu(next);
    };

    window.addEventListener("sanear:navigate", handler as EventListener);
    return () => {
      window.removeEventListener("sanear:navigate", handler as EventListener);
    };
  }, []);
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

  useEffect(() => {
    if (simulatedRole === "terceirizada" && activeMenu !== "terceirizada") {
      setActiveMenu("terceirizada");
    }
  }, [simulatedRole, activeMenu]);

  // Fecha popovers ao clicar fora
useEffect(() => {
  if (!notifOpen && !userMenuOpen) return;
  const handler = () => {
    setNotifOpen(false);
      setUserMenuOpen(false);
    setUserMenuOpen(false);
  };
  window.addEventListener("click", handler);
  return () => window.removeEventListener("click", handler);
}, [notifOpen, userMenuOpen]);

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
      setCreatedHidrojato([]);
      setConcludedBuraco([]);
      setConcludedAsfalto([]);
      setConcludedHidrojato([]);
      return;
    }

    const lastSeenTs = Timestamp.fromMillis(lastSeenMs);

    const buildCreatedNotifs = (
      colName: "ordens_servico" | "ordensServico" | "ordensHidrojato",
      fallbackOrigem: "Calçamento" | "Asfalto" | "Hidrojato",
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
      colName: "ordens_servico" | "ordensServico" | "ordensHidrojato",
      fallbackOrigem: "Calçamento" | "Asfalto" | "Hidrojato",
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

    const qCreatedHidrojato = query(
      collection(db, "ordensHidrojato"),
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

    const qConcludedHidrojato = query(
      collection(db, "ordensHidrojato"),
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
      qCreatedHidrojato,
      (snap) => setCreatedHidrojato(buildCreatedNotifs("ordensHidrojato", "Hidrojato", snap)),
      (err) => console.error("Notif created ordensHidrojato:", err)
    );

    const u4 = onSnapshot(
      qConcludedBuraco,
      (snap) => setConcludedBuraco(buildConcludedNotifs("ordens_servico", "Calçamento", snap)),
      (err) => console.error("Notif concluded ordens_servico:", err)
    );

    const u5 = onSnapshot(
      qConcludedAsfalto,
      (snap) => setConcludedAsfalto(buildConcludedNotifs("ordensServico", "Asfalto", snap)),
      (err) => console.error("Notif concluded ordensServico:", err)
    );

    const u6 = onSnapshot(
      qConcludedHidrojato,
      (snap) => setConcludedHidrojato(buildConcludedNotifs("ordensHidrojato", "Hidrojato", snap)),
      (err) => console.error("Notif concluded ordensHidrojato:", err)
    );

    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
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
    setCreatedHidrojato([]);
    setConcludedBuraco([]);
    setConcludedAsfalto([]);
    setConcludedHidrojato([]);
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
      setCreatedHidrojato([]);
      setConcludedBuraco([]);
      setConcludedAsfalto([]);
      setConcludedHidrojato([]);

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("sanear-active-menu");
      }
    } catch (error) {
      console.error(error);
    }
  }

  function renderContent() {
    if (simulatedRole === "terceirizada" && activeMenu !== "terceirizada") {
      return <TerceirizadaVisao />;
    }

    switch (activeMenu) {
      case "dashboard":
        return <Dashboard />;
      case "buraco":
        return <BuracoNaRua onBack={() => setActiveMenu("dashboard")} />;
      case "asfalto":
        return <Asfalto onBack={() => setActiveMenu("dashboard")} />;
      case "hidrojato":
        return <CaminhaoHidrojato onBack={() => setActiveMenu("dashboard")} />;
      case "esgoto_entupido":
        return <EsgotoEntupido />;
      case "esgoto_retornando":
        return <EsgotoRetornando />;
      case "terceirizada":
        return <TerceirizadaVisao />;
      case "servico_sanear":
        return <ServicoSanearVisao />;
      case "usuario":
        return <Usuario />;
      case "listaOS":
        return <ListaOrdensServico />;
      case "backup":
        return <Backup />;
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
        <div className="sidebar-brand sidebar-brand-modern">
          <div className="sidebar-logo-circle sidebar-logo-modern">S</div>
          <div className="sidebar-brand-text">
            <h1>SANEAR</h1>
            <span>Operacional</span>
          </div>
          <span className="sidebar-live-dot" title="Sistema online" aria-label="Sistema online" />
        </div>

        <div className="sidebar-user-card">
          <div className="sidebar-user-main">
            <div className="sidebar-user-avatar">{userInitial}</div>
            <div className="sidebar-user-info">
              <strong title={userDisplayName}>{userDisplayName}</strong>
              <span>{roleLabel}</span>
            </div>
          </div>

          <div className="sidebar-clock-card" aria-label="Data e hora atual">
            <span>{sidebarDate.replace(".", "")}</span>
            <strong>{sidebarTime}</strong>
          </div>
        </div>

        <div className="sidebar-scroll-area">
          <div className="sidebar-block sidebar-block-highlight">
            <p className="sidebar-section-title">Central</p>
            <div className="sidebar-nav">
              <SidebarItem
                menu="dashboard"
                icon="📊"
                title="Dashboard"
                subtitle="Resumo geral"
                badge={unreadCount > 0 ? unreadCount > 99 ? "99+" : unreadCount : undefined}
                emphasis="primary"
              />
              {!isTerceirizada && (
                <SidebarItem
                  menu="listaOS"
                  icon="📋"
                  title="Lista de OS"
                  subtitle="Consulta e acompanhamento"
                />
              )}
            </div>
          </div>

          {!isTerceirizada && (
            <div className="sidebar-block">
              <p className="sidebar-section-title">Abrir Ordem</p>
              <div className="sidebar-nav">
                <SidebarItem
                  menu="buraco"
                  icon="🧱"
                  title="Calçamento"
                  subtitle="Blocos"
                />
                <SidebarItem
                  menu="asfalto"
                  icon="🛣️"
                  title="Asfalto"
                  subtitle="Reparo e tapa-buraco"
                />
                <SidebarItem
                  menu="hidrojato"
                  icon="🚛"
                  title="Caminhão Hidrojato"
                  subtitle="Serviço interno SANEAR"
                />
                <SidebarItem
                  menu="esgoto_entupido"
                  icon="🚧"
                  title="Esgoto Entupido"
                  subtitle="Rede obstruída"
                />
                <SidebarItem
                  menu="esgoto_retornando"
                  icon="💧"
                  title="Esgoto Retornando"
                  subtitle="Retorno no imóvel"
                />
              </div>
            </div>
          )}

          {!isTerceirizada && (
            <div className="sidebar-block sidebar-block-sanear">
              <p className="sidebar-section-title">Execução Interna</p>
              <div className="sidebar-nav">
                <SidebarItem
                  menu="servico_sanear"
                  icon="🛠️"
                  title="Serviço SANEAR"
                  subtitle="Serviços internos"
                  emphasis="primary"
                />
              </div>
            </div>
          )}

          <div className="sidebar-block sidebar-block-terceira">
            <p className="sidebar-section-title">Execução Externa</p>
            <div className="sidebar-nav">
              <SidebarItem
                menu="terceirizada"
                icon="🤝"
                title="Área da Terceirizada"
                subtitle="Serviços enviados"
              />
            </div>
          </div>

          <div className="sidebar-block">
            <p className="sidebar-section-title">Administração</p>
            <div className="sidebar-nav">
              <SidebarItem
                menu="usuario"
                icon="👤"
                title="Usuário"
                subtitle="Perfil e acesso"
              />
              {!isTerceirizada && (
                <SidebarItem
                  menu="backup"
                  icon="🗄️"
                  title="Backup"
                  subtitle="Exportação segura"
                  emphasis="warning"
                />
              )}
            </div>
          </div>
        </div>

        <div className="sidebar-footer-card">
          <span className="sidebar-footer-eyebrow">Operação</span>
          <strong>Controle de OS ativo</strong>
          <small>Registre, acompanhe e finalize os serviços pelo painel.</small>
        </div>
      </aside>

      <main className="app-main">
        <header className="topbar">
  <div className="topbar-inner">
    <div className="topbar-left">
      <div
        className="topbar-crumbs"
        title={`Sanear / Setor Operacional / ${pageMeta.section}`}
      >
        <span className="topbar-crumb">Sanear</span>
        <span className="topbar-sep">/</span>
        <span className="topbar-crumb">Setor Operacional</span>
        <span className="topbar-sep">/</span>
        <span className="topbar-crumb">{pageMeta.section}</span>
      </div>

      <div className="topbar-page-title" title={pageMeta.title}>
        {pageMeta.title}
      </div>
    </div>

    <div className="topbar-actions">
      {/* NOTIFICAÇÕES */}
      <div className="notif2-wrapper" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="notif2-btn"
          onClick={() => {
            setUserMenuOpen(false);
            setNotifOpen((p) => !p);
          }}
          aria-label="Notificações"
          title="Notificações"
        >
          🔔
          {unreadCount > 0 && (
            <span className="notif2-badge">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
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
                    <div className="notif2-item-meta">{formatNotifTime(n.tsMillis)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* USUÁRIO */}
      <div className="user2-wrapper" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="user2-btn"
          onClick={() => {
            setNotifOpen(false);
            setUserMenuOpen((p) => !p);
          }}
          aria-label="Menu do usuário"
          title="Menu do usuário"
        >
          <span className="user2-avatar" aria-hidden="true">
            {userInitial}
          </span>

          <span className="user2-meta">
            <span className="user2-name" title={userDisplayName}>
              {userDisplayName}
            </span>
            <span className="user2-role">{simulatedRole.toUpperCase()}</span>
          </span>

          <span className="user2-caret" aria-hidden="true">
            ▾
          </span>
        </button>

        {userMenuOpen && (
          <div className="user2-popover">
            <div className="user2-popover-head">
              <div className="user2-popover-title">{userDisplayName}</div>
              {user?.email && <div className="user2-popover-email">{user.email}</div>}
              <div className="user2-popover-pill">
                Perfil: {simulatedRole.toUpperCase()}
              </div>
            </div>

            <div className="user2-popover-actions">
              <button
                type="button"
                className="user2-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  setActiveMenu("usuario");
                }}
              >
                👤 Perfil &amp; Acesso
              </button>

              <button
                type="button"
                className="user2-item user2-item-danger"
                onClick={handleLogout}
              >
                🚪 Sair
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  </div>
</header>

        <div className="page-wrapper">{renderContent()}</div>
      </main>
    </div>
  );
};

export default App;
