import { useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Card,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Typography,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { accountDisplayName, api } from "../api";
import type { Account, PresetSummary, ProviderId, Role, Team, TeamDraft, TeamMember } from "../api";
import { AccountStatusDot } from "./StatusTag";
import { AccountAvatar } from "./AccountAvatar";
import { ProviderIcon } from "./ProviderIcon";
import { ModelSelect } from "./ModelSelect";
import { TeamTemplatePicker } from "./TeamTemplatePicker";

interface TeamEditorProps {
  open: boolean;
  team: Team | null;
  accounts: Account[];
  isMobile: boolean;
  onClose: () => void;
  onSaved: (team: Team) => void;
}

const PROVIDER_NAMES: Record<ProviderId, string> = {
  agy: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
};

const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

interface FormValues {
  id?: string;
  name: string;
  description?: string;
  leader: {
    account: string;
    model?: string;
    effort: string;
    instructions?: string;
  };
  members: TeamMember[];
  preset: string;
  workspace?: string;
  maxParallel: number;
  review: boolean;
}

export function TeamEditor({ open, team, accounts, isMobile, onClose, onSaved }: TeamEditorProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const leaderAccount = Form.useWatch(["leader", "account"], form);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);

  const blankValues = (): FormValues => {
    const defaultLeader = accounts[0]?.id ?? "agy";
    return {
      id: "",
      name: "",
      description: "",
      leader: { account: defaultLeader, model: undefined, effort: "medium", instructions: "" },
      members: [{ account: defaultLeader, roles: [], notes: "" }],
      preset: "__default__",
      workspace: undefined,
      maxParallel: 1,
      review: false,
    };
  };

  const applyDraft = (draft: TeamDraft) => {
    form.setFieldsValue({
      id: draft.id,
      name: draft.name,
      description: draft.description,
      leader: { account: draft.leader.account, model: undefined, effort: draft.leader.effort, instructions: draft.leader.instructions },
      members: draft.members,
      maxParallel: draft.maxParallel,
      review: draft.review,
    });
    setTemplateId(draft.template);
  };

  const startBlank = () => {
    form.setFieldsValue({ ...blankValues(), workspace: form.getFieldValue("workspace") });
    setTemplateId(null);
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    form.resetFields();

    api.roles().then((r) => setRoles(r.roles)).catch(() => {});
    api.presets().then((r) => setPresets(r.presets)).catch(() => {});
    api.workspaces().then(setWorkspaces).catch(() => {});

    if (team) {
      form.setFieldsValue({
        id: team.id,
        name: team.name,
        description: team.description,
        leader: {
          account: team.leader.account,
          model: team.leader.model ?? undefined,
          effort: team.leader.effort,
          instructions: team.leader.instructions,
        },
        members: team.members.map((m) => ({
          account: m.account,
          roles: m.roles,
          notes: m.notes,
        })),
        preset: team.preset === null ? "__default__" : team.preset,
        workspace: team.workspace ?? undefined,
        maxParallel: team.maxParallel,
        review: team.review,
      });
    } else {
      form.setFieldsValue(blankValues());
      setTemplateId(null);
    }
  }, [open, team, accounts, form]);

  const accountGroups = (() => {
    const providerIds: ProviderId[] = ["agy", "claude", "codex"];
    return providerIds.map((pId) => {
      const groupAccounts = accounts.filter((a) => a.provider === pId);
      return {
        label: (
          <Flex align="center" gap={6}>
            <ProviderIcon providerId={pId} size={16} />
            <span>{PROVIDER_NAMES[pId]}</span>
          </Flex>
        ),
        options: groupAccounts.map((a) => ({
          value: a.id,
          label: accountDisplayName(a),
          id: a.id,
          state: a.status?.state ?? "unknown",
        })),
      };
    }).filter((g) => g.options.length > 0);
  })();

  const handleSubmit = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setError(null);

    const presetVal = values.preset === "__default__" ? null : values.preset;

    try {
      if (team) {
        const updated = await api.updateTeam(team.id, {
          name: values.name.trim(),
          description: values.description?.trim() ?? "",
          leader: {
            account: values.leader.account,
            model: values.leader.model?.trim() || null,
            effort: values.leader.effort,
            instructions: values.leader.instructions?.trim() ?? "",
          },
          members: (values.members || []).map((m) => ({
            account: m.account,
            roles: m.roles ?? [],
            notes: m.notes?.trim() ?? "",
          })),
          preset: presetVal,
          workspace: values.workspace?.trim() || null,
          maxParallel: values.maxParallel,
          review: values.review,
        });
        message.success("Team updated");
        onSaved(updated);
      } else {
        const created = await api.createTeam({
          id: values.id!.trim(),
          name: values.name.trim(),
          description: values.description?.trim() ?? "",
          leader: {
            account: values.leader.account,
            model: values.leader.model?.trim() || null,
            effort: values.leader.effort,
            instructions: values.leader.instructions?.trim() ?? "",
          },
          members: (values.members || []).map((m) => ({
            account: m.account,
            roles: m.roles ?? [],
            notes: m.notes?.trim() ?? "",
          })),
          preset: presetVal,
          workspace: values.workspace?.trim() || null,
          maxParallel: values.maxParallel,
          review: values.review,
        });
        message.success("Team created");
        onSaved(created);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save team";
      setError(msg);
      message.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={isMobile ? "100%" : 720}
      title={team ? `Edit Team: ${team.name}` : "New Team"}
      destroyOnHidden
      footer={
        <Flex justify="flex-end" gap={8}>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            Save
          </Button>
        </Flex>
      }
    >
      {!team && <TeamTemplatePicker selected={templateId} onPick={applyDraft} onBlank={startBlank} />}
      <Form form={form} layout="vertical" requiredMark={false} disabled={submitting}>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        {!team && templateId && (
          <Alert
            type="info"
            showIcon
            message="Filled in from the template. Accounts were picked for you: the leader prefers an account that leads no other team, and each member gets a different signed-in account where possible. Change anything before you save."
            style={{ marginBottom: 16 }}
          />
        )}

        {!team && (
          <Form.Item
            name="id"
            label="Team ID"
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
            <Input placeholder="ios-core" />
          </Form.Item>
        )}

        <Form.Item
          name="name"
          label="Team Name"
          rules={[
            { required: true, message: "Enter team name" },
            { max: 80, message: "Maximum 80 characters" },
          ]}
        >
          <Input placeholder="iOS Core Team" maxLength={80} />
        </Form.Item>

        <Form.Item
          name="description"
          label="Description"
          rules={[{ max: 300, message: "Maximum 300 characters" }]}
        >
          <Input.TextArea placeholder="Focuses on iOS client features and testing" maxLength={300} showCount rows={2} />
        </Form.Item>

        <Card size="small" title="Leader" style={{ marginBottom: 16 }}>
          <Form.Item
            name={["leader", "account"]}
            label="Leader account"
            rules={[{ required: true, message: "Select leader account" }]}
          >
            <Select
              options={accountGroups}
              labelRender={(props) => (
                <Flex align="center" gap={6}>
                  <AccountAvatar accountId={String(props.value)} accounts={accounts} size={20} />
                  <span>{props.label}</span>
                </Flex>
              )}
              optionRender={(option) => {
                const item = option.data as unknown as { value?: string; label?: string; id?: string; state?: Account["status"]["state"] };
                return (
                  <Flex align="center" justify="space-between" gap={8}>
                    <Flex align="center" gap={6}>
                      <AccountAvatar accountId={item.value ?? item.id} accounts={accounts} size={20} />
                      {item.state && <AccountStatusDot state={item.state} />}
                      <Typography.Text>{item.label ?? ""}</Typography.Text>
                    </Flex>
                    {item.id && (
                      <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                        {item.id}
                      </Typography.Text>
                    )}
                  </Flex>
                );
              }}
            />
          </Form.Item>

          <Flex gap={12} wrap>
            <Form.Item name={["leader", "model"]} label="Model (optional)" style={{ flex: "1 1 260px" }}>
              <ModelSelect accountId={leaderAccount} />
            </Form.Item>
            <Form.Item name={["leader", "effort"]} label="Effort" style={{ flex: "1 1 140px" }}>
              <Select options={EFFORT_OPTIONS} />
            </Form.Item>
          </Flex>

          <Form.Item
            name={["leader", "instructions"]}
            label="Leader instructions"
            rules={[{ max: 8000, message: "Maximum 8000 characters" }]}
          >
            <Input.TextArea
              placeholder="You lead the iOS team. SwiftUI and TCA, iOS 17+. Keep tasks small; send UI work to mobile-engineer and tests to test-engineer."
              maxLength={8000}
              showCount
              autoSize={{ minRows: 4, maxRows: 12 }}
            />
          </Form.Item>
        </Card>

        <Card size="small" title="Members" style={{ marginBottom: 16 }}>
          <Form.List
            name="members"
            rules={[
              {
                validator: async (_, members) => {
                  if (!members || members.length < 1) {
                    return Promise.reject(new Error("Add at least one member"));
                  }
                  const seen = new Set<string>();
                  for (const m of members) {
                    if (!m?.account) continue;
                    if (seen.has(m.account)) {
                      return Promise.reject(new Error(`Duplicate member account: ${m.account}`));
                    }
                    seen.add(m.account);
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            {(fields, { add, remove }, { errors }) => (
              <Flex vertical gap={12}>
                {fields.map((field) => (
                  <Card key={field.key} size="small" type="inner">
                    <Flex vertical gap={8}>
                      <Flex justify="space-between" align="center">
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          Member #{field.name + 1}
                        </Typography.Text>
                        {fields.length > 1 && (
                          <Button
                            type="text"
                            danger
                            size="small"
                            icon={<DeleteOutlined />}
                            onClick={() => remove(field.name)}
                          />
                        )}
                      </Flex>

                      <Form.Item
                        {...field}
                        name={[field.name, "account"]}
                        label="Account"
                        rules={[{ required: true, message: "Select account" }]}
                        style={{ marginBottom: 8 }}
                      >
                        <Select
                          options={accountGroups}
                          labelRender={(props) => (
                            <Flex align="center" gap={6}>
                              <AccountAvatar accountId={String(props.value)} accounts={accounts} size={20} />
                              <span>{props.label}</span>
                            </Flex>
                          )}
                          optionRender={(option) => {
                            const item = option.data as unknown as { value?: string; label?: string; id?: string; state?: Account["status"]["state"] };
                            return (
                              <Flex align="center" justify="space-between" gap={8}>
                                <Flex align="center" gap={6}>
                                  <AccountAvatar accountId={item.value ?? item.id} accounts={accounts} size={20} />
                                  {item.state && <AccountStatusDot state={item.state} />}
                                  <Typography.Text>{item.label ?? ""}</Typography.Text>
                                </Flex>
                                {item.id && (
                                  <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                                    {item.id}
                                  </Typography.Text>
                                )}
                              </Flex>
                            );
                          }}
                        />
                      </Form.Item>

                      <Form.Item
                        {...field}
                        name={[field.name, "roles"]}
                        label="Allowed roles (empty = any role)"
                        style={{ marginBottom: 8 }}
                      >
                        <Select
                          mode="multiple"
                          allowClear
                          placeholder="Any role"
                          options={roles.map((r) => ({ value: r.id, label: r.name }))}
                        />
                      </Form.Item>

                      <Form.Item
                        {...field}
                        name={[field.name, "notes"]}
                        label="Notes"
                        style={{ marginBottom: 0 }}
                      >
                        <Input placeholder="Notes (e.g. mobile specialist, test runner)" />
                      </Form.Item>
                    </Flex>
                  </Card>
                ))}

                <Button
                  type="dashed"
                  onClick={() => add({ account: accounts[0]?.id ?? "agy", roles: [], notes: "" })}
                  block
                  icon={<PlusOutlined />}
                >
                  Add member
                </Button>
                <Form.ErrorList errors={errors} />
              </Flex>
            )}
          </Form.List>
        </Card>

        <Form.Item name="preset" label="Preset">
          <Select
            options={[
              { value: "__default__", label: "Default preset" },
              { value: "none", label: "No preset" },
              ...presets.map((p) => ({ value: p.id, label: p.title })),
            ]}
          />
        </Form.Item>

        <Form.Item
          name="workspace"
          label="Default workspace"
          rules={[
            {
              validator: (_, value: string) => {
                if (!value || value.trim() === "") return Promise.resolve();
                if (!value.trim().startsWith("/")) {
                  return Promise.reject(new Error("Use an absolute path starting with /"));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <AutoComplete
            options={workspaces.map((w) => ({ value: w }))}
            filterOption={(input, option) => (option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            placeholder="/Users/you/project"
          />
        </Form.Item>

        <Form.Item
          name="maxParallel"
          label="Max parallel tasks"
          help="Developers working at the same time in one folder can overwrite each other's changes."
        >
          <InputNumber min={1} max={4} defaultValue={1} />
        </Form.Item>

        <Form.Item
          name="review"
          valuePropName="checked"
          label="Leader reviews the result"
          help="Costs extra leader tokens."
        >
          <Switch />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
