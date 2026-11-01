import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, App as AntApp, Button, Card, Flex, Input, InputNumber, Skeleton, Switch, Tag, Tooltip, Typography } from "antd";
import { UndoOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { SettingEntry, SettingValue } from "../api";
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
        step={factor === 1 ? 1 : 0.5}
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

export function SettingsView({ isMobile }: SettingsViewProps) {
  const { message } = AntApp.useApp();
  const [entries, setEntries] = useState<SettingEntry[] | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState<Group | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  }, [load]);

  useServerEvent("settings", () => load());

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

  if (loadError && !entries) return <Alert type="error" showIcon message="Could not load settings" description={loadError} />;
  if (!entries) return <Skeleton active />;

  const limitKeys = entries.filter((entry) => entry.group === "limits").map((entry) => entry.key);
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
    </Flex>
  );
}
