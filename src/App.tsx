import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "firebase/auth";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
  Timestamp,
  limit,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";

import "./App.css";
import { auth, db } from "./lib/firebaseClient";
import { contarAnexosPendentes } from "./lib/anexosPendentes";
import UpdatePwaNotice from "./components/UpdatePwaNotice";

type MenuKey =
  | "dashboard"
  | "alertas"
  | "buraco"
  | "asfalto"
  | "hidrojato"
  | "esgoto_entupido"
  | "esgoto_retornando"
  | "terceirizada"
  | "servico_sanear"
  | "usuario"
  | "listaOS"
  | "anexos_pendentes"
  | "backup";

const pageImporters: Record<
  MenuKey,
  () => Promise<{ default: React.ComponentType<any> }>
> = {
  dashboard: () => import("./pages/Dashboard"),
  alertas: () => import("./pages/AlertasOperacionais"),
  buraco: () => import("./pages/BuracoNaRua"),
  asfalto: () => import("./pages/Asfalto"),
  hidrojato: () => import("./pages/CaminhaoHidrojato"),
  esgoto_entupido: () => import("./pages/EsgotoEntupido"),
  esgoto_retornando: () => import("./pages/EsgotoRetornando"),
  terceirizada: () => import("./pages/TerceirizadaVisao"),
  servico_sanear: () => import("./pages/ServicoSanearVisao"),
  usuario: () => import("./pages/Usuario"),
  listaOS: () => import("./pages/ListaOrdensServico"),
  anexos_pendentes: () => import("./pages/AnexosPendentes"),
  backup: () => import("./pages/Backup"),
};

const Dashboard = lazy(pageImporters.dashboard);
const AlertasOperacionais = lazy(pageImporters.alertas);
const BuracoNaRua = lazy(pageImporters.buraco);
const Asfalto = lazy(pageImporters.asfalto);
const CaminhaoHidrojato = lazy(pageImporters.hidrojato);
const EsgotoEntupido = lazy(pageImporters.esgoto_entupido);
const EsgotoRetornando = lazy(pageImporters.esgoto_retornando);
const TerceirizadaVisao = lazy(pageImporters.terceirizada);
const ServicoSanearVisao = lazy(pageImporters.servico_sanear);
const Usuario = lazy(pageImporters.usuario);
const ListaOrdensServico = lazy(pageImporters.listaOS);
const AnexosPendentes = lazy(pageImporters.anexos_pendentes);
const Backup = lazy(pageImporters.backup);

function preloadPage(menu: MenuKey) {
  void pageImporters[menu]?.();
}

function PageLoadingFallback({ title }: { title: string }) {
  return (
    <section className="page-card page-loading-card" aria-live="polite">
      <div className="page-loading-spinner" aria-hidden="true" />
      <div>
        <h2>Carregando {title}...</h2>
        <p>Preparando a tela solicitada. Isso deixa o aplicativo mais leve no celular.</p>
      </div>
    </section>
  );
}

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

function timestampToMillis(value: unknown): number | null {
  if (!value) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };

  if (typeof maybeTimestamp?.toMillis === "function") {
    const ms = maybeTimestamp.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof maybeTimestamp?.seconds === "number") {
    return maybeTimestamp.seconds * 1000;
  }

  return null;
}

function resolveUserRole(value: unknown): SimulatedRole {
  const role = normalizeText(String(value ?? ""));

  if (role === "ADM" || role === "ADMIN" || role === "ADMINISTRADOR") {
    return "adm";
  }

  if (role === "DIRETOR" || role === "DIRETORA") {
    return "diretor";
  }

  if (role === "TERCEIRIZADA" || role === "TERCEIRO" || role === "TERCEIRADO") {
    return "terceirizada";
  }

  return "operador";
}

function resolveProfileName(data: any, firebaseUser: User | null): string {
  const dbName =
    data?.nome ??
    data?.name ??
    data?.displayName ??
    data?.usuario ??
    "";

  const cleanDbName = String(dbName ?? "").trim();
  if (cleanDbName) return cleanDbName;

  const authName = String(firebaseUser?.displayName ?? "").trim();
  if (authName) return authName;

  const authEmail = String(firebaseUser?.email ?? "").trim();
  if (authEmail) return authEmail.split("@")[0];

  return "Usuário";
}

function getMenuMeta(menu: MenuKey): { title: string; section: string } {
  switch (menu) {
    case "dashboard":
      return { title: "Dashboard", section: "Visão geral" };
    case "alertas":
      return { title: "Alertas Operacionais", section: "Central operacional" };
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
    case "anexos_pendentes":
      return { title: "Anexos Pendentes", section: "Operacional" };
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
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileName, setProfileName] = useState("");

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
  const [mobileSheet, setMobileSheet] = useState<null | "nova" | "mais">(null);

  const [createdBuraco, setCreatedBuraco] = useState<NotifItem[]>([]);
  const [createdAsfalto, setCreatedAsfalto] = useState<NotifItem[]>([]);
  const [createdHidrojato, setCreatedHidrojato] = useState<NotifItem[]>([]);
  const [concludedBuraco, setConcludedBuraco] = useState<NotifItem[]>([]);
  const [concludedAsfalto, setConcludedAsfalto] = useState<NotifItem[]>([]);
  const [concludedHidrojato, setConcludedHidrojato] = useState<NotifItem[]>([]);
  const [recentlyViewedNotifications, setRecentlyViewedNotifications] = useState<NotifItem[]>([]);
  const [notificationLastSeenMs, setNotificationLastSeenMs] = useState<number | null>(null);
  const [notificationStateLoaded, setNotificationStateLoaded] = useState(false);
  const [pendingAttachmentsCount, setPendingAttachmentsCount] = useState(0);

  // Marca d’água baseada em timestamps do Firestore (mitiga drift de relógio do cliente)
  const [, setServerNowMs] = useState<number>(Date.now());
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

  const visibleNotifications = notifications.length > 0 ? notifications : recentlyViewedNotifications;
  const unreadCount = notifications.length;

  const pageMeta = getMenuMeta(activeMenu);

  const userDisplayName =
    profileName ||
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

  useEffect(() => {
    if (!user) {
      setPendingAttachmentsCount(0);
      return;
    }

    const atualizarContador = () => {
      contarAnexosPendentes()
        .then(setPendingAttachmentsCount)
        .catch((error) => {
          console.error("Erro ao contar anexos pendentes:", error);
          setPendingAttachmentsCount(0);
        });
    };

    atualizarContador();
    const timer = window.setInterval(atualizarContador, 30_000);
    window.addEventListener("focus", atualizarContador);
    window.addEventListener("sanear-anexos-pendentes-change", atualizarContador);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", atualizarContador);
      window.removeEventListener("sanear-anexos-pendentes-change", atualizarContador);
    };
  }, [user]);

  const pendingAttachmentsBadge = pendingAttachmentsCount > 0
    ? pendingAttachmentsCount > 99 ? "99+" : pendingAttachmentsCount
    : undefined;

  type SidebarItemProps = {
    menu: MenuKey;
    icon: string;
    title: string;
    subtitle?: string;
    badge?: string | number;
    emphasis?: "normal" | "primary" | "warning";
  };

  type MobileNavButtonProps = {
    menu: MenuKey;
    icon: string;
    label: string;
    badge?: string | number;
  };

  function navigate(menu: MenuKey) {
    preloadPage(menu);
    setActiveMenu(menu);
    setMobileSheet(null);
    setNotifOpen(false);
    setUserMenuOpen(false);
  }

  function MobileNavButton({ menu, icon, label, badge }: MobileNavButtonProps) {
    const active = activeMenu === menu;

    return (
      <button
        type="button"
        className={`mobile-nav-btn ${active ? "active" : ""}`}
        onMouseEnter={() => preloadPage(menu)}
        onFocus={() => preloadPage(menu)}
        onClick={() => navigate(menu)}
        aria-label={label}
      >
        <span className="mobile-nav-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="mobile-nav-label">{label}</span>
        {badge !== undefined && badge !== null && badge !== "" && (
          <span className="mobile-nav-badge">{badge}</span>
        )}
      </button>
    );
  }

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
        onMouseEnter={() => preloadPage(menu)}
        onFocus={() => preloadPage(menu)}
        onClick={() => navigate(menu)}
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
      setProfileLoading(Boolean(firebaseUser));
      setAuthLoading(false);

      if (firebaseUser?.email) {
        setEmail(firebaseUser.email);
      }
    });

    return () => unsubscribe();
  }, []);

  // Perfil REAL do usuário: sempre vem do Firestore.
  // Não usa mais localStorage como fonte de permissão, porque isso deixava o topo
  // mostrando um perfil antigo até abrir a tela de Usuário ou forçar Ctrl+F5.
  useEffect(() => {
    if (!user) {
      setProfileLoading(false);
      setProfileName("");
      setSimulatedRole("operador");
      setNotificationLastSeenMs(null);
      setNotificationStateLoaded(false);
      setRecentlyViewedNotifications([]);
      return;
    }

    setProfileLoading(true);

    const userRef = doc(db, "usuarios_sistema", user.uid);

    const unsubscribe = onSnapshot(
      userRef,
      (snap) => {
        const data = snap.exists() ? (snap.data() as any) : null;

        const resolvedRole = resolveUserRole(data?.role);
        const resolvedName = resolveProfileName(data, user);

        setSimulatedRole(resolvedRole);
        setProfileName(resolvedName);

        // Mantém compatibilidade com telas antigas, mas a fonte oficial agora é o banco.
        localStorage.setItem("sanear-role", resolvedRole);
        localStorage.setItem("sanear-user-name", resolvedName);

        setProfileLoading(false);
      },
      (error) => {
        console.error("Erro ao carregar perfil de acesso do Firestore:", error);

        setSimulatedRole("operador");
        setProfileName(resolveProfileName(null, user));
        localStorage.setItem("sanear-role", "operador");
        setProfileLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user]);

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

  useEffect(() => {
    if (profileLoading) return;
    if (
      simulatedRole === "terceirizada" &&
      activeMenu !== "dashboard" &&
      activeMenu !== "terceirizada" &&
      activeMenu !== "anexos_pendentes"
    ) {
      setActiveMenu("terceirizada");
    }
  }, [profileLoading, simulatedRole, activeMenu]);

  // Fecha popovers ao clicar fora
useEffect(() => {
  if (!notifOpen && !userMenuOpen) return;
  const handler = () => {
    setNotifOpen(false);
    setRecentlyViewedNotifications([]);
    setUserMenuOpen(false);
  };
  window.addEventListener("click", handler);
  return () => window.removeEventListener("click", handler);
}, [notifOpen, userMenuOpen]);

  // Estado de leitura das notificações: salvo no Firestore por usuário.
  // Assim, quando o usuário abre as notificações em um computador,
  // o sino também fica limpo nos outros computadores após login/sincronização.
  useEffect(() => {
    if (!user) {
      setNotificationLastSeenMs(null);
      setNotificationStateLoaded(false);
      return;
    }

    setNotificationStateLoaded(false);

    const stateRef = doc(db, "notificacoes_usuario", user.uid);

    const unsubscribe = onSnapshot(
      stateRef,
      (snap) => {
        const data = snap.exists() ? (snap.data() as any) : null;
        const lastSeen =
          timestampToMillis(data?.ordensServicoVistasAte) ??
          timestampToMillis(data?.lastSeenAt) ??
          null;

        setNotificationLastSeenMs(lastSeen);
        setNotificationStateLoaded(true);
      },
      (err) => {
        console.error("Erro ao carregar estado de notificações:", err);
        setNotificationLastSeenMs(Date.now());
        setNotificationStateLoaded(true);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Primeiro acesso deste usuário/dispositivo: cria a marca de leitura para não
  // carregar todo o histórico antigo como notificação nova.
  useEffect(() => {
    if (!user || !notificationStateLoaded || notificationLastSeenMs !== null) return;

    const stateRef = doc(db, "notificacoes_usuario", user.uid);
    const now = serverTimestamp();

    setNotificationLastSeenMs(Date.now());

    setDoc(
      stateRef,
      {
        userId: user.uid,
        ordensServicoVistasAte: now,
        lastSeenAt: now,
        updatedAt: now,
      },
      { merge: true }
    ).catch((err) => {
      console.error("Erro ao inicializar estado de notificações:", err);
    });
  }, [user, notificationStateLoaded, notificationLastSeenMs]);

  // Listener de novas OS (criadas) e OS concluídas (dataExecucao)
  useEffect(() => {
    if (!user || !notificationStateLoaded || !notificationLastSeenMs) {
      setCreatedBuraco([]);
      setCreatedAsfalto([]);
      setCreatedHidrojato([]);
      setConcludedBuraco([]);
      setConcludedAsfalto([]);
      setConcludedHidrojato([]);
      return;
    }

    const lastSeenTs = Timestamp.fromMillis(notificationLastSeenMs);

    const buildCreatedNotifs = (
      colName: "ordens_servico" | "ordensServico" | "ordensHidrojato",
      fallbackOrigem: "Calçamento" | "Asfalto" | "Hidrojato",
      snap: any
    ) => {
      const items: NotifItem[] = snap.docs
        .map((d: any) => {
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
            message: `Nova OS de ${origemLabel} criada: OS ${numero}.`,
          };
        })
        .filter((n: NotifItem) => n.tsMillis > notificationLastSeenMs);

      return items;
    };

    const buildConcludedNotifs = (
      colName: "ordens_servico" | "ordensServico" | "ordensHidrojato",
      fallbackOrigem: "Calçamento" | "Asfalto" | "Hidrojato",
      snap: any
    ) => {
      const items: NotifItem[] = snap.docs
        .map((d: any) => {
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
            message: `OS ${numero} concluída (${origemLabel}).`,
          };
        })
        .filter((n: NotifItem) => n.tsMillis > notificationLastSeenMs);

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
  }, [user, notificationStateLoaded, notificationLastSeenMs]);

  async function saveNotificationsAsSeen() {
    if (!user) return;

    const stateRef = doc(db, "notificacoes_usuario", user.uid);
    const now = serverTimestamp();

    await setDoc(
      stateRef,
      {
        userId: user.uid,
        ordensServicoVistasAte: now,
        lastSeenAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
  }

  function clearNotificationFeed() {
    setCreatedBuraco([]);
    setCreatedAsfalto([]);
    setCreatedHidrojato([]);
    setConcludedBuraco([]);
    setConcludedAsfalto([]);
    setConcludedHidrojato([]);
  }

  function markAllAsSeen(options?: { closePopover?: boolean; keepCurrentListVisible?: boolean }) {
    if (!user) return;

    if (options?.keepCurrentListVisible && notifications.length > 0) {
      setRecentlyViewedNotifications(notifications);
    } else if (!options?.keepCurrentListVisible) {
      setRecentlyViewedNotifications([]);
    }

    // Atualiza a tela imediatamente. O Firestore confirma em seguida e sincroniza outros PCs.
    setNotificationLastSeenMs(Date.now());
    clearNotificationFeed();

    saveNotificationsAsSeen().catch((err) => {
      console.error("Erro ao marcar notificações como vistas:", err);
    });

    if (options?.closePopover !== false) {
      setNotifOpen(false);
    }
  }

  function toggleNotifications() {
    const willOpen = !notifOpen;

    setUserMenuOpen(false);
    setNotifOpen(willOpen);

    if (!willOpen) {
      setRecentlyViewedNotifications([]);
      return;
    }

    if (notifications.length > 0) {
      markAllAsSeen({ closePopover: false, keepCurrentListVisible: true });
    }
  }

  function openNotification(n: NotifItem) {
    // manda abrir na Lista + detalhes da OS
    window.sessionStorage.setItem(
      "sanear-open-os",
      JSON.stringify({ id: n.osId, col: n.collectionName })
    );

    setRecentlyViewedNotifications([]);
    setNotifOpen(false);
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
      setProfileLoading(true);
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
        window.localStorage.removeItem("sanear-role");
        window.localStorage.removeItem("sanear-user-name");
      }
    } catch (error) {
      console.error(error);
    }
  }

  function renderActivePage() {
    if (
      simulatedRole === "terceirizada" &&
      activeMenu !== "dashboard" &&
      activeMenu !== "terceirizada" &&
      activeMenu !== "anexos_pendentes"
    ) {
      return <TerceirizadaVisao />;
    }

    switch (activeMenu) {
      case "dashboard":
        return <Dashboard perfilUsuario={simulatedRole} />;
      case "alertas":
        return <AlertasOperacionais />;
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
      case "anexos_pendentes":
        return <AnexosPendentes />;
      case "backup":
        return <Backup />;
      default:
        return <Dashboard />;
    }
  }

  function renderContent() {
    if (profileLoading) {
      return (
        <section className="page-card">
          <div className="empty-state">
            <h2>Carregando perfil de acesso...</h2>
            <p>Consultando o nível de acesso gravado no banco de dados.</p>
          </div>
        </section>
      );
    }

    return (
      <Suspense fallback={<PageLoadingFallback title={pageMeta.title} />}>
        {renderActivePage()}
      </Suspense>
    );
  }

  if (authLoading || (user && profileLoading)) {
    return (
      <>
        <UpdatePwaNotice />
        <div className="login-page">
        <div className="login-left">
          <div className="login-box">
            <h1 className="login-title">Sanear Operacional</h1>
            <p>{authLoading ? "Carregando..." : "Carregando perfil de acesso..."}</p>
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
      </>
    );
  }

  if (!user) {
    return (
      <>
        <UpdatePwaNotice />
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
      <UpdatePwaNotice />
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
                  menu="alertas"
                  icon="🚨"
                  title="Alertas"
                  subtitle="Pendências críticas"
                  emphasis="warning"
                />
              )}
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
                  subtitle="Buraco na rua"
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
                  title="Área de Serviço SANEAR"
                  subtitle="Finalizar hidrojato"
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
              <SidebarItem
                menu="anexos_pendentes"
                icon="📎"
                title="Anexos Pendentes"
                subtitle="Reenvio local"
                badge={pendingAttachmentsBadge}
                emphasis="warning"
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
          onClick={toggleNotifications}
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

              <button
                type="button"
                className="notif2-clear"
                onClick={() => markAllAsSeen({ closePopover: true })}
              >
                Marcar tudo como visto
              </button>
            </div>

            {visibleNotifications.length === 0 ? (
              <div className="notif2-empty">Nenhuma notificação nova.</div>
            ) : (
              <div className="notif2-list">
                {visibleNotifications.map((n) => (
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
            <span className="user2-role">{roleLabel}</span>
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
                Perfil: {roleLabel}
              </div>
            </div>

            <div className="user2-popover-actions">
              <button
                type="button"
                className="user2-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  navigate("usuario");
                }}
              >
                👤 Perfil &amp; Acesso
              </button>

              <button
                type="button"
                className="user2-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  navigate("anexos_pendentes");
                }}
              >
                📎 Anexos Pendentes{pendingAttachmentsCount > 0 ? ` (${pendingAttachmentsCount})` : ""}
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

      <nav className="mobile-bottom-nav" aria-label="Navegação principal no celular">
        {isTerceirizada ? (
          <>
            <MobileNavButton
              menu="dashboard"
              icon="📊"
              label="Painel"
              badge={unreadCount > 0 ? unreadCount > 99 ? "99+" : unreadCount : undefined}
            />
            <MobileNavButton menu="terceirizada" icon="🤝" label="Área" />
            <MobileNavButton
              menu="anexos_pendentes"
              icon="📎"
              label="Anexos"
              badge={pendingAttachmentsBadge}
            />
            <button
              type="button"
              className="mobile-nav-btn"
              onClick={() => {
                setNotifOpen((current) => !current);
                setUserMenuOpen(false);
                setMobileSheet(null);
              }}
              aria-label="Notificações"
            >
              <span className="mobile-nav-icon" aria-hidden="true">🔔</span>
              <span className="mobile-nav-label">Avisos</span>
              {unreadCount > 0 && (
                <span className="mobile-nav-badge">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="mobile-nav-btn"
              onClick={handleLogout}
              aria-label="Sair"
            >
              <span className="mobile-nav-icon" aria-hidden="true">🚪</span>
              <span className="mobile-nav-label">Sair</span>
            </button>
          </>
        ) : (
          <>
            <MobileNavButton
              menu="dashboard"
              icon="📊"
              label="Painel"
              badge={unreadCount > 0 ? unreadCount > 99 ? "99+" : unreadCount : undefined}
            />
            <MobileNavButton menu="listaOS" icon="📋" label="OS" />
            <button
              type="button"
              className={`mobile-nav-fab ${mobileSheet === "nova" ? "active" : ""}`}
              onClick={() => {
                setNotifOpen(false);
                setUserMenuOpen(false);
                setMobileSheet((current) => (current === "nova" ? null : "nova"));
              }}
              aria-label="Abrir nova ordem de serviço"
            >
              <span aria-hidden="true">＋</span>
              <strong>Nova</strong>
            </button>
            <MobileNavButton menu="servico_sanear" icon="🛠️" label="SANEAR" />
            <button
              type="button"
              className={`mobile-nav-btn ${mobileSheet === "mais" ? "active" : ""}`}
              onClick={() => {
                setNotifOpen(false);
                setUserMenuOpen(false);
                setMobileSheet((current) => (current === "mais" ? null : "mais"));
              }}
              aria-label="Mais opções"
            >
              <span className="mobile-nav-icon" aria-hidden="true">☰</span>
              <span className="mobile-nav-label">Mais</span>
            </button>
          </>
        )}
      </nav>

      {mobileSheet && !isTerceirizada && (
        <div className="mobile-sheet-backdrop" onClick={() => setMobileSheet(null)}>
          <section
            className="mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={mobileSheet === "nova" ? "Nova ordem de serviço" : "Mais opções"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-sheet-handle" aria-hidden="true" />
            <div className="mobile-sheet-header">
              <div>
                <span className="mobile-sheet-eyebrow">SANEAR Operacional</span>
                <h2>{mobileSheet === "nova" ? "Abrir nova OS" : "Menu rápido"}</h2>
              </div>
              <button
                type="button"
                className="mobile-sheet-close"
                onClick={() => setMobileSheet(null)}
                aria-label="Fechar menu"
              >
                ×
              </button>
            </div>

            {mobileSheet === "nova" ? (
              <div className="mobile-sheet-grid mobile-sheet-grid-services">
                <button type="button" className="mobile-sheet-card" onClick={() => navigate("buraco")}>
                  <span>🧱</span>
                  <strong>Calçamento</strong>
                  <small>Buraco na rua</small>
                </button>
                <button type="button" className="mobile-sheet-card" onClick={() => navigate("asfalto")}>
                  <span>🛣️</span>
                  <strong>Asfalto</strong>
                  <small>Reparo e tapa-buraco</small>
                </button>
                <button type="button" className="mobile-sheet-card mobile-sheet-card-featured" onClick={() => navigate("hidrojato")}>
                  <span>🚛</span>
                  <strong>Hidrojato</strong>
                  <small>Serviço interno SANEAR</small>
                </button>
                <button type="button" className="mobile-sheet-card" onClick={() => navigate("esgoto_entupido")}>
                  <span>🚧</span>
                  <strong>Esgoto entupido</strong>
                  <small>Rede obstruída</small>
                </button>
                <button type="button" className="mobile-sheet-card" onClick={() => navigate("esgoto_retornando")}>
                  <span>💧</span>
                  <strong>Esgoto retornando</strong>
                  <small>Retorno no imóvel</small>
                </button>
              </div>
            ) : (
              <div className="mobile-sheet-list">
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("dashboard")}>
                  <span>📊</span>
                  <strong>Dashboard</strong>
                  <small>Visão geral da operação</small>
                </button>
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("listaOS")}>
                  <span>📋</span>
                  <strong>Lista de OS</strong>
                  <small>Consultar, abrir PDF e acompanhar</small>
                </button>
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("alertas")}>
                  <span>🚨</span>
                  <strong>Alertas Operacionais</strong>
                  <small>SLA, SANEAR, anexos e reaberturas</small>
                </button>
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("terceirizada")}>
                  <span>🤝</span>
                  <strong>Área da Terceirizada</strong>
                  <small>Serviços externos</small>
                </button>
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("anexos_pendentes")}>
                  <span>📎</span>
                  <strong>Anexos Pendentes</strong>
                  <small>Reenvio de PDFs e fotos locais</small>
                </button>
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("usuario")}>
                  <span>👤</span>
                  <strong>Usuário</strong>
                  <small>Perfil e nível de acesso</small>
                </button>
                <button type="button" className="mobile-sheet-row" onClick={() => navigate("backup")}>
                  <span>🗄️</span>
                  <strong>Backup</strong>
                  <small>Exportação segura dos dados</small>
                </button>
                <button type="button" className="mobile-sheet-row mobile-sheet-row-danger" onClick={handleLogout}>
                  <span>🚪</span>
                  <strong>Sair</strong>
                  <small>Encerrar sessão neste aparelho</small>
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default App;
