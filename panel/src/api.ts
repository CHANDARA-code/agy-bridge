export type TaskStatus = "running" | "completed" | "failed" | "cancelled" | "stale";

export interface Task {
  id: string;
  role: string;
  workspace: string;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
  status: TaskStatus;
  exitCode: string | null;
  sizeBytes: number;
  cancellable: boolean;
  cancelRequested: boolean;
  error: string | null;
  preset?: string | null;
  preferences?: string[];
  promptPreview?: string;
  prompt?: string;
  account?: string | null;
  provider?: string | null;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface RolesResponse {
  roles: Role[];
  modes: string[];
  efforts: string[];
}

export interface Health {
  status: string;
  uptimeSeconds: number;
  running: number;
  pid: number;
}

export interface DispatchInput {
  role: string;
  workspace: string;
  prompt: string;
  mode: string;
  effort: string;
  preset?: string | null;
  account?: string;
}

export interface PresetFileSummary {
  name: string;
  roles: string[] | null;
}

export interface PresetSummary {
  id: string;
  title: string;
  description: string;
  isDefault: boolean;
  files: PresetFileSummary[];
}

export interface PresetFile {
  name: string;
  content: string;
}

export interface Preset extends Omit<PresetSummary, "files"> {
  files: (PresetFile & { roles: string[] | null })[];
}

export interface PresetsResponse {
  presets: PresetSummary[];
  templates: Omit<PresetSummary, "isDefault">[];
  defaultPreset: string | null;
}

export interface CreatePresetInput {
  id: string;
  title?: string;
  template?: string;
  from?: string;
}

export interface PromptPreview {
  prompt: string;
  preset: string | null;
  files: { name: string; source: "preset" | "workspace" }[];
}

export type ProviderId = "agy" | "claude" | "codex";

export type AccountState = "signed-in" | "signed-out" | "unknown" | "error";

export interface AccountStatus {
  state: AccountState;
  detail: string;
  email: string | null;
  plan: string | null;
  checkedAt: string | null;
  warning: string | null;
}

export interface AccountUsage {
  tasks: number;
  total_tokens: number;
}

export interface WindowLimit {
  name: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface AccountLimits {
  checkedAt: string;
  status: "ok" | "limited" | "unknown";
  detail: string | null;
  windows: WindowLimit[];
}

export interface AccountBudget {
  period: "day" | "week" | "month";
  tokens: number;
  stop: boolean;
}

export interface BudgetUsed {
  tokens: number;
  percent: number;
  periodStart: string;
}

export interface AccountUsageEntry {
  id: string;
  provider: ProviderId;
  label: string;
  system: boolean;
  identity?: AccountIdentity | null;
  avatarUrl?: string | null;
  totals: {
    tasks: number;
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  today: {
    tasks: number;
    total_tokens: number;
  };
  last7d: {
    tasks: number;
    total_tokens: number;
  };
  byDay: {
    date: string;
    tasks: number;
    total_tokens: number;
  }[];
  byRole: {
    role: string;
    tasks: number;
    total_tokens: number;
  }[];
  byModel: {
    model: string;
    tasks: number;
    total_tokens: number;
    cost_usd: number;
  }[];
  lastUsedAt: string | null;
  limits: AccountLimits | null;
  budget: AccountBudget | null;
  budgetUsed: BudgetUsed | null;
}

export interface AccountUsageReport {
  days: number;
  from: string;
  to: string;
  generatedAt: string;
  totals: {
    tasks: number;
    total_tokens: number;
    cost_usd: number;
  };
  accounts: AccountUsageEntry[];
}

export interface Account {
  id: string;
  provider: ProviderId;
  label: string;
  system: boolean;
  model: string | null;
  createdAt: string | null;
  signedInHere: boolean;
  status: AccountStatus;
  usage: AccountUsage;
  budget?: AccountBudget | null;
  limits?: AccountLimits | null;
  avatarUrl?: string | null;
  identity?: AccountIdentity | null;
}

export interface AccountIdentity {
  name: string | null;
  email: string | null;
  plan: string | null;
  source: "codex-token" | "google" | "claude-status";
  fetchedAt: string;
}

const AUTO_LABEL = /^(Antigravity|Claude|Claude Code|Codex) account \d+$/;

type NamedAccount = Pick<Account, "id" | "label"> & {
  system?: boolean;
  identity?: AccountIdentity | null;
  status?: { email?: string | null } | null;
};

export function accountDisplayName(account: NamedAccount): string {
  const custom = !account.system && account.label && account.label !== account.id && !AUTO_LABEL.test(account.label);
  if (custom) return account.label;
  return account.identity?.name || account.identity?.email || account.status?.email || account.label || account.id;
}

export function accountEmail(account: Account): string | null {
  return account.identity?.email || account.status?.email || null;
}

export type LoginMethod = "browser" | "device" | "terminal";

export interface Provider {
  id: ProviderId;
  name: string;
  installed: boolean;
  bin: string;
  loginMethods: LoginMethod[];
  canLogout: boolean;
  iconUrl?: string | null;
}

export type LoginState = "starting" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface LoginSession {
  id: string;
  accountId: string;
  method: LoginMethod;
  state: LoginState;
  url: string | null;
  code: string | null;
  needsCode: boolean;
  verifying?: boolean;
  command: string;
  terminalOpened: boolean;
  output: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TeamLeader {
  account: string;
  model: string | null;
  effort: string;
  instructions: string;
}

export interface TeamMember {
  account: string;
  roles: string[];
  notes: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  leader: TeamLeader;
  members: TeamMember[];
  preset: string | null;
  workspace: string | null;
  maxParallel: number;
  review: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TeamRunMode = "plan" | "accept-edits";

export type TeamRunStatus =
  | "planning"
  | "planned"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export type TeamRunTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface TeamRunTask {
  id: string;
  title: string;
  assignee: string;
  role: string;
  prompt: string;
  acceptance_criteria: string[];
  verification_command: string | null;
  depends_on: string[];
  status: TeamRunTaskStatus;
  taskId: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TeamRunReview {
  taskId: string;
  status: string;
  output: string;
}

export interface TeamRun {
  id: string;
  teamId: string;
  teamName: string;
  goal: string;
  workspace: string;
  mode: TeamRunMode;
  status: TeamRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  leader: {
    account: string;
    taskId: string | null;
  };
  summary: string | null;
  tasks: TeamRunTask[];
  review: TeamRunReview | null;
  usage: {
    total_tokens: number;
  };
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="a2a-token"]')?.content ?? "";
  if (meta && meta !== "__A2A_TOKEN__") return meta;
  return import.meta.env.VITE_A2A_TOKEN ?? "";
}

async function request<T>(path: string, init: RequestInit = {}, parse: "json" | "text" = "json"): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("X-A2A-Token", readToken());
    if (init.body) headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("Server unreachable", 0);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) message = String(body.error);
    } catch {}
    throw new ApiError(message, response.status);
  }
  return (parse === "text" ? response.text() : response.json()) as Promise<T>;
}

export type UpdateStateName = "idle" | "installing" | "restarting" | "installed" | "failed";

export interface VersionInfo {
  name: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checksEnabled: boolean;
  checkedAt: string | null;
  error: string | null;
  install: "npm-global" | "source" | "other" | null;
  canUpdate: boolean;
  command: string | null;
  notesUrl: string | null;
  restart: "service" | "pid-file" | "manual";
  update: {
    state: UpdateStateName;
    version: string | null;
    output: string;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
}

export interface AccountModel {
  id: string;
  name: string;
  description?: string;
}

export interface AccountModels {
  account: string;
  provider: ProviderId;
  models: AccountModel[];
  source: string;
  fetchedAt: string;
  error: string | null;
}

export interface TeamTemplate {
  id: string;
  title: string;
  description: string;
  leader: { provider: ProviderId; effort: string; instructions: string };
  members: { provider: ProviderId; roles: string[]; notes: string }[];
  maxParallel: number;
  review: boolean;
}

export interface TeamDraft {
  id: string;
  name: string;
  description: string;
  leader: { account: string; model: string | null; effort: string; instructions: string };
  members: TeamMember[];
  maxParallel: number;
  review: boolean;
  template: string;
}

export const api = {
  health: () => request<Health>("/api/health"),
  version: (refresh = false) => request<VersionInfo>(`/api/version${refresh ? "?refresh=1" : ""}`),
  startUpdate: () => request<VersionInfo>("/api/update", { method: "POST" }),
  roles: () => request<RolesResponse>("/api/roles"),
  workspaces: () => request<{ workspaces: string[] }>("/api/workspaces").then((r) => r.workspaces),
  tasks: () => request<{ tasks: Task[] }>("/api/tasks").then((r) => r.tasks),
  task: (id: string) => request<{ task: Task }>(`/api/tasks/${id}`).then((r) => r.task),
  log: (id: string) => request<string>(`/api/tasks/${id}/log`, {}, "text"),
  dispatch: (input: DispatchInput) =>
    request<{ taskId: string }>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  cancel: (id: string) => request<{ id: string; status: string }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  presets: () => request<PresetsResponse>("/api/presets"),
  preset: (id: string) => request<{ preset: Preset }>(`/api/presets/${id}`).then((r) => r.preset),
  createPreset: (input: CreatePresetInput) =>
    request<{ preset: Preset }>("/api/presets", { method: "POST", body: JSON.stringify(input) }).then((r) => r.preset),
  savePreset: (id: string, input: { title: string; description: string; files: PresetFile[] }) =>
    request<{ preset: Preset }>(`/api/presets/${id}`, { method: "PUT", body: JSON.stringify(input) }).then((r) => r.preset),
  deletePreset: (id: string) => request<{ deleted: string }>(`/api/presets/${id}`, { method: "DELETE" }),
  setDefaultPreset: (id: string, isDefault: boolean) =>
    request<{ defaultPreset: string | null }>(`/api/presets/${id}/default`, { method: isDefault ? "POST" : "DELETE" }),
  previewPrompt: (input: { role: string; workspace: string; prompt: string; preset: string | null }) =>
    request<PromptPreview>("/api/prompt-preview", { method: "POST", body: JSON.stringify(input) }),
  accounts: () => request<{ accounts: Account[]; providers: Provider[] }>("/api/accounts"),
  accountModels: (id: string, refresh = false) =>
    request<AccountModels>(`/api/accounts/${encodeURIComponent(id)}/models${refresh ? "?refresh=1" : ""}`),
  setAvatar: (id: string, image: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/avatar`, { method: "PUT", body: JSON.stringify({ image }) }).then((r) => r.account),
  deleteAvatar: (id: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/avatar`, { method: "DELETE" }).then((r) => r.account),
  setAccountAvatar: (id: string, image: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/avatar`, { method: "PUT", body: JSON.stringify({ image }) }).then((r) => r.account),
  deleteAccountAvatar: (id: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/avatar`, { method: "DELETE" }).then((r) => r.account),
  createAccount: (input: { id: string; provider: ProviderId; label?: string; model?: string | null }) =>
    request<{ account: Account }>("/api/accounts", { method: "POST", body: JSON.stringify(input) }).then((r) => r.account),
  updateAccount: (id: string, input: { label?: string; model?: string | null }) =>
    request<{ account: Account }>(`/api/accounts/${id}`, { method: "PUT", body: JSON.stringify(input) }).then((r) => r.account),
  deleteAccount: (id: string) => request<{ deleted: string }>(`/api/accounts/${id}`, { method: "DELETE" }),
  checkAccount: (id: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/check`, { method: "POST" }).then((r) => r.account),
  loginAccount: (id: string, method: LoginMethod) =>
    request<{ login: LoginSession }>(`/api/accounts/${id}/login`, { method: "POST", body: JSON.stringify({ method }) }).then((r) => r.login),
  logoutAccount: (id: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/logout`, { method: "POST" }).then((r) => r.account),
  getLoginSession: (loginId: string) =>
    request<{ login: LoginSession }>(`/api/accounts/logins/${loginId}`).then((r) => r.login),
  submitLoginCode: (loginId: string, code: string) =>
    request<{ login: LoginSession }>(`/api/accounts/logins/${loginId}/code`, { method: "POST", body: JSON.stringify({ code }) }).then((r) => r.login),
  cancelLoginSession: (loginId: string) =>
    request<{ login: LoginSession }>(`/api/accounts/logins/${loginId}/cancel`, { method: "POST" }).then((r) => r.login),
  usage: (days = 30) => request<AccountUsageReport>(`/api/usage/accounts?days=${days}`),
  setBudget: (id: string, budget: AccountBudget) =>
    request<{ account: Account }>(`/api/accounts/${id}/budget`, { method: "PUT", body: JSON.stringify(budget) }).then((r) => r.account),
  deleteBudget: (id: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/budget`, { method: "DELETE" }).then((r) => r.account),
  setAccountBudget: (id: string, budget: AccountBudget) =>
    request<{ account: Account }>(`/api/accounts/${id}/budget`, { method: "PUT", body: JSON.stringify(budget) }).then((r) => r.account),
  deleteAccountBudget: (id: string) =>
    request<{ account: Account }>(`/api/accounts/${id}/budget`, { method: "DELETE" }).then((r) => r.account),
  teams: () => request<{ teams: Team[] }>("/api/teams").then((r) => r.teams),
  teamTemplates: () => request<{ templates: TeamTemplate[] }>("/api/team-templates").then((r) => r.templates),
  teamTemplateDraft: (id: string) => request<{ team: TeamDraft }>(`/api/team-templates/${encodeURIComponent(id)}/draft`).then((r) => r.team),
  team: (id: string) => request<{ team: Team }>(`/api/teams/${id}`).then((r) => r.team),
  createTeam: (input: Omit<Team, "createdAt" | "updatedAt">) =>
    request<{ team: Team }>("/api/teams", { method: "POST", body: JSON.stringify(input) }).then((r) => r.team),
  updateTeam: (id: string, input: Partial<Omit<Team, "id" | "createdAt" | "updatedAt">>) =>
    request<{ team: Team }>(`/api/teams/${id}`, { method: "PUT", body: JSON.stringify(input) }).then((r) => r.team),
  deleteTeam: (id: string) => request<{ deleted: string }>(`/api/teams/${id}`, { method: "DELETE" }),
  runTeam: (id: string, input: { goal: string; workspace: string; mode: TeamRunMode }) =>
    request<{ run: TeamRun }>(`/api/teams/${id}/runs`, { method: "POST", body: JSON.stringify(input) }).then((r) => r.run),
  teamRuns: (teamId?: string) =>
    request<{ runs: TeamRun[] }>(teamId ? `/api/team-runs?team=${encodeURIComponent(teamId)}` : "/api/team-runs").then((r) => r.runs),
  teamRun: (runId: string) => request<{ run: TeamRun }>(`/api/team-runs/${runId}`).then((r) => r.run),
  executeTeamRun: (runId: string) =>
    request<{ run: TeamRun }>(`/api/team-runs/${runId}/execute`, { method: "POST" }).then((r) => r.run),
  cancelTeamRun: (runId: string) =>
    request<{ run: TeamRun }>(`/api/team-runs/${runId}/cancel`, { method: "POST" }).then((r) => r.run),
};
