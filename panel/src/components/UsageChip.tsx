import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Flex, Popover, Progress, Typography, theme } from "antd";
import { DashboardOutlined } from "@ant-design/icons";
import { accountDisplayName, api } from "../api";
import type { AccountUsageEntry, AccountUsageReport } from "../api";
import { formatDurationUntil } from "../format";
import { useServerEvent } from "../events";
import { AccountAvatar } from "./AccountAvatar";

interface Pressure {
  percent: number;
  label: string;
  resetsAt: string | null;
}

function pressureOf(account: AccountUsageEntry): Pressure | null {
  const found: Pressure[] = [];
  for (const window of account.limits?.windows ?? []) {
    if (window.usedPercent !== null) found.push({ percent: window.usedPercent, label: window.label, resetsAt: window.resetsAt });
  }
  if (account.budgetUsed && account.budget) found.push({ percent: account.budgetUsed.percent, label: `${account.budget.period} budget`, resetsAt: null });
  if (account.limits?.status === "limited") found.push({ percent: 100, label: "limited", resetsAt: null });
  return found.sort((a, b) => b.percent - a.percent)[0] ?? null;
}

const formatTokens = (value: number) =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

export function UsageChip({ isMobile, onOpenUsage }: { isMobile: boolean; onOpenUsage: () => void }) {
  const { token } = theme.useToken();
  const [report, setReport] = useState<AccountUsageReport | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.usage(1).then(setReport).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useServerEvent("usage", () => load());

  const colorFor = (percent: number) => (percent >= 90 ? token.colorError : percent >= 70 ? token.colorWarning : token.colorSuccess);

  const rows = useMemo(
    () =>
      (report?.accounts ?? [])
        .map((account) => ({ account, pressure: pressureOf(account) }))
        .filter(({ account, pressure }) => pressure || account.today.total_tokens > 0)
        .sort((a, b) => (b.pressure?.percent ?? -1) - (a.pressure?.percent ?? -1) || b.account.today.total_tokens - a.account.today.total_tokens),
    [report],
  );

  if (!report) return null;

  const top = rows.find((row) => row.pressure);
  const todayTokens = report.accounts.reduce((sum, account) => sum + account.today.total_tokens, 0);
  const chipText = top?.pressure
    ? `${accountDisplayName(top.account)} · ${top.pressure.label} ${Math.round(top.pressure.percent)}%`
    : `Today ${formatTokens(todayTokens)} tokens`;

  const content = (
    <Flex vertical gap={12} style={{ width: isMobile ? 280 : 340 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Today: {formatTokens(todayTokens)} tokens across {report.accounts.reduce((sum, account) => sum + account.today.tasks, 0)} tasks
      </Typography.Text>
      {rows.length === 0 && <Typography.Text type="secondary">No usage today yet.</Typography.Text>}
      {rows.map(({ account, pressure }) => (
        <Flex key={account.id} vertical gap={4}>
          <Flex align="center" gap={8} justify="space-between">
            <Flex align="center" gap={8} style={{ minWidth: 0 }}>
              <AccountAvatar accountId={account.id} size={20} />
              <Typography.Text strong ellipsis style={{ maxWidth: 170 }}>{accountDisplayName(account)}</Typography.Text>
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {formatTokens(account.today.total_tokens)} today
            </Typography.Text>
          </Flex>
          {(account.limits?.windows ?? []).filter((window) => window.usedPercent !== null).map((window) => (
            <Flex key={window.name} align="center" gap={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12, width: 90 }}>{window.label}</Typography.Text>
              <Progress percent={Math.round(window.usedPercent ?? 0)} size="small" strokeColor={colorFor(window.usedPercent ?? 0)} style={{ flex: 1, margin: 0 }} />
              {window.resetsAt && (
                <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                  resets in {formatDurationUntil(window.resetsAt)}
                </Typography.Text>
              )}
            </Flex>
          ))}
          {account.budget && account.budgetUsed && (
            <Flex align="center" gap={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12, width: 90 }}>{account.budget.period} budget</Typography.Text>
              <Progress percent={Math.round(account.budgetUsed.percent)} size="small" strokeColor={colorFor(account.budgetUsed.percent)} style={{ flex: 1, margin: 0 }} />
            </Flex>
          )}
          {!pressure && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>No quota reported yet; it appears after this account runs a task.</Typography.Text>
          )}
        </Flex>
      ))}
      <Button
        size="small"
        onClick={() => {
          setOpen(false);
          onOpenUsage();
        }}
      >
        Open Usage
      </Button>
    </Flex>
  );

  const color = top?.pressure ? colorFor(top.pressure.percent) : undefined;

  return (
    <Popover content={content} title="Usage" trigger="click" open={open} onOpenChange={setOpen} placement="bottomRight">
      <Button
        icon={<DashboardOutlined style={color ? { color } : undefined} />}
        aria-label={`Usage: ${chipText}`}
        title={chipText}
        style={color && top?.pressure && top.pressure.percent >= 70 ? { borderColor: color } : undefined}
      >
        {isMobile ? (top?.pressure ? `${Math.round(top.pressure.percent)}%` : null) : <span style={{ display: "inline-block", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>{chipText}</span>}
      </Button>
    </Popover>
  );
}
