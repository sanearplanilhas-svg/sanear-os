import React, { useEffect, useState } from "react";
import type { FormEvent, ChangeEvent } from "react";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateProfile,
  sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";

type Role = "diretor" | "operador" | "terceirizada" | "adm";

type StatusType = "success" | "error" | "info";

type ManagedUser = {
  id: string;
  uid: string;
  nome: string;
  email: string;
  role: Role;
  createdAt?: Timestamp | null;
};

const ROLE_LABEL: Record<Role, string> = {
  diretor: "Diretor",
  operador: "Operador",
  terceirizada: "Terceirizada",
  adm: "Administrador",
};

// CSS simples para a tabela de "Usuários cadastrados"
const userTableCss = /* css */ `
  .user-table {
    width: 100%;
    border-radius: 0.75rem;
    border: 1px solid #e5e7eb;
    background-color: #ffffff;
    overflow: hidden;
    font-size: 0.875rem;
  }

  .user-table-header,
  .user-table-row {
    display: grid;
    grid-template-columns: 2fr 2fr 1.5fr 1.7fr 1.7fr;
    align-items: center;
    padding: 0.5rem 0.75rem;
    column-gap: 0.75rem;
  }

  .user-table-header {
    background-color: #f9fafb;
    font-weight: 500;
    color: #4b5563;
    border-bottom: 1px solid #e5e7eb;
  }

  .user-table-row {
    border-bottom: 1px solid #f3f4f6;
  }

  .user-table-row:nth-child(even) {
    background-color: #f9fafb;
  }

  .user-table-row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-table-row select {
    width: 100%;
    padding: 0.25rem 0.35rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background-color: #ffffff;
    font-size: 0.8rem;
  }

  .user-table-row button.btn-secondary {
    font-size: 0.75rem;
    padding: 0.25rem 0.65rem;
    white-space: nowrap;
  }

  @media (max-width: 900px) {
    .user-table-header,
    .user-table-row {
      grid-template-columns: 1.5fr 2fr 1.2fr 1.5fr 1.6fr;
      font-size: 0.8rem;
    }
  }

  @media (max-width: 700px) {
    .user-table-header,
    .user-table-row {
      grid-template-columns: 1.8fr 2fr 1.5fr;
      row-gap: 0.25rem;
    }

    .user-table-header span:nth-child(4),
    .user-table-header span:nth-child(5),
    .user-table-row span:nth-child(4),
    .user-table-row span:nth-child(5) {
      display: none;
    }
  }
`;

const Usuario: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"perfil" | "usuarios">("perfil");

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");

  // Perfil REAL (do Firestore)
  const [role, setRole] = useState<Role>("operador");
  const isAdmin = role === "adm";

  // Override de admin via senha mestra
  const [adminOverride, setAdminOverride] = useState(false);
  const canManageUsers = isAdmin || adminOverride;

  // Fonte
  const [fontScale, setFontScale] = useState<number>(1);

  // Estado geral
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);

  // Modal de senha (minha senha)
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Mensagens
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");

  // Modal de permissão negada / senha mestra
  const [permissionModalOpen, setPermissionModalOpen] = useState(false);
  const [permissionModalMessage, setPermissionModalMessage] = useState("");
  const [permissionModalRequirePassword, setPermissionModalRequirePassword] =
    useState(false);
  const [overridePassword, setOverridePassword] = useState("");
  const [overrideError, setOverrideError] = useState("");
  const [pendingAdminAction, setPendingAdminAction] = useState<
    (() => void) | null
  >(null);

  // Gerenciamento de usuários (aba "Usuários")
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [creatingUser, setCreatingUser] = useState(false);
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);

  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserConfirm, setNewUserConfirm] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>("operador");

  // Helpers de status
  function setStatus(message: string, type: StatusType = "info") {
    setStatusMessage(message);
    setStatusType(type);
  }

  /**
   * Abre o modal de permissão.
   * - requirePassword = true → mostra campo de senha e permite override
   * - requirePassword = false → apenas aviso
   * - onSuccess → ação a ser executada após senha correta
   */
  function openPermissionModal(
    message: string,
    requirePassword = false,
    onSuccess?: () => void
  ) {
    setPermissionModalMessage(message);
    setPermissionModalRequirePassword(requirePassword);
    setPermissionModalOpen(true);
    setOverridePassword("");
    setOverrideError("");

    if (requirePassword && onSuccess) {
      setPendingAdminAction(() => onSuccess);
    } else {
      setPendingAdminAction(null);
    }
  }

  function closePermissionModal() {
    setPermissionModalOpen(false);
    setOverridePassword("");
    setOverrideError("");
    setPermissionModalRequirePassword(false);
    setPendingAdminAction(null);
  }

  function handlePermissionPasswordSubmit(e: FormEvent) {
    e.preventDefault();

    if (!permissionModalRequirePassword) {
      closePermissionModal();
      return;
    }

    if (overridePassword === "29101993jps") {
      // Libera override nesta tela
      setAdminOverride(true);
      const action = pendingAdminAction;
      closePermissionModal();
      if (action) {
        action();
      }
    } else {
      setOverrideError("Senha incorreta. Tente novamente.");
    }
  }

  // Carregar dados do usuário + role (Firestore) + fonte
  useEffect(() => {
    async function loadUserAndPrefs() {
      try {
        const user = auth.currentUser;

        if (user) {
          setDisplayName(user.displayName || "");
          setEmail(user.email || "");

          let resolvedRole: Role = "operador";

          try {
            const userRef = doc(db, "usuarios_sistema", user.uid);
            const snap = await getDoc(userRef);

            if (snap.exists()) {
              const data = snap.data() as any;
              const dbRole = data.role as Role | undefined;

              if (
                dbRole === "diretor" ||
                dbRole === "operador" ||
                dbRole === "terceirizada" ||
                dbRole === "adm"
              ) {
                resolvedRole = dbRole;
              }
            } else {
              const storedRole = localStorage.getItem(
                "sanear-role"
              ) as Role | null;
              if (
                storedRole === "diretor" ||
                storedRole === "operador" ||
                storedRole === "terceirizada" ||
                storedRole === "adm"
              ) {
                resolvedRole = storedRole;
              }
            }
          } catch (err) {
            console.error("Erro ao carregar perfil do usuário:", err);
            const storedRole = localStorage.getItem(
              "sanear-role"
            ) as Role | null;
            if (
              storedRole === "diretor" ||
              storedRole === "operador" ||
              storedRole === "terceirizada" ||
              storedRole === "adm"
            ) {
              resolvedRole = storedRole;
            }
          }

          setRole(resolvedRole);
          // mantém compat com outras telas
          localStorage.setItem("sanear-role", resolvedRole);
        }

        // Fonte
        const storedScale = localStorage.getItem("sanear-font-scale");
        const initialScale = storedScale ? parseFloat(storedScale) : 1;
        if (!isNaN(initialScale) && initialScale > 0) {
          setFontScale(initialScale);
          document.documentElement.style.fontSize = `${initialScale * 100}%`;
        }
      } finally {
        setLoading(false);
      }
    }

    loadUserAndPrefs();
  }, []);

  // Carregar lista de usuários do Firestore (coleção usuarios_sistema)
  useEffect(() => {
    const q = query(
      collection(db, "usuarios_sistema"),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: ManagedUser[] = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            uid: data.uid || d.id,
            nome: data.nome || "",
            email: data.email || "",
            role: (data.role as Role) || "operador",
            createdAt: data.createdAt || null,
          };
        });
        setManagedUsers(list);
      },
      (err) => {
        console.error(err);
        setStatus(
          "Não foi possível carregar a lista de usuários. Verifique a conexão.",
          "error"
        );
      }
    );

    return () => unsub();
  }, []);

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    const user = auth.currentUser;

    if (!user) {
      setStatus("Nenhum usuário autenticado. Faça login novamente.", "error");
      return;
    }

    try {
      setSavingProfile(true);

      if (displayName.trim().length > 0) {
        await updateProfile(user, { displayName: displayName.trim() });
      }

      setStatus("Dados atualizados com sucesso.", "success");
    } catch (error) {
      console.error(error);
      setStatus(
        "Não foi possível salvar seus dados. Verifique a conexão e tente novamente.",
        "error"
      );
    } finally {
      setSavingProfile(false);
    }
  }

  function handleFontScaleChange(e: ChangeEvent<HTMLInputElement>) {
    const percent = Number(e.target.value); // 90 a 120
    const scale = percent / 100;
    setFontScale(scale);
    localStorage.setItem("sanear-font-scale", String(scale));
    document.documentElement.style.fontSize = `${scale * 100}%`;
  }

  function handleOpenPasswordModal() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setStatusMessage(null);
    setShowPasswordModal(true);
  }

  function handleClosePasswordModal() {
    setShowPasswordModal(false);
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    const user = auth.currentUser;

    if (!user || !user.email) {
      setStatus(
        "Não foi possível identificar o usuário. Faça login novamente.",
        "error"
      );
      return;
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      setStatus("Preencha todos os campos de senha.", "error");
      return;
    }

    if (newPassword.length < 6) {
      setStatus("A nova senha deve ter pelo menos 6 caracteres.", "error");
      return;
    }

    if (newPassword !== confirmPassword) {
      setStatus("A confirmação da nova senha não confere.", "error");
      return;
    }

    try {
      const cred = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPassword);

      setStatus("Senha alterada com sucesso.", "success");
      setShowPasswordModal(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: any) {
      console.error(error);
      let msg =
        "Não foi possível alterar a senha. Verifique os dados e tente novamente.";
      if (error?.code === "auth/wrong-password") {
        msg = "Senha atual incorreta.";
      }
      setStatus(msg, "error");
    }
  }

  function handleTabClick(tab: "perfil" | "usuarios") {
    if (tab === "usuarios" && !canManageUsers) {
      openPermissionModal(
        "Apenas o perfil Administrador pode acessar o gerenciamento de usuários.",
        true,
        () => setActiveTab("usuarios")
      );
      return;
    }
    setActiveTab(tab);
  }

  function renderPermissions(currentRole: Role) {
    if (currentRole === "adm") {
      return (
        <ul className="permissions-list">
          <li>✅ Pode acessar todas as áreas do sistema.</li>
          <li>✅ Pode cadastrar ordens de serviço (Buraco, Asfalto, etc.).</li>
          <li>✅ Pode visualizar o dashboard e relatórios.</li>
          <li>
            ✅ Pode acessar a visão da terceirizada e marcar serviço executado.
          </li>
          <li>✅ Pode cadastrar novos usuários com login e senha.</li>
          <li>✅ Pode disparar redefinição de senha para qualquer usuário.</li>
        </ul>
      );
    }

    if (currentRole === "diretor") {
      return (
        <ul className="permissions-list">
          <li>✅ Pode acessar todas as áreas do sistema.</li>
          <li>✅ Pode cadastrar ordens de serviço (Buraco, Asfalto, etc.).</li>
          <li>✅ Pode visualizar o dashboard e relatórios.</li>
          <li>✅ Pode acessar a visão da terceirizada.</li>
          <li>⛔ Cadastro de novos usuários apenas com Administrador.</li>
          <li>⛔ Redefinição direta de senha de outros usuários.</li>
        </ul>
      );
    }

    if (currentRole === "operador") {
      return (
        <ul className="permissions-list">
          <li>✅ Pode cadastrar ordens de serviço em todos os menus operacionais.</li>
          <li>✅ Pode visualizar o dashboard, listagens e relatórios.</li>
          <li>
            ✅ Pode acompanhar a visão da terceirizada{" "}
            <strong>(somente leitura)</strong>.
          </li>
          <li>⛔ Não pode marcar serviço executado na área da terceirizada.</li>
          <li>⛔ Não pode cadastrar novos usuários.</li>
        </ul>
      );
    }

    // terceirizada
    return (
      <ul className="permissions-list">
        <li>
          ✅ Acessa apenas a área <strong>Terceirizada</strong>.
        </li>
        <li>✅ Pode visualizar as ordens de serviço liberadas para execução.</li>
        <li>✅ Pode anexar fotos do serviço executado e imprimir a OS.</li>
        <li>
          ✅ Pode marcar a OS como <strong>serviço executado (concluída)</strong>.
        </li>
        <li>⛔ Não cadastra novas ordens de serviço.</li>
        <li>⛔ Não acessa a área de configuração de usuários.</li>
      </ul>
    );
  }

  // ===== Helpers de ações "admin" =====

  async function createUserFromState() {
    if (
      !newUserName.trim() ||
      !newUserEmail.trim() ||
      !newUserPassword ||
      !newUserConfirm
    ) {
      setStatus("Preencha todos os campos do novo usuário.", "error");
      return;
    }

    if (newUserPassword.length < 6) {
      setStatus(
        "A senha do novo usuário deve ter pelo menos 6 caracteres.",
        "error"
      );
      return;
    }

    if (newUserPassword !== newUserConfirm) {
      setStatus("A confirmação da senha do novo usuário não confere.", "error");
      return;
    }

    const apiKey =
      ((auth.app?.options as any)?.apiKey as string | undefined) ||
      import.meta.env.VITE_FIREBASE_API_KEY;

    if (!apiKey) {
      setStatus(
        "Chave de API do Firebase não encontrada. Verifique o arquivo .env (VITE_FIREBASE_API_KEY) ou a configuração do firebaseClient.",
        "error"
      );
      return;
    }

    try {
      setCreatingUser(true);

      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: newUserEmail.trim().toLowerCase(),
            password: newUserPassword,
            returnSecureToken: false,
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (data?.error?.message === "EMAIL_EXISTS") {
          throw new Error("Já existe um usuário cadastrado com este e-mail.");
        }
        throw new Error("Não foi possível criar o usuário. Tente novamente.");
      }

      const uid: string | undefined = data.localId || data.uid;
      if (!uid) {
        throw new Error("Não foi possível obter o ID do usuário criado.");
      }

      await setDoc(doc(collection(db, "usuarios_sistema"), uid), {
        uid,
        nome: newUserName.trim(),
        email: newUserEmail.trim().toLowerCase(),
        role: newUserRole,
        createdAt: serverTimestamp(),
        createdBy: auth.currentUser?.uid || null,
      });

      setStatus("Usuário cadastrado com sucesso.", "success");
      setNewUserName("");
      setNewUserEmail("");
      setNewUserPassword("");
      setNewUserConfirm("");
      setNewUserRole("operador");
    } catch (error: any) {
      console.error(error);
      setStatus(
        error?.message ||
          "Erro ao criar o usuário. Verifique os dados e tente novamente.",
        "error"
      );
    } finally {
      setCreatingUser(false);
    }
  }

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();

    if (!canManageUsers) {
      openPermissionModal(
        "Apenas o perfil Administrador pode cadastrar novos usuários.",
        true,
        () => {
          void createUserFromState();
        }
      );
      return;
    }

    await createUserFromState();
  }

  async function updateManagedUserRole(user: ManagedUser, newRole: Role) {
    try {
      await updateDoc(doc(db, "usuarios_sistema", user.id), {
        role: newRole,
      });

      setStatus(
        `Perfil de acesso de ${user.nome || user.email} atualizado para ${
          ROLE_LABEL[newRole]
        }.`,
        "success"
      );
    } catch (error) {
      console.error(error);
      setStatus(
        "Não foi possível atualizar o perfil de acesso. Tente novamente.",
        "error"
      );
    }
  }

  // ADM muda o perfil de um usuário já cadastrado (Lista de usuários)
  async function handleChangeManagedUserRole(
    user: ManagedUser,
    newRole: Role
  ) {
    if (!canManageUsers) {
      openPermissionModal(
        "Apenas o perfil Administrador pode alterar o perfil de acesso dos usuários.",
        true,
        () => {
          void updateManagedUserRole(user, newRole);
        }
      );
      return;
    }

    if (user.uid === auth.currentUser?.uid) {
      // Aqui mantemos apenas aviso (sem override) para evitar auto-mudança via lista
      openPermissionModal(
        "Seu próprio perfil deve ser alterado pela aba Meu perfil.",
        false
      );
      return;
    }

    await updateManagedUserRole(user, newRole);
  }

  async function sendResetEmail(user: ManagedUser) {
    if (!user.email) {
      setStatus("Usuário sem e-mail cadastrado.", "error");
      return;
    }

    try {
      setResettingUserId(user.id);
      await sendPasswordResetEmail(auth, user.email);
      setStatus(
        `E-mail de redefinição de senha enviado para ${user.email}.`,
        "success"
      );
    } catch (error) {
      console.error(error);
      setStatus(
        "Não foi possível enviar o e-mail de redefinição. Verifique o e-mail e tente novamente.",
        "error"
      );
    } finally {
      setResettingUserId(null);
    }
  }

  // Adm envia e-mail de redefinição de senha para qualquer usuário
  async function handleSendResetEmail(user: ManagedUser) {
    if (!canManageUsers) {
      openPermissionModal(
        "Apenas o perfil Administrador pode redefinir senhas de outros usuários.",
        true,
        () => {
          void sendResetEmail(user);
        }
      );
      return;
    }

    await sendResetEmail(user);
  }

  // ===== Alterar o próprio perfil (aba Meu perfil) =====

  async function updateOwnRole(newRole: Role) {
    const user = auth.currentUser;
    if (!user) {
      setStatus("Nenhum usuário autenticado. Faça login novamente.", "error");
      return;
    }

    try {
      await setDoc(
        doc(db, "usuarios_sistema", user.uid),
        {
          uid: user.uid,
          email: user.email || null,
          role: newRole,
          // não mexe em createdAt aqui, só role
        },
        { merge: true }
      );

      setRole(newRole);
      localStorage.setItem("sanear-role", newRole);
      setStatus(
        `Seu perfil de acesso foi alterado para ${ROLE_LABEL[newRole]}.`,
        "success"
      );
    } catch (error) {
      console.error(error);
      setStatus(
        "Não foi possível alterar seu perfil de acesso. Tente novamente.",
        "error"
      );
    }
  }

  function handleChangeOwnRole(newRole: Role) {
    // Admin já pode sem senha (regra original)
    if (!canManageUsers) {
      openPermissionModal(
        "Apenas o perfil Administrador pode alterar o perfil de acesso. Digite a senha de administrador para continuar.",
        true,
        () => {
          void updateOwnRole(newRole);
        }
      );
      return;
    }

    void updateOwnRole(newRole);
  }

  if (loading) {
    return (
      <section className="page-card">
        <header className="page-header">
          <h2>Usuário</h2>
        </header>
        <p>Carregando dados do usuário...</p>
      </section>
    );
  }

  return (
    <section className="page-card">
      {/* CSS da tabela injetado neste componente */}
      <style>{userTableCss}</style>

      <header className="page-header">
        <div>
          <h2>Configurações do usuário</h2>
          <p>
            Atualize seus dados, perfil de acesso, senha e gerencie usuários
            (quando permitido).
          </p>
        </div>
      </header>

      {/* Tabs internas */}
      <div className="page-tabs">
        <button
          type="button"
          className={`page-tab ${activeTab === "perfil" ? "is-active" : ""}`}
          onClick={() => handleTabClick("perfil")}
        >
          Meu perfil
        </button>
        <button
          type="button"
          className={`page-tab ${
            activeTab === "usuarios" ? "is-active" : ""
          }`}
          onClick={() => handleTabClick("usuarios")}
        >
          Usuários
        </button>
      </div>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>
          {statusMessage}
        </div>
      )}

      {activeTab === "perfil" && (
        <form className="page-form" onSubmit={handleSaveProfile}>
          {/* Dados básicos */}
          <div className="page-section">
            <h3>Dados básicos</h3>
            <p className="page-section-description">
              Informações principais usadas para identificação dentro do sistema.
            </p>

            <div className="page-form-grid">
              <div className="page-field">
                <label>Seu nome</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Como deseja ser chamado"
                />
              </div>

              <div className="page-field">
                <label>E-mail de acesso</label>
                <input
                  type="email"
                  value={email}
                  readOnly
                  className="field-readonly"
                />
              </div>
            </div>
          </div>

          {/* Perfil de acesso - card bonito */}
          <div className="page-section">
            <h3>Perfil de acesso</h3>
            <p className="page-section-description">
              Este é o perfil associado ao seu usuário dentro do Sanear
              Operacional.
            </p>

            <div className="page-field">
              <label>Seu perfil de acesso</label>

              <button
                type="button"
                className={`role-display-card role-${role}`}
                onClick={() =>
                  openPermissionModal(
                    isAdmin
                      ? "Você é Administrador. Para alterar perfis de outros usuários, use a aba Usuários. Seu próprio perfil pode ser alterado abaixo, com senha."
                      : "Seu perfil de acesso é definido pelo Administrador. Você pode solicitar alteração via senha de administrador abaixo."
                  )
                }
              >
                <div className="role-display-left">
                  <span className="role-display-icon">👤</span>

                  <div className="role-display-text">
                    <span className="role-display-title">
                      {ROLE_LABEL[role]}
                    </span>
                    <span className="role-display-subtitle">
                      Perfil definido pelo Administrador
                    </span>
                  </div>
                </div>

                <span className="role-display-chip">Ver detalhes</span>
              </button>
            </div>

            {/* Novo: alterar o próprio perfil com senha */}
            <div className="page-field">
              <label>Alterar meu perfil de acesso</label>
              <select
                value={role}
                onChange={(e) =>
                  handleChangeOwnRole(e.target.value as Role)
                }
              >
                <option value="diretor">Diretor</option>
                <option value="operador">Operador</option>
                <option value="terceirizada">Terceirizada</option>
                <option value="adm">Administrador</option>
              </select>
              <p className="field-hint">
                Para alterar seu perfil, será exigida a senha de administrador
                quando você não for Administrador.
              </p>
            </div>

            <div className="permissions-box">
              <h4>O que este perfil pode fazer</h4>
              {renderPermissions(role)}
            </div>
          </div>

          {/* Fonte do sistema */}
          <div className="page-section">
            <h3>Tamanho da fonte do sistema</h3>
            <p className="page-section-description">
              Ajuste o tamanho dos textos da interface para melhorar a leitura.
            </p>

            <div className="page-field">
              <label>
                Tamanho atual: <strong>{Math.round(fontScale * 100)}%</strong>
              </label>
              <input
                type="range"
                min={90}
                max={120}
                step={5}
                value={Math.round(fontScale * 100)}
                onChange={handleFontScaleChange}
              />
              <div className="font-scale-labels">
                <span>Menor</span>
                <span>Padrão</span>
                <span>Maior</span>
              </div>
            </div>
          </div>

          {/* Senha */}
          <div className="page-section">
            <h3>Senha e segurança</h3>
            <p className="page-section-description">
              Para trocar a sua senha, você precisará informar a senha atual e a
              nova senha.
            </p>

            <div className="page-field">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleOpenPasswordModal}
              >
                Alterar minha senha
              </button>
            </div>
          </div>

          <div className="page-actions">
            <button
              type="submit"
              className="btn-primary"
              disabled={savingProfile}
            >
              {savingProfile ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>
        </form>
      )}

      {activeTab === "usuarios" && (
        <div className="page-form">
          {!canManageUsers ? (
            <div className="page-section">
              <h3>Acesso restrito</h3>
              <p className="page-section-description">
                Somente usuários com perfil{" "}
                <strong>Administrador (ou senha de administrador)</strong> podem
                cadastrar e gerenciar usuários.
              </p>
            </div>
          ) : (
            <>
              {/* Cadastro de novo usuário */}
              <div className="page-section">
                <h3>Cadastrar novo usuário</h3>
                <p className="page-section-description">
                  Crie usuários com e-mail e senha para acessar o Sanear
                  Operacional.
                </p>

                <form onSubmit={handleCreateUser}>
                  <div className="page-form-grid">
                    <div className="page-field">
                      <label>Nome</label>
                      <input
                        type="text"
                        value={newUserName}
                        onChange={(e) => setNewUserName(e.target.value)}
                        placeholder="Nome do usuário"
                      />
                    </div>

                    <div className="page-field">
                      <label>E-mail</label>
                      <input
                        type="email"
                        value={newUserEmail}
                        onChange={(e) => setNewUserEmail(e.target.value)}
                        placeholder="email@exemplo.com"
                      />
                    </div>

                    <div className="page-field">
                      <label>Perfil de acesso</label>
                      <select
                        value={newUserRole}
                        onChange={(e) =>
                          setNewUserRole(e.target.value as Role)
                        }
                      >
                        <option value="diretor">Diretor</option>
                        <option value="operador">Operador</option>
                        <option value="terceirizada">Terceirizada</option>
                        <option value="adm">Administrador</option>
                      </select>
                    </div>
                  </div>

                  <div className="page-form-grid">
                    <div className="page-field">
                      <label>Senha inicial</label>
                      <input
                        type="password"
                        value={newUserPassword}
                        onChange={(e) => setNewUserPassword(e.target.value)}
                        placeholder="Senha inicial"
                      />
                    </div>

                    <div className="page-field">
                      <label>Confirmar senha</label>
                      <input
                        type="password"
                        value={newUserConfirm}
                        onChange={(e) => setNewUserConfirm(e.target.value)}
                        placeholder="Repita a senha"
                      />
                    </div>
                  </div>

                  <div className="page-actions">
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={creatingUser}
                    >
                      {creatingUser ? "Cadastrando..." : "Cadastrar usuário"}
                    </button>
                  </div>
                </form>
              </div>

              {/* Lista de usuários */}
              <div className="page-section">
                <h3>Usuários cadastrados</h3>
                <p className="page-section-description">
                  Lista de usuários registrados via painel. O Administrador pode
                  alterar o perfil de acesso e disparar redefinição de senha por
                  e-mail.
                </p>

                {managedUsers.length === 0 ? (
                  <p className="field-hint">
                    Nenhum usuário cadastrado ainda por este painel.
                  </p>
                ) : (
                  <div className="user-table">
                    <div className="user-table-header">
                      <span>Nome</span>
                      <span>E-mail</span>
                      <span>Perfil</span>
                      <span>Criado em</span>
                      <span>Ações</span>
                    </div>
                    {managedUsers.map((u) => (
                      <div key={u.id} className="user-table-row">
                        <span>{u.nome || "-"}</span>
                        <span>{u.email || "-"}</span>
                        <span>
                          {canManageUsers ? (
                            <select
                              value={u.role}
                              onChange={(e) =>
                                handleChangeManagedUserRole(
                                  u,
                                  e.target.value as Role
                                )
                              }
                            >
                              <option value="diretor">Diretor</option>
                              <option value="operador">Operador</option>
                              <option value="terceirizada">Terceirizada</option>
                              <option value="adm">Administrador</option>
                            </select>
                          ) : (
                            ROLE_LABEL[u.role]
                          )}
                        </span>
                        <span>
                          {u.createdAt
                            ? u.createdAt.toDate().toLocaleString("pt-BR", {
                                day: "2-digit",
                                month: "2-digit",
                                year: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "-"}
                        </span>
                        <span>
                          {canManageUsers ? (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => handleSendResetEmail(u)}
                              disabled={resettingUserId === u.id}
                            >
                              {resettingUserId === u.id
                                ? "Enviando..."
                                : "Redefinir senha"}
                            </button>
                          ) : (
                            <span className="field-hint">
                              Redefinição de senha disponível apenas para
                              Administrador.
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* MODAL DE ALTERAÇÃO DE SENHA (MINHA SENHA) */}
      {showPasswordModal && (
        <div className="modal-backdrop" onClick={handleClosePasswordModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Alterar minha senha</h3>
              <button
                type="button"
                className="modal-close"
                onClick={handleClosePasswordModal}
              >
                ×
              </button>
            </div>

            <form className="modal-body" onSubmit={handleChangePassword}>
              <div className="page-field">
                <label>Senha atual</label>
                <div className="input-wrapper">
                  <input
                    type={showCurrentPassword ? "text" : "password"}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Digite sua senha atual"
                  />
                  <button
                    type="button"
                    className="input-icon-right"
                    onClick={() => setShowCurrentPassword((v) => !v)}
                  >
                    {showCurrentPassword ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>

              <div className="page-field">
                <label>Nova senha</label>
                <div className="input-wrapper">
                  <input
                    type={showNewPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Nova senha"
                  />
                  <button
                    type="button"
                    className="input-icon-right"
                    onClick={() => setShowNewPassword((v) => !v)}
                  >
                    {showNewPassword ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>

              <div className="page-field">
                <label>Confirmar nova senha</label>
                <div className="input-wrapper">
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repita a nova senha"
                  />
                  <button
                    type="button"
                    className="input-icon-right"
                    onClick={() =>
                      setShowConfirmPassword((v) => !v)
                    }
                  >
                    {showConfirmPassword ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleClosePasswordModal}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn-primary">
                  Salvar nova senha
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL DE PERMISSÃO / SENHA MESTRA */}
      {permissionModalOpen && (
        <div className="modal-backdrop" onClick={closePermissionModal}>
          <div
            className="modal modal-danger"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                <span role="img" aria-label="Atenção">
                  ⚠️
                </span>{" "}
                Acesso restrito
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={closePermissionModal}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <p>{permissionModalMessage}</p>

              {permissionModalRequirePassword ? (
                <>
                  <p className="field-hint">
                    Para prosseguir, digite a senha de administrador.
                  </p>

                  <form onSubmit={handlePermissionPasswordSubmit}>
                    <div className="page-field">
                      <label>Senha de administrador</label>
                      <input
                        type="password"
                        value={overridePassword}
                        onChange={(e) => setOverridePassword(e.target.value)}
                        placeholder="Digite a senha"
                      />
                      {overrideError && (
                        <p className="field-error">{overrideError}</p>
                      )}
                    </div>

                    <div className="modal-footer">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={closePermissionModal}
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        className="btn-primary btn-danger"
                      >
                        Confirmar
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <>
                  <p className="field-hint">
                    Se você precisa dessa permissão, fale com um Administrador
                    do sistema.
                  </p>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn-primary btn-danger"
                      onClick={closePermissionModal}
                    >
                      Entendi
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default Usuario;
