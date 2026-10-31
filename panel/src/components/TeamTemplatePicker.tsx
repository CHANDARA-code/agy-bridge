import { useEffect, useState } from "react";
import { App as AntApp, Card, Flex, Skeleton, Tag, Typography, theme } from "antd";
import { FileAddOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { TeamDraft, TeamTemplate } from "../api";
import { ProviderIcon } from "./ProviderIcon";

interface TeamTemplatePickerProps {
  selected: string | null;
  onPick: (draft: TeamDraft) => void;
  onBlank: () => void;
}

export function TeamTemplatePicker({ selected, onPick, onBlank }: TeamTemplatePickerProps) {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [templates, setTemplates] = useState<TeamTemplate[] | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    api.teamTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const pick = async (template: TeamTemplate) => {
    setLoadingId(template.id);
    try {
      onPick(await api.teamTemplateDraft(template.id));
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Could not load the template");
    } finally {
      setLoadingId(null);
    }
  };

  const cardStyle = (active: boolean) => ({
    height: "100%",
    cursor: "pointer",
    borderColor: active ? token.colorPrimary : undefined,
    boxShadow: active ? `0 0 0 1px ${token.colorPrimary}` : undefined,
  });

  if (templates === null) return <Skeleton active paragraph={{ rows: 3 }} />;

  return (
    <Flex vertical gap={8} style={{ marginBottom: 20 }}>
      <Typography.Text strong>Start from a template</Typography.Text>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        <Card size="small" hoverable style={cardStyle(selected === null)} onClick={onBlank}>
          <Flex vertical gap={4}>
            <Flex align="center" gap={6}>
              <FileAddOutlined />
              <Typography.Text strong>Blank team</Typography.Text>
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Choose the leader, members and roles yourself.
            </Typography.Text>
          </Flex>
        </Card>
        {templates.map((template) => {
          const roles = [...new Set(template.members.flatMap((member) => member.roles))];
          return (
            <Card
              key={template.id}
              size="small"
              hoverable
              loading={loadingId === template.id}
              style={cardStyle(selected === template.id)}
              onClick={() => pick(template)}
            >
              <Flex vertical gap={6}>
                <Flex align="center" justify="space-between" gap={6}>
                  <Typography.Text strong>{template.title}</Typography.Text>
                  <ProviderIcon providerId={template.leader.provider} size={14} />
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {template.description}
                </Typography.Text>
                <Flex wrap gap={4}>
                  {roles.map((role) => (
                    <Tag key={role} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {role}
                    </Tag>
                  ))}
                </Flex>
              </Flex>
            </Card>
          );
        })}
      </div>
    </Flex>
  );
}
