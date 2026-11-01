import { useEffect, useMemo, useState } from "react";
import { Alert, App as AntApp, AutoComplete, Flex, Form, Input, Modal, Select, Tag, Typography } from "antd";
import { api } from "../api";
import type { Account, ApiService, ProviderId } from "../api";

interface ApiKeyModalProps {
  open: boolean;
  account: Account | null;
  accounts: Account[];
  installed: ProviderId[];
  isMobile: boolean;
  onClose: () => void;
  onSaved: (account: Account) => void;
}

interface FormValues {
  service: string;
  id: string;
  label?: string;
  key?: string;
  baseUrl?: string;
  model?: string;
  fastModel?: string;
}

const ENGINE_NAMES: Record<"claude" | "codex", string> = { claude: "Claude Code", codex: "Codex" };

function freeId(base: string, taken: Set<string>) {
  for (let n = 1; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
  return base;
}

export function ApiKeyModal({ open, account, accounts, installed, isMobile, onClose, onSaved }: ApiKeyModalProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [services, setServices] = useState<ApiService[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const serviceId = Form.useWatch("service", form);
  const editing = account !== null;
  const service = services.find((item) => item.id === (editing ? account.apiKey?.service : serviceId));

  useEffect(() => {
    if (!open) return;
    api.apiServices().then(setServices).catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load the services"));
  }, [open]);

  useEffect(() => {
    if (!open || !services.length) return;
    form.resetFields();
    if (editing && account.apiKey) {
      const current = services.find((item) => item.id === account.apiKey?.service);
      form.setFieldsValue({
        service: account.apiKey.service,
        baseUrl: account.apiKey.baseUrl ?? current?.baseUrl ?? "",
        model: account.model ?? "",
        fastModel: account.apiKey.fastModel ?? "",
      });
    }
  }, [open, services, editing, account, form]);

  const pickService = (id: string) => {
    const next = services.find((item) => item.id === id);
    if (!next) return;
    const taken = new Set(accounts.map((item) => item.id));
    form.setFieldsValue({
      id: freeId(next.id, taken),
      label: next.name,
      baseUrl: next.baseUrl ?? "",
      model: next.models.main,
      fastModel: next.models.fast,
    });
  };

  const options = useMemo(
    () =>
      (["claude", "codex"] as const).map((engine) => ({
        label: `Runs with ${ENGINE_NAMES[engine]}${installed.includes(engine) ? "" : " (not installed)"}`,
        options: services
          .filter((item) => item.engine === engine)
          .map((item) => ({
            value: item.id,
            disabled: !installed.includes(engine),
            label: (
              <Flex justify="space-between" gap={8}>
                <span>{item.name}</span>
                {item.region !== "Global" && item.region !== "Any" && <Tag style={{ marginInlineEnd: 0 }}>{item.region}</Tag>}
              </Flex>
            ),
          })),
      })),
    [services, installed],
  );

  const submit = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!service) return;
    setSaving(true);
    try {
      const baseUrl = service.baseUrl === null ? undefined : values.baseUrl?.trim() || null;
      const fastModel = service.engine === "claude" ? values.fastModel?.trim() || null : undefined;
      const saved = editing
        ? await api.setApiKey(account.id, { key: values.key?.trim() || undefined, baseUrl, fastModel, model: values.model?.trim() || null })
        : await api.createAccount({
            id: values.id.trim(),
            label: values.label?.trim() || service.name,
            model: values.model?.trim() || null,
            apiKey: { service: service.id, key: values.key?.trim(), baseUrl, fastModel },
          });
      const ok = saved.status.state === "signed-in";
      if (ok) message.success(saved.status.detail);
      else message.warning(saved.status.detail);
      onSaved(saved);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Could not save the key");
    } finally {
      setSaving(false);
    }
  };

  const modelSuggestions = service ? [service.models.main, service.models.fast].filter(Boolean).map((value) => ({ value })) : [];

  return (
    <Modal
      open={open}
      title={editing ? `Change the API key of ${account.label || account.id}` : "Add an API key account"}
      okText={editing ? "Save and check" : "Add and check the key"}
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      width={isMobile ? "100%" : 600}
    >
      {loadError && <Alert type="error" showIcon message={loadError} />}
      <Form form={form} layout="vertical" requiredMark={false} disabled={saving} style={{ marginTop: 12 }}>
        {!editing && (
          <Typography.Paragraph type="secondary">
            The account runs Claude Code or Codex against the provider you choose, with your key. Tasks, teams, token usage and budgets work like any other account. The key is stored only in this account's folder on your computer, readable only by you.
          </Typography.Paragraph>
        )}
        <Form.Item name="service" label="Service" rules={[{ required: true, message: "Choose a service" }]}>
          <Select options={options} onChange={pickService} disabled={editing || saving} placeholder="DeepSeek, Kimi, GLM, MiniMax, Qwen, OpenRouter, OpenAI…" showSearch optionFilterProp="value" />
        </Form.Item>
        {service && (
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            Runs with {ENGINE_NAMES[service.engine]}.{" "}
            {service.keyPage && (
              <>
                <Typography.Link href={service.keyPage} target="_blank" rel="noreferrer">Get a key</Typography.Link>
                {" · "}
              </>
            )}
            <Typography.Link href={service.docs} target="_blank" rel="noreferrer">Setup guide</Typography.Link>
            {!service.checksKey && ` · ${service.name} has no free key check, so the first task proves the key.`}
          </Typography.Paragraph>
        )}
        {!editing && (
          <Flex gap={12} vertical={isMobile}>
            <Form.Item
              name="id"
              label="Account id"
              style={{ flex: 1 }}
              rules={[
                { required: true, message: "Enter an id" },
                { pattern: /^[a-z0-9][a-z0-9-]{0,47}$/, message: 'Lowercase letters, digits and "-"' },
              ]}
            >
              <Input placeholder="deepseek-1" />
            </Form.Item>
            <Form.Item name="label" label="Name" style={{ flex: 1 }}>
              <Input placeholder="DeepSeek" />
            </Form.Item>
          </Flex>
        )}
        <Form.Item
          name="key"
          label="API key"
          rules={editing ? [] : [{ required: true, message: "Paste the API key" }]}
          extra={editing && account.apiKey ? `The key ending in ${account.apiKey.last4} is saved. Paste a new key only to replace it.` : undefined}
        >
          <Input.Password autoComplete="off" placeholder={service?.keyHint || "Paste the key"} />
        </Form.Item>
        {service && service.baseUrl !== null && (
          <Form.Item
            name="baseUrl"
            label="Base URL"
            extra={service.baseUrlHelp ?? undefined}
            rules={service.baseUrlRequired ? [{ required: true, message: "Enter the base URL" }, { validator: (_, value: string) => (/\{/.test(value || "") ? Promise.reject(new Error("Replace the {placeholder} with your value")) : Promise.resolve()) }] : []}
          >
            <Input placeholder="https://…" />
          </Form.Item>
        )}
        {service && (
          <Flex gap={12} vertical={isMobile}>
            <Form.Item
              name="model"
              label="Model"
              style={{ flex: 1 }}
              rules={service.needsModel ? [{ required: true, message: `Enter the ${service.name} model` }] : []}
              extra={service.models.main ? "Suggested by the provider's guide. Model names change; check the guide if a task says the model is unknown." : service.needsModel ? "The model id from your provider's console." : "Empty uses the tool's default model."}
            >
              <AutoComplete options={modelSuggestions} placeholder={service.needsModel ? "Model id" : "Default model"} />
            </Form.Item>
            {service.engine === "claude" && (
              <Form.Item name="fastModel" label="Fast model" style={{ flex: 1 }} extra="Used for Claude Code's quick background steps. Empty uses the model.">
                <AutoComplete options={modelSuggestions} placeholder="Same as the model" />
              </Form.Item>
            )}
          </Flex>
        )}
      </Form>
    </Modal>
  );
}
