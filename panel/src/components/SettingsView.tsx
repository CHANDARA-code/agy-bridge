import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, App as AntApp, Badge, Button, Card, Flex, Input, InputNumber, Skeleton, Switch, Tag, Tooltip, Typography } from "antd";
import { SearchOutlined, SendOutlined, UndoOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { SettingEntry, SettingValue, TelegramChat, TelegramStatus } from "../api";
import { useServerEvent } from "../events";

interface SettingsViewProps {
  isMobile: boolean;
}

type Group = SettingEntry["group"];
type Draft = Record<string, SettingValue>;

const DISPLAY_UNITS: Record<string, { unit: string; factor: number }> = {
  A2A_TASK_TIMEOUT_MS: { unit: "min", factor: 60000 },
  A2A_IDLE_TIMEOUT_MS: { unit: "min", factor: 60000 },
  A2A_VERIFY_TIMEOUT_MS: { unit: "min", factor: 60000 },
  A2A_KILL_ESCALATION_MS: { unit: "s", factor: 1000 },
  A2A_LOG_RETENTION_DAYS: { unit: "days", factor: 1 },
  A2A_MAX_CONCURRENT: { unit: "agents", factor: 1 },
  A2A_MAX_OUTPUT_CHARS: { unit: "chars", factor: 1 },
};

const PLACEHOLDERS: Record<string, string> = {
  A2A_NPM_BIN: "Empty uses the npm next to Node.js",
  A2A_TELEGRAM_BOT_TOKEN: "123456789:AAH...",
  A2A_TELEGRAM_CHAT_ID: "123456789",
  A2A_TELEGRAM_ALLOWED_USER_IDS: "111111111, 222222222",
  A2A_TELEGRAM_WORKSPACE: "/Users/you/projects/my-app",
};

const STATUS_BADGES: Record<TelegramStatus["state"], "success" | "processing" | "warning" | "error" | "default"> = {
  listening: "success",
  starting: "processing",
  retrying: "warning",
  error: "error",
  incomplete: "default",
  off: "default",
};

const unitOf = (entry: SettingEntry) => DISPLAY_UNITS[entry.key] ?? { unit: entry.unit ?? "", factor: 1 };

function describeDefault(entry: SettingEntry) {
  if (entry.type === "bool") return `Default: ${entry.default ? "on" : "off"}.`;
  if (entry.type === "int") {
    const { unit, factor } = unitOf(entry);
    const value = Number(entry.default) / factor;
    return `Default: ${value === 0 ? "0 (off)" : `${value.toLocaleString()} ${unit}`}.`;
  }
  if (typeof entry.default === "string" && entry.default) return `Default: ${entry.default}.`;
  return "";
}

const isDirty = (entry: SettingEntry, value: SettingValue | undefined) =>
  value !== undefined && (entry.type === "secret" ? value !== "" : value !== entry.value);

function draftFrom(entries: SettingEntry[], previous: SettingEntry[], current: Draft): Draft {
  const before = new Map(previous.map((entry) => [entry.key, entry]));
  const next: Draft = {};
  for (const entry of entries) {
    const old = before.get(entry.key);
    next[entry.key] = old && isDirty(old, current[entry.key]) ? current[entry.key] : entry.value;
  }
  return next;
}

function SourceTag({ entry }: { entry: SettingEntry }) {
  if (entry.source === "env") {
    return (
      <Tooltip title={`Set by the environment variable ${entry.key} where the server starts. Change or remove it there.`}>
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>Environment</Tag>
      </Tooltip>
    );
  }
  if (entry.source === "file") return <Tag color="blue" style={{ marginInlineEnd: 0 }}>Changed</Tag>;
  return null;
}

interface FieldProps {
  entry: SettingEntry;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
  onReset: () => void;
  extra?: ReactNode;
}

function SettingField({ entry, value, onChange, onReset, extra }: FieldProps) {
  const locked = entry.source === "env";
  let input: ReactNode;
  if (entry.type === "bool") {
    input = <Switch checked={Boolean(value)} disabled={locked} onChange={onChange} aria-label={entry.label} />;
  } else if (entry.type === "int") {
    const { unit, factor } = unitOf(entry);
    input = (
      <InputNumber
        value={Math.round((Number(value) / factor) * 100) / 100}
        min={entry.min !== undefined ? entry.min / factor : undefined}
        max={entry.max !== undefined ? entry.max / factor : undefined}
        precision={factor === 1 ? 0 : undefined}
        step={1}
        disabled={locked}
        addonAfter={unit || undefined}
        aria-label={entry.label}
        style={{ width: "100%", maxWidth: 240 }}
        onChange={(next) => {
          if (typeof next === "number") onChange(Math.round(next * factor));
        }}
      />
    );
  } else if (entry.type === "secret") {
    input = (
      <Input.Password
        value={String(value)}
        disabled={locked}
        autoComplete="off"
        aria-label={entry.label}
        placeholder={entry.isSet ? "Saved. Type a new token to replace it" : PLACEHOLDERS[entry.key]}
        onChange={(event) => onChange(event.target.value.trim())}
      />
    );
  } else {
    input = (
      <Input
        value={String(value)}
        disabled={locked}
        aria-label={entry.label}
        placeholder={PLACEHOLDERS[entry.key]}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Flex vertical gap={6}>
      <Flex align="center" gap={8} wrap>
        <Typography.Text strong>{entry.label}</Typography.Text>
        <SourceTag entry={entry} />
        {entry.source === "file" && (
          <Button size="small" type="link" icon={<UndoOutlined />} onClick={onReset} style={{ paddingInline: 0 }}>
            Use default
          </Button>
        )}
      </Flex>
      <Flex align="center" gap={8} wrap>
        {input}
        {extra}
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {entry.help} {describeDefault(entry)}
      </Typography.Text>
    </Flex>
  );
}

function StepTitle({ index, children }: { index: number; children: ReactNode }) {
  return (
    <Typography.Title level={5} style={{ margin: 0 }}>
      {index}. {children}
    </Typography.Title>
  );
}

export function SettingsView({ isMobile }: SettingsViewProps) {
  const { message } = AntApp.useApp();
  const [entries, setEntries] = useState<SettingEntry[] | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState<Group | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [testing, setTesting] = useState(false);
  const entriesRef = useRef<SettingEntry[]>([]);
  const draftRef = useRef<Draft>({});
  draftRef.current = draft;

  const load = useCallback(async () => {
    try {
      const next = await api.settings();
      const merged = draftFrom(next, entriesRef.current, draftRef.current);
      entriesRef.current = next;
      setEntries(next);
      setDraft(merged);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load settings");
    }
  }, []);

  useEffect(() => {
    load();
    api.telegramStatus().then(setStatus).catch(() => {});
  }, [load]);

  useServerEvent("settings", () => load());
  useServerEvent("telegram", (next: TelegramStatus) => setStatus(next));

  const byKey = useMemo(() => new Map((entries ?? []).map((entry) => [entry.key, entry])), [entries]);

  const change = (key: string, value: SettingValue) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async (group: Group, values: Record<string, SettingValue | null>) => {
    if (!Object.keys(values).length) return;
    setSaving(group);
    try {
      const next = await api.saveSettings(values);
      const merged = draftFrom(next, entriesRef.current, draftRef.current);
      for (const entry of next) if (entry.key in values) merged[entry.key] = entry.value;
      entriesRef.current = next;
      setEntries(next);
      setDraft(merged);
      message.success("Saved");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(null);
    }
  };

  const discard = (group: Group) =>
    setDraft((current) => {
      const next = { ...current };
      for (const entry of entriesRef.current) if (entry.group === group) next[entry.key] = entry.value;
      return next;
    });

  const changedIn = (group: Group) => {
    const values: Record<string, SettingValue> = {};
    for (const entry of entries ?? []) {
      if (entry.group === group && entry.source !== "env" && isDirty(entry, draft[entry.key])) values[entry.key] = draft[entry.key];
    }
    return values;
  };

  const field = (key: string, extra?: ReactNode) => {
    const entry = byKey.get(key);
    if (!entry) return null;
    return (
      <SettingField
        key={key}
        entry={entry}
        value={draft[key] ?? entry.value}
        onChange={(value) => change(key, value)}
        onReset={() => save(entry.group, { [key]: null })}
        extra={extra}
      />
    );
  };

  const groupFooter = (group: Group) => {
    const changed = changedIn(group);
    const count = Object.keys(changed).length;
    return (
      <Flex justify="flex-end" gap={8}>
        <Button disabled={!count} onClick={() => discard(group)}>
          Discard
        </Button>
        <Button type="primary" disabled={!count} loading={saving === group} onClick={() => save(group, changed)}>
          {count ? `Save ${count} change${count === 1 ? "" : "s"}` : "Saved"}
        </Button>
      </Flex>
    );
  };

  const typedToken = String(draft.A2A_TELEGRAM_BOT_TOKEN ?? "");
  const typedChat = String(draft.A2A_TELEGRAM_CHAT_ID ?? "");

  const findChats = async () => {
    setFinding(true);
    try {
      const found = await api.telegramDiscover(typedToken || undefined);
      setChats(found.chats);
      if (!found.chats.length) message.info(`No messages yet. Send /start to @${found.bot} in Telegram, then look again.`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Could not reach Telegram");
    } finally {
      setFinding(false);
    }
  };

  const pickChat = (chat: TelegramChat) => {
    setDraft((current) => ({
      ...current,
      A2A_TELEGRAM_CHAT_ID: chat.id,
      A2A_TELEGRAM_ALLOWED_USER_IDS: String(current.A2A_TELEGRAM_ALLOWED_USER_IDS ?? "") || chat.users.map((user) => user.id).join(","),
    }));
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const result = await api.telegramTest({ token: typedToken || undefined, chatId: typedChat || undefined });
      message.success(result.sent ? `@${result.bot} sent a test message to your chat` : `The token works for @${result.bot}. Add the chat id to send a message.`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  };

  if (loadError && !entries) return <Alert type="error" showIcon message="Could not load settings" description={loadError} />;
  if (!entries) return <Skeleton active />;

  const limitKeys = entries.filter((entry) => entry.group === "limits").map((entry) => entry.key);
  const tokenEntry = byKey.get("A2A_TELEGRAM_BOT_TOKEN");
  const hasToken = Boolean(typedToken || tokenEntry?.isSet);
  const statusText = (() => {
    if (!status) return "Checking…";
    if (status.state === "listening") return `Connected as @${status.bot}`;
    if (status.state === "starting") return "Connecting…";
    if (status.state === "retrying") return `Reconnecting: ${status.lastError ?? ""}`;
    if (status.state === "error") return status.lastError ?? "Problem";
    if (status.state === "incomplete") return "Needs the bot token and chat id";
    return "Off";
  })();

  const grid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 20 } as const;

  return (
    <Flex vertical gap={16}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Settings
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Saved in settings.json in your data folder. Changes apply right away, without a restart. A setting given as an environment variable wins and is shown read-only.
        </Typography.Text>
      </div>

      <Card title="Limits">
        <Flex vertical gap={20}>
          <div style={grid}>{limitKeys.map((key) => field(key))}</div>
          {groupFooter("limits")}
        </Flex>
      </Card>

      <Card title="Updates">
        <Flex vertical gap={20}>
          <div style={grid}>
            {field("A2A_UPDATE_CHECK")}
            {field("A2A_NPM_REGISTRY")}
            {field("A2A_NPM_BIN")}
          </div>
          {groupFooter("updates")}
        </Flex>
      </Card>

      <Card
        title="Telegram remote control"
        extra={<Badge status={status ? STATUS_BADGES[status.state] : "default"} text={isMobile ? undefined : statusText} />}
      >
        <Flex vertical gap={20}>
          {isMobile && <Badge status={status ? STATUS_BADGES[status.state] : "default"} text={statusText} />}
          {status && (status.state === "error" || status.state === "retrying") && status.lastError && (
            <Alert type={status.state === "error" ? "error" : "warning"} showIcon message={status.lastError} />
          )}
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            Check on your agents, start work and answer your team leader from your phone. The bot only listens to the one chat you pick, and a2a-panel asks Telegram for new messages itself, so no port is opened on your computer.
          </Typography.Paragraph>

          <Flex vertical gap={10}>
            <StepTitle index={1}>Create a bot</StepTitle>
            <Typography.Text>
              In Telegram, open <Typography.Link href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</Typography.Link>, send <Typography.Text code>/newbot</Typography.Text>, choose a name and a username that ends in <Typography.Text code>bot</Typography.Text>. BotFather answers with a token. Paste it here. Keep it secret: anyone with the token controls the bot.
            </Typography.Text>
            {field("A2A_TELEGRAM_BOT_TOKEN")}
          </Flex>

          <Flex vertical gap={10}>
            <StepTitle index={2}>Find your chat</StepTitle>
            <Typography.Text>
              Open your new bot in Telegram and press Start (or send it any message). For a group, add the bot to the group and send a message there. Then press Find my chat.
            </Typography.Text>
            <Flex gap={8} wrap>
              <Button icon={<SearchOutlined />} onClick={findChats} loading={finding} disabled={!hasToken || status?.state === "listening"}>
                Find my chat
              </Button>
              {status?.state === "listening" && (
                <Typography.Text type="secondary" style={{ alignSelf: "center" }}>
                  Already connected. Turn Telegram off and save to look for another chat.
                </Typography.Text>
              )}
            </Flex>
            {chats && chats.length > 0 && (
              <Flex vertical gap={8}>
                {chats.map((chat) => (
                  <Card key={chat.id} size="small">
                    <Flex justify="space-between" align={isMobile ? "stretch" : "center"} vertical={isMobile} gap={8}>
                      <div>
                        <Typography.Text strong>{chat.title || "Chat"}</Typography.Text>{" "}
                        <Tag style={{ marginInlineStart: 4 }}>{chat.type}</Tag>
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            Chat id {chat.id}
                            {chat.users.length ? ` · from ${chat.users.map((user) => `${user.name || "user"} (${user.id})`).join(", ")}` : ""}
                          </Typography.Text>
                        </div>
                      </div>
                      <Button type={typedChat === chat.id ? "primary" : "default"} onClick={() => pickChat(chat)}>
                        {typedChat === chat.id ? "Selected" : "Use this chat"}
                      </Button>
                    </Flex>
                  </Card>
                ))}
              </Flex>
            )}
            {field("A2A_TELEGRAM_CHAT_ID")}
          </Flex>

          <Flex vertical gap={10}>
            <StepTitle index={3}>Choose who may control it</StepTitle>
            <div style={grid}>
              {field("A2A_TELEGRAM_ALLOWED_USER_IDS")}
              {field("A2A_TELEGRAM_ALLOW_RUN")}
              {field("A2A_TELEGRAM_WORKSPACE")}
            </div>
          </Flex>

          <Flex vertical gap={10}>
            <StepTitle index={4}>Turn it on</StepTitle>
            <div style={grid}>
              {field("A2A_TELEGRAM_ENABLED")}
              {field("A2A_TELEGRAM_NOTIFY_TASKS")}
              {field("A2A_TELEGRAM_NOTIFY_RUNS")}
            </div>
          </Flex>

          <Flex justify="space-between" align={isMobile ? "stretch" : "center"} vertical={isMobile} gap={8}>
            <Button icon={<SendOutlined />} onClick={sendTest} loading={testing} disabled={!hasToken}>
              Send test message
            </Button>
            {groupFooter("telegram")}
          </Flex>

          <Alert
            type="info"
            showIcon
            message="Let your team leader listen"
            description={
              <Flex vertical gap={6}>
                <span>
                  Claude Code (after <Typography.Text code>a2a-panel init</Typography.Text>) and any other MCP client that runs <Typography.Text code>a2a-panel mcp</Typography.Text>, Antigravity included, get two tools:
                  <Typography.Text code>a2a_notify_user</Typography.Text> sends you a message, with answer buttons if it asks a question, and{" "}
                  <Typography.Text code>a2a_wait_for_user</Typography.Text> waits for your reply, a <Typography.Text code>/do</Typography.Text> message or a button tap.
                </span>
                <span>
                  Tell your leader, for example: "When you finish a step or need a decision, message me with a2a_notify_user and wait for my answer with a2a_wait_for_user."
                </span>
                {status && (
                  <Typography.Text type="secondary">
                    Inbox: {status.inbox} waiting{status.waiting ? " · a leader is listening now" : ""}
                  </Typography.Text>
                )}
              </Flex>
            }
          />
        </Flex>
      </Card>
    </Flex>
  );
}
