import { useEffect, useMemo, useState } from "react";
import { Button, Flex, Select, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { AccountModels } from "../api";

const MODEL_ID = /^[A-Za-z0-9~][\w.:/~@+\[\]-]{0,127}$/;

interface ModelSelectProps {
  accountId?: string | null;
  value?: string | null;
  onChange?: (value: string | null) => void;
  placeholder?: string;
}

export function ModelSelect({ accountId, value, onChange, placeholder = "Account default" }: ModelSelectProps) {
  const [result, setResult] = useState<AccountModels | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  const load = async (refresh = false) => {
    if (!accountId) return;
    setLoading(true);
    try {
      setResult(await api.accountModels(accountId, refresh));
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setResult(null);
    if (accountId) load();
  }, [accountId]);

  const options = useMemo(() => {
    const models = result?.models ?? [];
    const list = models.map((model) => ({
      value: model.id,
      searchText: `${model.name} ${model.id}`.toLowerCase(),
      label: (
        <Flex justify="space-between" align="center" gap={8}>
          <span>{model.name}</span>
          {model.name !== model.id && (
            <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
              {model.id}
            </Typography.Text>
          )}
        </Flex>
      ),
    }));
    const known = new Set(models.map((model) => model.id));
    if (value && !known.has(value)) {
      list.unshift({ value, searchText: value.toLowerCase(), label: <span>{value} (custom)</span> });
    }
    const typed = search.trim();
    if (typed && MODEL_ID.test(typed) && !known.has(typed) && typed !== value) {
      list.push({ value: typed, searchText: typed.toLowerCase(), label: <span>Use model id "{typed}"</span> });
    }
    return list;
  }, [result, value, search]);

  return (
    <Flex gap={6}>
      <Select
        style={{ flex: 1, minWidth: 0 }}
        showSearch
        allowClear
        popupMatchSelectWidth={false}
        value={value || undefined}
        placeholder={placeholder}
        loading={loading}
        options={options}
        onSearch={setSearch}
        onChange={(next) => {
          setSearch("");
          onChange?.(next ? String(next) : null);
        }}
        filterOption={(input, option) => Boolean(option && (option as { searchText: string }).searchText.includes(input.trim().toLowerCase()))}
        notFoundContent={
          loading ? "Loading models…" : result?.error ? result.error : "No models found. Type a model id to use it."
        }
      />
      <Tooltip title={result ? `Listed by "${result.source}". Refresh the list` : "Refresh the list"}>
        <Button icon={<ReloadOutlined />} loading={loading} disabled={!accountId} onClick={() => load(true)} aria-label="Refresh models" />
      </Tooltip>
    </Flex>
  );
}
