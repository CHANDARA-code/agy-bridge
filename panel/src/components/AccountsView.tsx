import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Card, Collapse, Dropdown, Empty, Flex, Form, Input, Modal, Select, Skeleton, Tag, Tooltip, Typography, theme } from "antd";
import type { MenuProps } from "antd";
import { DeleteOutlined, EditOutlined, KeyOutlined, LoginOutlined, LogoutOutlined, MoreOutlined, PictureOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { accountDisplayName, accountEmail, api } from "../api";
import type { Account, LoginSession, Provider, ProviderId } from "../api";
import { useServerEvent } from "../events";
import { formatAgo, formatDateTime } from "../format";
import { SignInModal } from "./SignInModal";
import { AccountAvatar, loadAccounts } from "./AccountAvatar";
import { AvatarModal } from "./AvatarModal";
import { ModelSelect } from "./ModelSelect";
import { ProviderIcon } from "./ProviderIcon";
import { ApiKeyModal } from "./ApiKeyModal";
import { ServiceLogo } from "./ServiceLogo";

interface AccountsViewProps {
  isMobile: boolean;
}

const PROVIDER_IDS: ProviderId[] = ["agy", "claude", "codex"];

const PROVIDER_DEFAULTS: Record<ProviderId, { name: string; bin: string }> = {
  agy: { name: "Antigravity", bin: "agy" },
  claude: { name: "Claude Code", bin: "claude" },
  codex: { name: "Codex", bin: "codex" },
};

const PROVIDER_CARDS: { id: ProviderId; name: string; hint: string }[] = [
  { id: "agy", name: "Antigravity", hint: "Sign in with Google" },
  { id: "claude", name: "Claude", hint: "Sign in with your Claude account" },
  { id: "codex", name: "Codex", hint: "Sign in with ChatGPT" },
];

interface AddFormValues {
  provider: ProviderId;
  id: string;
  label?: string;
  model?: string;
}

interface EditFormValues {
  label?: string;
  model?: string;
}

interface PendingAccountInfo {
  id: string;
  method?: string;
}

export function AccountsView({ isMobile }: AccountsViewProps) {
  const { token } = theme.useToken();
  const { message, modal } = AntApp.useApp();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addForm] = Form.useForm<AddFormValues>();
  const addProvider = Form.useWatch("provider", addForm);

  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();

  const [signInTarget, setSignInTarget] = useState<{ account: Account; provider: Provider } | null>(null);
  const [signInAutoStart, setSignInAutoStart] = useState(false);
  const [pendingNewAccount, setPendingNewAccount] = useState<PendingAccountInfo | null>(null);

  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [loggingOutIds, setLoggingOutIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [avatarAccount, setAvatarAccount] = useState<Account | null>(null);
  const [apiKeyTarget, setApiKeyTarget] = useState<{ account: Account | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await loadAccounts();
      setAccounts(res.accounts);
      setProviders(res.providers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || loading || accounts.length === 0) return;
    autoChecked.current = true;
    const unchecked = accounts.filter((a) => !a.status?.checkedAt);
    if (unchecked.length === 0) return;
    setCheckingIds((prev) => new Set([...prev, ...unchecked.map((a) => a.id)]));
    Promise.allSettled(unchecked.map((a) => api.checkAccount(a.id))).then(() => {
      setCheckingIds((prev) => {
        const next = new Set(prev);
        unchecked.forEach((a) => next.delete(a.id));
        return next;
      });
      refresh();
    });
  }, [accounts, loading, refresh]);

  const installedProviders = providers.filter((p) => p.installed);

  const getUsageSummary = (acc: Account) => {
    if (acc.limits?.windows && acc.limits.windows.length > 0) {
      const valid = acc.limits.windows.filter((w) => w.usedPercent !== null);
      if (valid.length > 0) {
        const highest = [...valid].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
        const pct = highest.usedPercent ?? 0;
        const word = pct >= 90 ? "Almost out" : pct >= 70 ? "Getting close" : "OK";
        return `${highest.label}: ${Math.round(pct)}% (${word})`;
      }
    }
    if (acc.budget) {
      return `Budget: ${acc.budget.tokens.toLocaleString()} / ${acc.budget.period}`;
    }
    return null;
  };

  const handleOpenAdd = () => {
    addForm.resetFields();
    if (installedProviders.length > 0) {
      addForm.setFieldValue("provider", installedProviders[0].id);
    }
    setAddOpen(true);
  };

  const handleCardClick = async (providerId: ProviderId) => {
    const prov = providers.find((p) => p.id === providerId);
    if (!prov?.installed || addSubmitting) return;

    setAddSubmitting(true);
    try {
      const existingIds = new Set(accounts.map((a) => a.id));
      let n = 2;
      const displayName = PROVIDER_CARDS.find((c) => c.id === providerId)?.name ?? providerId;
      let created: Account | null = null;
      let finalLabel = "";

      for (let attempt = 0; attempt < 20; attempt++) {
        while (existingIds.has(`${providerId}-${n}`)) {
          n++;
        }
        const targetId = `${providerId}-${n}`;
        finalLabel = `${displayName} account ${n}`;
        try {
          created = await api.createAccount({
            id: targetId,
            provider: providerId,
            label: finalLabel,
          });
          break;
        } catch (err) {
          if (err instanceof Error && "status" in err && (err as { status: number }).status === 409) {
            n++;
            continue;
          }
          throw err;
        }
      }

      if (!created) {
        throw new Error("Could not allocate account id");
      }

      setAddOpen(false);
      await refresh();

      const providerObj = providers.find((p) => p.id === created.provider) ?? prov;
      setPendingNewAccount({ id: created.id });
      setSignInAutoStart(true);
      setSignInTarget({ account: created, provider: providerObj });
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleAdvancedSubmit = async () => {
    let values: AddFormValues;
    try {
      values = await addForm.validateFields();
    } catch {
      return;
    }
    setAddSubmitting(true);
    try {
      const customLabel = values.label?.trim() || values.id.trim();
      const created = await api.createAccount({
        id: values.id.trim(),
        provider: values.provider,
        label: customLabel,
        model: values.model?.trim() || null,
      });
      setAddOpen(false);
      await refresh();

      const prov = providers.find((p) => p.id === created.provider) ?? {
        id: created.provider,
        name: PROVIDER_DEFAULTS[created.provider].name,
        installed: true,
        bin: PROVIDER_DEFAULTS[created.provider].bin,
        loginMethods: ["terminal"],
        canLogout: false,
      };
      setPendingNewAccount({ id: created.id });
      setSignInAutoStart(true);
      setSignInTarget({ account: created, provider: prov });
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleSignInSuccess = async () => {
    setPendingNewAccount(null);
    await refresh();
  };

  const [finishingLoginId, setFinishingLoginId] = useState<string | null>(null);

  useServerEvent("login", (data: { id: string; state: string }) => {
    if (data.id !== finishingLoginId || data.state === "starting" || data.state === "waiting") return;
    setFinishingLoginId(null);
    refresh();
  });

  const handleSignInClose = async (session: LoginSession | null) => {
    const currentPending = pendingNewAccount;
    setSignInTarget(null);
    setSignInAutoStart(false);
    setPendingNewAccount(null);

    if (currentPending && session?.verifying && session.state === "waiting") {
      message.info("Finishing sign-in in the background.");
      setFinishingLoginId(session.id);
      return;
    }

    if (currentPending && currentPending.method === "terminal") {
      message.info("Finish signing in in the Terminal window, then press Check on the account.");
      await refresh();
      return;
    }

    if (currentPending) {
      try {
        const res = await loadAccounts();
        const targetAcc = res.accounts.find((a) => a.id === currentPending.id);
        if (targetAcc && targetAcc.status?.state !== "signed-in") {
          await api.deleteAccount(currentPending.id);
          message.info("Account not added because sign-in was not finished");
          await refresh();
        }
      } catch {}
    }
  };

  const handleOpenEdit = (acc: Account) => {
    setEditingAccount(acc);
    editForm.setFieldsValue({
      label: acc.label,
      model: acc.model ?? "",
    });
  };

  const handleEditSubmit = async () => {
    if (!editingAccount) return;
    let values: EditFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSubmitting(true);
    try {
      await api.updateAccount(editingAccount.id, {
        label: values.label?.trim() || undefined,
        model: values.model?.trim() || null,
      });
      message.success("Account updated");
      setEditingAccount(null);
      await refresh();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update account");
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleCheck = async (acc: Account) => {
    setCheckingIds((prev) => new Set(prev).add(acc.id));
    try {
      await api.checkAccount(acc.id);
      message.success(`Status updated for ${acc.id}`);
      await refresh();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Check status failed");
    } finally {
      setCheckingIds((prev) => {
        const next = new Set(prev);
        next.delete(acc.id);
        return next;
      });
    }
  };

  const handleLogout = async (acc: Account) => {
    setLoggingOutIds((prev) => new Set(prev).add(acc.id));
    try {
      await api.logoutAccount(acc.id);
      message.success(`Signed out of ${acc.id}`);
      await refresh();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Sign out failed");
    } finally {
      setLoggingOutIds((prev) => {
        const next = new Set(prev);
        next.delete(acc.id);
        return next;
      });
    }
  };

  const handleDelete = async (acc: Account) => {
    setDeletingIds((prev) => new Set(prev).add(acc.id));
    try {
      await api.deleteAccount(acc.id);
      message.success(`Deleted account ${acc.id}`);
      await refresh();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(acc.id);
        return next;
      });
    }
  };

  const openSignInFor = (acc: Account) => {
    setPendingNewAccount(null);
    setSignInAutoStart(false);
    const prov = providers.find((p) => p.id === acc.provider) ?? {
      id: acc.provider,
      name: PROVIDER_DEFAULTS[acc.provider].name,
      installed: true,
      bin: PROVIDER_DEFAULTS[acc.provider].bin,
      loginMethods: ["terminal"],
      canLogout: false,
    };
    setSignInTarget({ account: acc, provider: prov });
  };

  const renderStatusTag = (acc: Account) => {
    const state = acc.status?.state ?? "unknown";
    if (acc.apiKey && state === "signed-in") return <Tag color="success" style={{ marginInlineEnd: 0 }}>Key ready</Tag>;
    if (acc.apiKey && state === "signed-out") return <Tag color="error" style={{ marginInlineEnd: 0 }}>Key not working</Tag>;
    if (state === "signed-in") {
      const emailPart = acc.status?.email ? ` · ${acc.status.email}` : "";
      const planPart = acc.status?.plan ? ` (${acc.status.plan})` : "";
      return (
        <Tag color="success" style={{ marginInlineEnd: 0 }}>
          Signed in{emailPart}{planPart}
        </Tag>
      );
    }
    if (state === "signed-out") {
      return (
        <Tag color="default" style={{ marginInlineEnd: 0 }}>
          Signed out
        </Tag>
      );
    }
    if (state === "error") {
      return (
        <Tag color="error" style={{ marginInlineEnd: 0 }}>
          Error
        </Tag>
      );
    }
    return (
      <Tag color="warning" style={{ marginInlineEnd: 0 }}>
        {acc.status?.checkedAt ? "Unknown" : "Never checked"}
      </Tag>
    );
  };

  const signInFromCard = (acc: Account, prov: Provider) => {
    if (!acc.system) {
      openSignInFor(acc);
      return;
    }
    modal.confirm({
      title: `Sign in to your default ${prov.name} sign-in?`,
      content: `This changes the sign-in ${prov.name} uses on this computer, also outside a2a-panel. To add another ${prov.name} account next to it, use Add account instead.`,
      okText: "Sign in",
      onOk: () => openSignInFor(acc),
    });
  };

  const confirmDelete = (acc: Account) => {
    modal.confirm({
      title: `Delete ${accountDisplayName(acc)}?`,
      content: "Its sign-in and picture are removed from this computer. Teams that use it must be changed first.",
      okText: "Delete",
      okButtonProps: { danger: true },
      onOk: () => handleDelete(acc),
    });
  };

  const confirmLogout = (acc: Account, prov: Provider) => {
    modal.confirm({
      title: acc.system ? `Sign out of your default ${prov.name} sign-in?` : `Sign out of ${accountDisplayName(acc)}?`,
      content: acc.system
        ? `This signs ${prov.name} out on this computer, including when you use it outside a2a-panel.`
        : "You can sign in again at any time.",
      okText: "Sign out",
      okButtonProps: { danger: true },
      onOk: () => handleLogout(acc),
    });
  };

  const cardActions = (acc: Account, prov: Provider) => {
    const signedIn = acc.status?.state === "signed-in";
    const actions = [];
    if (acc.apiKey) {
      actions.push(
        <Button type="link" size="small" icon={<KeyOutlined />} key="key" onClick={() => setApiKeyTarget({ account: acc })}>
          Change key
        </Button>,
      );
    } else if (!signedIn) {
      actions.push(
        <Button type="link" size="small" icon={<LoginOutlined />} key="login" onClick={() => signInFromCard(acc, prov)}>
          Sign in
        </Button>,
      );
    } else if (!acc.system && prov.canLogout) {
      actions.push(
        <Button type="link" size="small" danger icon={<LogoutOutlined />} key="logout" loading={loggingOutIds.has(acc.id)} onClick={() => confirmLogout(acc, prov)}>
          Sign out
        </Button>,
      );
    }
    actions.push(
      <Button type="link" size="small" icon={<ReloadOutlined />} key="check" loading={checkingIds.has(acc.id)} onClick={() => handleCheck(acc)}>
        Check
      </Button>,
    );
    const items: MenuProps["items"] = [
      ...(signedIn && !acc.apiKey ? [{ key: "signin", icon: <LoginOutlined />, label: "Sign in again" }] : []),
      { key: "picture", icon: <PictureOutlined />, label: "Change picture" },
      ...(!acc.system ? [{ key: "edit", icon: <EditOutlined />, label: "Edit name or model" }] : []),
      ...(acc.system && signedIn && prov.canLogout ? [{ key: "logout", icon: <LogoutOutlined />, label: "Sign out…", danger: true }] : []),
      ...(!acc.system ? [{ type: "divider" as const }, { key: "delete", icon: <DeleteOutlined />, label: "Delete account", danger: true }] : []),
    ];
    const onMenuClick: MenuProps["onClick"] = ({ key }) => {
      if (key === "signin") signInFromCard(acc, prov);
      if (key === "picture") setAvatarAccount(acc);
      if (key === "edit") handleOpenEdit(acc);
      if (key === "logout") confirmLogout(acc, prov);
      if (key === "delete") confirmDelete(acc);
    };
    actions.push(
      <Dropdown key="more" trigger={["click"]} menu={{ items, onClick: onMenuClick }}>
        <Button type="link" size="small" icon={<MoreOutlined />} aria-label={`More actions for ${accountDisplayName(acc)}`} loading={deletingIds.has(acc.id)} />
      </Dropdown>,
    );
    return actions;
  };

  return (
    <Flex vertical gap={20}>
      <Flex justify="space-between" align={isMobile ? "flex-start" : "center"} vertical={isMobile} gap={12}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>Accounts</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            Each account signs in separately and uses its own quota. Spread work across accounts: a leader plans, developers code.
          </Typography.Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleOpenAdd}
          disabled={installedProviders.length === 0}
        >
          Add account
        </Button>
      </Flex>

      {error && <Alert type="error" showIcon message={error} />}
      {loading && !error && <Skeleton active paragraph={{ rows: 6 }} />}

      {!loading && PROVIDER_IDS.map((pId) => {
        const prov = providers.find((p) => p.id === pId) ?? {
          id: pId,
          name: PROVIDER_DEFAULTS[pId].name,
          installed: false,
          bin: PROVIDER_DEFAULTS[pId].bin,
          loginMethods: ["terminal"],
          canLogout: false,
        };
        const provAccounts = accounts.filter((a) => a.provider === pId);

        return (
          <Flex vertical gap={12} key={pId}>
            <Flex align="center" gap={8}>
              <ProviderIcon provider={prov} size={20} />
              <Typography.Title level={5} style={{ margin: 0 }}>{prov.name}</Typography.Title>
            </Flex>

            {!prov.installed && (
              <Alert
                type="warning"
                showIcon
                message={`${prov.name} is not installed on this computer`}
                style={{ marginBottom: 4 }}
              />
            )}

            {provAccounts.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={`No ${prov.name} accounts configured`}
                style={{ margin: "8px 0 16px" }}
              />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(340px, 1fr))",
                  gap: 16,
                }}
              >
                {provAccounts.map((acc) => (
                  <Card
                    key={acc.id}
                    size="small"
                    styles={{ body: { padding: 14 } }}
                    actions={cardActions(acc, prov)}
                  >
                    <Flex vertical gap={8}>
                      <Flex justify="space-between" align="flex-start" gap={8} wrap>
                        <Flex align="center" gap={12} style={{ minWidth: 0, flex: "1 1 auto" }}>
                          <button
                            type="button"
                            onClick={() => setAvatarAccount(acc)}
                            aria-label={`Change picture for ${accountDisplayName(acc)}`}
                            style={{
                              padding: 0,
                              margin: 0,
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              borderRadius: "50%",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                              lineHeight: 0,
                            }}
                          >
                            <AccountAvatar account={acc} size={40} />
                          </button>
                          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                            <Typography.Text strong style={{ fontSize: 15, display: "block" }} ellipsis>
                              {accountDisplayName(acc)}
                            </Typography.Text>
                            {accountEmail(acc) && accountEmail(acc) !== accountDisplayName(acc) && (
                              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }} ellipsis>
                                {accountEmail(acc)}
                              </Typography.Text>
                            )}
                            <Typography.Text code copyable style={{ fontSize: 12 }}>
                              {acc.id}
                            </Typography.Text>
                          </div>
                        </Flex>
                        <Flex gap={4} wrap align="center">
                          <Tag style={{ marginInlineEnd: 0, display: "inline-flex", alignItems: "center", gap: 5 }}>
                            <ProviderIcon provider={prov} size={14} />
                            <span>{prov.name}</span>
                          </Tag>
                          {acc.system && <Tag color="blue" style={{ marginInlineEnd: 0 }}>Default sign-in</Tag>}
                          {acc.apiKey && (
                            <Tag style={{ marginInlineEnd: 0, display: "inline-flex", alignItems: "center", gap: 5 }}>
                              <ServiceLogo service={acc.apiKey.service} size={14} />
                              <span>{acc.apiKey.serviceName} · …{acc.apiKey.last4}</span>
                            </Tag>
                          )}
                          {acc.model && <Tag style={{ marginInlineEnd: 0 }}>{acc.model}</Tag>}
                        </Flex>
                      </Flex>

                      <Flex align="center" gap={6} wrap>
                        {renderStatusTag(acc)}
                      </Flex>

                      {acc.status?.detail && acc.status.checkedAt && (
                        <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                          {acc.status.detail}
                        </Typography.Paragraph>
                      )}

                      {acc.status?.warning && (
                        <Alert type="warning" showIcon message={acc.status.warning} style={{ margin: "4px 0" }} />
                      )}

                      <Flex justify="space-between" align="center" style={{ fontSize: 12, marginTop: 4 }}>
                        <Typography.Text type="secondary">
                          {acc.usage?.tasks ?? 0} {(acc.usage?.tasks ?? 0) === 1 ? "task" : "tasks"} · {(acc.usage?.total_tokens ?? 0).toLocaleString()} tokens
                        </Typography.Text>
                        <Tooltip title={formatDateTime(acc.status?.checkedAt)}>
                          <Typography.Text type="secondary">
                            {acc.status?.checkedAt ? `Checked ${formatAgo(acc.status.checkedAt)}` : ""}
                          </Typography.Text>
                        </Tooltip>
                      </Flex>

                      <Flex justify="space-between" align="center" style={{ fontSize: 12, marginTop: 2 }}>
                        <Typography.Text type="secondary" ellipsis style={{ maxWidth: "75%" }}>
                          {getUsageSummary(acc) ?? ""}
                        </Typography.Text>
                        <a href="#usage" style={{ color: token.colorPrimary, fontWeight: 500, whiteSpace: "nowrap" }}>
                          Usage &rarr;
                        </a>
                      </Flex>
                    </Flex>
                  </Card>
                ))}
              </div>
            )}
          </Flex>
        );
      })}

      <Modal
        open={addOpen}
        title="Add account"
        onCancel={() => setAddOpen(false)}
        footer={null}
        destroyOnHidden
        width={isMobile ? "100%" : 640}
      >
        <Flex vertical gap={20} style={{ marginTop: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)",
              gap: 16,
            }}
          >
            {PROVIDER_CARDS.map((card) => {
              const prov = providers.find((p) => p.id === card.id);
              const isInstalled = Boolean(prov?.installed);
              return (
                <Card
                  key={card.id}
                  hoverable={isInstalled && !addSubmitting}
                  onClick={() => {
                    if (isInstalled && !addSubmitting) {
                      handleCardClick(card.id);
                    }
                  }}
                  style={{
                    cursor: isInstalled && !addSubmitting ? "pointer" : "not-allowed",
                    opacity: isInstalled ? 1 : 0.6,
                    textAlign: "center",
                    border: `1px solid ${token.colorBorderSecondary}`,
                  }}
                  styles={{ body: { padding: "20px 14px" } }}
                  role="button"
                  tabIndex={isInstalled ? 0 : -1}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && isInstalled && !addSubmitting) {
                      e.preventDefault();
                      handleCardClick(card.id);
                    }
                  }}
                  aria-disabled={!isInstalled}
                >
                  <Flex vertical align="center" gap={8}>
                    <ProviderIcon provider={prov ?? card.id} size={40} />
                    <Typography.Text strong style={{ fontSize: 16 }}>
                      {card.name}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 13, minHeight: 38 }}>
                      {isInstalled ? card.hint : "Not installed"}
                    </Typography.Text>
                    {!isInstalled && (
                      <Tag style={{ marginInlineEnd: 0 }}>Not installed</Tag>
                    )}
                  </Flex>
                </Card>
              );
            })}
          </div>

          <Card
            hoverable
            onClick={() => {
              setAddOpen(false);
              setApiKeyTarget({ account: null });
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setAddOpen(false);
                setApiKeyTarget({ account: null });
              }
            }}
            style={{ border: `1px solid ${token.colorBorderSecondary}` }}
            styles={{ body: { padding: "16px 18px" } }}
          >
            <Flex align="center" gap={14}>
              <KeyOutlined style={{ fontSize: 28, color: token.colorPrimary }} />
              <div>
                <Typography.Text strong style={{ fontSize: 16, display: "block" }}>Use an API key</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  DeepSeek, Kimi, GLM, MiniMax, Qwen, OpenRouter, Anthropic, OpenAI and other compatible APIs. Runs with Claude Code or Codex.
                </Typography.Text>
              </div>
            </Flex>
          </Card>

          <Collapse
            ghost
            items={[
              {
                key: "advanced",
                label: "Advanced",
                children: (
                  <Form
                    form={addForm}
                    layout="vertical"
                    requiredMark={false}
                    disabled={addSubmitting}
                    onFinish={handleAdvancedSubmit}
                  >
                    <Form.Item name="provider" label="Provider" rules={[{ required: true, message: "Select a provider" }]}>
                      <Select
                        options={providers.map((p) => {
                          const card = PROVIDER_CARDS.find((c) => c.id === p.id);
                          const name = card?.name ?? p.name;
                          return {
                            value: p.id,
                            label: p.installed ? name : `${name} (Not installed)`,
                            disabled: !p.installed,
                          };
                        })}
                      />
                    </Form.Item>
                    <Form.Item
                      name="id"
                      label="Account ID"
                      rules={[
                        { required: true, message: "Enter an id" },
                        { pattern: /^[a-z0-9][a-z0-9-]{0,47}$/, message: 'Lowercase letters, digits and "-"' },
                        {
                          validator: (_, value: string) =>
                            value === "none" || value === "default"
                              ? Promise.reject(new Error(`"${value}" is reserved`))
                              : Promise.resolve(),
                        },
                      ]}
                    >
                      <Input placeholder="my-agent-account" />
                    </Form.Item>
                    <Form.Item name="label" label="Label">
                      <Input placeholder="Descriptive name (e.g. Work Claude)" />
                    </Form.Item>
                    <Form.Item name="model" label="Model (optional)" extra="Models your default sign-in for this tool can use.">
                      <ModelSelect accountId={addProvider} placeholder="Default model" />
                    </Form.Item>
                    <Flex justify="flex-end" gap={8}>
                      <Button type="primary" htmlType="submit" loading={addSubmitting}>
                        Create and sign in
                      </Button>
                    </Flex>
                  </Form>
                ),
              },
            ]}
          />
        </Flex>
      </Modal>

      <Modal
        open={editingAccount !== null}
        title={`Edit ${editingAccount?.id ?? ""}`}
        okText="Save"
        onOk={handleEditSubmit}
        confirmLoading={editSubmitting}
        onCancel={() => setEditingAccount(null)}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical" requiredMark={false} disabled={editSubmitting}>
          <Form.Item name="label" label="Label" rules={[{ required: true, message: "Enter a label" }]}>
            <Input placeholder="Label" />
          </Form.Item>
          <Form.Item name="model" label="Model (optional)">
            <ModelSelect accountId={editingAccount?.id} placeholder="Default model" />
          </Form.Item>
        </Form>
      </Modal>

      <SignInModal
        open={signInTarget !== null}
        account={signInTarget?.account ?? null}
        provider={signInTarget?.provider ?? null}
        autoStart={signInAutoStart}
        onStarted={(method) => setPendingNewAccount((pending) => (pending ? { ...pending, method } : pending))}
        onClose={handleSignInClose}
        onSuccess={handleSignInSuccess}
      />

      <ApiKeyModal
        open={apiKeyTarget !== null}
        account={apiKeyTarget?.account ?? null}
        accounts={accounts}
        installed={installedProviders.map((p) => p.id)}
        isMobile={isMobile}
        onClose={() => setApiKeyTarget(null)}
        onSaved={() => {
          setApiKeyTarget(null);
          refresh();
        }}
      />

      <AvatarModal
        open={avatarAccount !== null}
        account={avatarAccount ? accounts.find((a) => a.id === avatarAccount.id) ?? avatarAccount : null}
        onClose={() => setAvatarAccount(null)}
        onSuccess={() => {
          refresh();
        }}
      />
    </Flex>
  );
}
