import { useState } from "react";
import { Button, Card, Empty, Flex, Popconfirm, Table, Tag, Tooltip, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { StopOutlined } from "@ant-design/icons";
import type { Task } from "../api";
import { formatAgo, formatDateTime } from "../format";
import { LiveDuration } from "./LiveDuration";
import { StatusTag } from "./StatusTag";
import { AccountAvatar } from "./AccountAvatar";

interface TaskListProps {
  tasks: Task[];
  loading: boolean;
  isMobile: boolean;
  cancelling: Set<string>;
  onOpen: (task: Task) => void;
  onCancel: (task: Task) => void;
}

function CancelButton({ task, busy, onCancel, compact }: { task: Task; busy: boolean; onCancel: (task: Task) => void; compact?: boolean }) {
  if (!task.cancellable || task.cancelRequested) return null;
  return (
    <Popconfirm
      title="Cancel this task?"
      description="The agent process will be stopped."
      okText="Cancel task"
      cancelText="Keep running"
      okButtonProps={{ danger: true }}
      onConfirm={() => onCancel(task)}
    >
      <Button
        danger
        size={compact ? "middle" : "small"}
        icon={<StopOutlined />}
        loading={busy}
        onClick={(event) => event.stopPropagation()}
        style={compact ? undefined : { height: 28 }}
      >
        Cancel
      </Button>
    </Popconfirm>
  );
}

const MOBILE_PAGE_SIZE = 20;

export function TaskList({ tasks, loading, isMobile, cancelling, onOpen, onCancel }: TaskListProps) {
  const [shown, setShown] = useState(MOBILE_PAGE_SIZE);

  if (isMobile) {
    if (!loading && tasks.length === 0) return <Empty description="No tasks match" />;
    return (
      <Flex vertical gap={10}>
        {tasks.slice(0, shown).map((task) => (
          <Card key={task.id} size="small" hoverable onClick={() => onOpen(task)} styles={{ body: { padding: 14 } }}>
            <Flex justify="space-between" align="center" gap={8}>
              <StatusTag task={task} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatAgo(task.startedAt)} · <LiveDuration task={task} />
              </Typography.Text>
            </Flex>
            <Flex align="center" gap={6} wrap style={{ marginTop: 8 }}>
              <Typography.Text strong>{task.role}</Typography.Text>
              <Tag style={{ marginInlineEnd: 0, display: "inline-flex", alignItems: "center", gap: 6, paddingInline: 6 }}>
                <AccountAvatar accountId={task.account ?? "agy"} size={20} />
                <span>{task.account ?? "agy"}</span>
              </Tag>
              {task.preset && <Tag style={{ marginInlineEnd: 0 }}>{task.preset}</Tag>}
            </Flex>
            <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: "4px 0 0" }}>
              {task.promptPreview || "-"}
            </Typography.Paragraph>
            <Typography.Text type="secondary" ellipsis style={{ display: "block", fontSize: 12, marginTop: 4 }}>
              {task.workspace}
            </Typography.Text>
            {task.cancellable && !task.cancelRequested && (
              <div style={{ marginTop: 10 }}>
                <CancelButton task={task} busy={cancelling.has(task.id)} onCancel={onCancel} compact />
              </div>
            )}
          </Card>
        ))}
        {tasks.length > shown && (
          <Button block onClick={() => setShown((count) => count + MOBILE_PAGE_SIZE)}>
            Show more ({tasks.length - shown} remaining)
          </Button>
        )}
      </Flex>
    );
  }

  const columns: TableColumnsType<Task> = [
    { title: "Status", dataIndex: "status", width: 130, render: (_, task) => <StatusTag task={task} /> },
    {
      title: "Role",
      dataIndex: "role",
      width: 190,
      render: (_, task) => (
        <>
          <Typography.Text ellipsis style={{ display: "block" }}>{task.role}</Typography.Text>
          <Flex gap={4} wrap align="center" style={{ marginTop: 4 }}>
            <Tag style={{ marginInlineEnd: 0, display: "inline-flex", alignItems: "center", gap: 6, paddingInline: 6 }}>
              <AccountAvatar accountId={task.account ?? "agy"} size={20} />
              <span>{task.account ?? "agy"}</span>
            </Tag>
            {task.preset && (
              <Tooltip title={`Preset: ${task.preset}`}>
                <Tag style={{ marginInlineEnd: 0, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis" }}>{task.preset}</Tag>
              </Tooltip>
            )}
          </Flex>
        </>
      ),
    },
    {
      title: "Task",
      dataIndex: "promptPreview",
      render: (_, task) => (
        <>
          <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0 }}>
            {task.promptPreview || "-"}
          </Typography.Paragraph>
          <Typography.Text type="secondary" ellipsis style={{ display: "block", fontSize: 12, maxWidth: 420 }}>
            {task.workspace}
          </Typography.Text>
        </>
      ),
    },
    {
      title: "Started",
      dataIndex: "startedAt",
      width: 120,
      render: (value: string) => (
        <Tooltip title={formatDateTime(value)}>
          <span>{formatAgo(value)}</span>
        </Tooltip>
      ),
    },
    { title: "Duration", dataIndex: "durationMs", width: 100, render: (_: number | null, task: Task) => <LiveDuration task={task} /> },
    {
      title: "",
      key: "actions",
      width: 110,
      render: (_, task) => <CancelButton task={task} busy={cancelling.has(task.id)} onCancel={onCancel} />,
    },
  ];

  return (
    <Table<Task>
      rowKey="id"
      size="middle"
      columns={columns}
      dataSource={tasks}
      loading={loading}
      pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
      rowClassName="task-row"
      onRow={(task) => ({ onClick: () => onOpen(task) })}
      locale={{ emptyText: <Empty description="No tasks match" /> }}
    />
  );
}
