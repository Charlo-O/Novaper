// Adapted for Novaper integration.

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const value = error as { message?: string; error?: string };
    return value.message || value.error || 'Unknown error';
  }
  return 'Unknown error';
}

export interface AgentStatus {
  state: 'idle' | 'busy' | 'error' | 'initializing';
  created_at: number;
  last_used: number;
  error_message: string | null;
  model_name: string;
}

export interface Device {
  id: string;
  serial: string;
  model: string;
  status: string;
  connection_type: string;
  state: string;
  is_available_only: boolean;
  display_name: string | null;
  group_id: string;
  agent: AgentStatus | null;
}

export interface DeviceListResponse {
  devices: Device[];
}

export interface StatusResponse {
  version: string;
  initialized: boolean;
  step_count: number;
}

export interface ScreenshotResponse {
  success: boolean;
  image: string;
  width: number;
  height: number;
  is_sensitive: boolean;
  error?: string;
}

export interface ThinkingEvent {
  type: 'thinking';
  role: 'assistant';
  chunk: string;
}

export interface StepEvent {
  type: 'step';
  role: 'assistant';
  step: number;
  thinking: string;
  action: Record<string, unknown>;
  success: boolean;
  finished: boolean;
  screenshot?: string;
}

export interface DoneEvent {
  type: 'done';
  role: 'assistant';
  message: string;
  steps: number;
  success: boolean;
}

export interface ErrorEvent {
  type: 'error';
  role: 'assistant';
  message: string;
}

export interface CancelledEvent {
  type: 'cancelled';
  role: 'assistant';
  message: string;
}

export type StreamEvent =
  | ThinkingEvent
  | StepEvent
  | DoneEvent
  | ErrorEvent
  | CancelledEvent;

export interface TapResponse {
  success: boolean;
  error?: string;
}

export interface SwipeResponse {
  success: boolean;
  error?: string;
}

export interface TouchDownResponse {
  success: boolean;
  error?: string;
}

export interface TouchMoveResponse {
  success: boolean;
  error?: string;
}

export interface TouchUpResponse {
  success: boolean;
  error?: string;
}

export interface WiFiConnectRequest {
  device_id?: string | null;
  port?: number;
}

export interface WiFiConnectResponse {
  success: boolean;
  message: string;
  device_id?: string;
  address?: string;
  error?: string;
}

export interface WiFiDisconnectResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface WiFiManualConnectRequest {
  ip: string;
  port?: number;
}

export interface WiFiManualConnectResponse {
  success: boolean;
  message: string;
  device_id?: string;
  error?: string;
}

export interface WiFiPairRequest {
  ip: string;
  pairing_port: number;
  pairing_code: string;
  connection_port?: number;
}

export interface WiFiPairResponse {
  success: boolean;
  message: string;
  device_id?: string;
  error?: string;
}

export interface MdnsDevice {
  name: string;
  ip: string;
  port: number;
  has_pairing: boolean;
  service_type: string;
  pairing_port?: number;
}

export interface MdnsDiscoverResponse {
  success: boolean;
  devices: MdnsDevice[];
  error?: string;
}

export interface RemoteDeviceInfo {
  device_id: string;
  model: string;
  platform: string;
  status: string;
}

export interface RemoteDeviceDiscoverRequest {
  base_url: string;
  timeout?: number;
}

export interface RemoteDeviceDiscoverResponse {
  success: boolean;
  devices: RemoteDeviceInfo[];
  message: string;
  error?: string;
}

export interface RemoteDeviceAddRequest {
  base_url: string;
  device_id: string;
}

export interface RemoteDeviceAddResponse {
  success: boolean;
  message: string;
  serial?: string;
  error?: string;
}

export interface RemoteDeviceRemoveResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface ConfigResponse {
  vision_provider?: string;
  base_url: string;
  model_name: string;
  api_key: string;
  source: string;
  agent_type?: string;
  agent_config_params?: Record<string, unknown>;
  default_max_steps: number;
  layered_max_turns: number;
  decision_provider?: string;
  decision_base_url?: string;
  decision_model_name?: string;
  decision_api_key?: string;
}

export interface ConfigSaveRequest {
  vision_provider?: string;
  base_url: string;
  model_name: string;
  api_key?: string;
  agent_type?: string;
  agent_config_params?: Record<string, unknown>;
  default_max_steps?: number;
  layered_max_turns?: number;
  decision_provider?: string;
  decision_base_url?: string;
  decision_model_name?: string;
  decision_api_key?: string;
}

export interface ConfigSaveResponse {
  success: boolean;
  message: string;
  restart_required?: boolean;
  warnings?: string[];
}

export interface AuthStatusResponse {
  defaultProvider: 'api-key' | 'codex-oauth' | null;
  providers: {
    apiKey: {
      id: 'api-key';
      label: string;
      configured: boolean;
    };
    codexOAuth: {
      id: 'codex-oauth';
      label: string;
      authenticated: boolean;
      loginInProgress: boolean;
      accountId?: string;
      expiresAt?: string;
      authorizeUrl?: string;
      error?: string;
    };
  };
}

export interface CodexLoginResponse {
  authorizeUrl: string;
  startedAt: string;
}

export interface VersionCheckResponse {
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  release_url: string | null;
  published_at: string | null;
  error: string | null;
}

export interface QRPairGenerateResponse {
  success: boolean;
  qr_payload?: string;
  session_id?: string;
  expires_at?: number;
  message: string;
  error?: string;
}

export interface QRPairStatusResponse {
  session_id: string;
  status:
    | 'listening'
    | 'pairing'
    | 'paired'
    | 'connecting'
    | 'connected'
    | 'timeout'
    | 'error';
  device_id?: string;
  message: string;
  error?: string;
}

export interface QRPairCancelResponse {
  success: boolean;
  message: string;
}

export interface Workflow {
  uuid: string;
  name: string;
  text: string;
}

export interface WorkflowListResponse {
  workflows: Workflow[];
}

export interface WorkflowCreateRequest {
  name: string;
  text: string;
}

export interface WorkflowUpdateRequest {
  name: string;
  text: string;
}

export interface MessageRecordResponse {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  thinking?: string | null;
  action?: Record<string, unknown> | null;
  step?: number | null;
  screenshot?: string | null;
}

export interface HistoryRecordResponse {
  id: string;
  task_text: string;
  final_message: string;
  success: boolean;
  steps: number;
  start_time: string;
  end_time: string | null;
  duration_ms: number;
  source: 'chat' | 'layered' | 'scheduled';
  source_detail: string;
  error_message: string | null;
  messages: MessageRecordResponse[];
}

export interface HistoryListResponse {
  records: HistoryRecordResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScheduledTaskResponse {
  id: string;
  name: string;
  workflow_uuid: string;
  device_serialnos: string[];
  device_group_id?: string | null;
  cron_expression: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run_time: string | null;
  last_run_success: boolean | null;
  last_run_status?: 'success' | 'partial' | 'failure' | null;
  last_run_success_count?: number | null;
  last_run_total_count?: number | null;
  last_run_message: string | null;
  next_run_time: string | null;
}

export interface ScheduledTaskListResponse {
  tasks: ScheduledTaskResponse[];
}

export interface ScheduledTaskCreate {
  name: string;
  workflow_uuid: string;
  device_serialnos?: string[] | null;
  device_group_id?: string | null;
  cron_expression: string;
  enabled?: boolean;
}

export interface ScheduledTaskUpdate {
  name?: string;
  workflow_uuid?: string;
  device_serialnos?: string[] | null;
  device_group_id?: string | null;
  cron_expression?: string;
  enabled?: boolean;
}

export interface DeviceNameResponse {
  success: boolean;
  serial: string;
  display_name: string | null;
  error?: string;
}

export interface DeviceGroup {
  id: string;
  name: string;
  order: number;
  created_at: string;
  updated_at: string;
  is_default: boolean;
  device_count: number;
}

export interface DeviceGroupListResponse {
  groups: DeviceGroup[];
}

export interface DeviceGroupOperationResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface LayeredToolCallEvent {
  type: 'tool_call';
  tool_name: string;
  tool_args: Record<string, unknown>;
}

export interface LayeredToolResultEvent {
  type: 'tool_result';
  tool_name: string;
  result: string;
}

export interface LayeredMessageEvent {
  type: 'message';
  content: string;
}

export interface LayeredDoneEvent {
  type: 'done';
  content: string;
  success: boolean;
}

export interface LayeredErrorEvent {
  type: 'error';
  message: string;
}

type StoredDevice = {
  id: string;
  serial: string;
  model: string;
  connection_type: string;
  display_name: string | null;
  group_id: string;
  is_primary?: boolean;
};

type StoredConfig = ConfigResponse;

type QrSession = {
  sessionId: string;
  createdAt: number;
  cancelled: boolean;
};

type SessionMode = 'classic' | 'layered';

type LiveEventRecord = {
  id: string;
  sessionId: string;
  at: string;
  type:
    | 'status'
    | 'log'
    | 'tool_call'
    | 'tool_result'
    | 'computer_action'
    | 'screenshot'
    | 'error'
    | 'message'
    | 'agent_route';
  level: 'info' | 'warning' | 'error';
  message: string;
  payload?: unknown;
};

type LiveSessionSnapshot = {
  session: {
    id: string;
    model: string;
    authProvider?: 'api-key' | 'codex-oauth';
  };
  events: LiveEventRecord[];
};

type ToolCallPayload = {
  name: string;
  arguments: Record<string, unknown>;
};

const STORAGE_KEYS = {
  devices: 'novaper-ui-devices',
  config: 'novaper-ui-config',
  workflows: 'novaper-ui-workflows',
  history: 'novaper-ui-history',
  tasks: 'novaper-ui-scheduled-tasks',
  groups: 'novaper-ui-groups',
} as const;

const DEFAULT_VERSION = '0.1.0';
const DEFAULT_MODEL = 'gpt-5.4';
const primaryDeviceId = 'novaper-primary-device';
const qrSessions = new Map<string, QrSession>();
const liveSessionIds: Record<SessionMode, string | null> = {
  classic: null,
  layered: null,
};
let classicChatToken = 0;
let layeredChatToken = 0;

function hasWindow() {
  return typeof window !== 'undefined';
}

function nowIso() {
  return new Date().toISOString();
}

function uniqueId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId
    ? `${prefix}-${randomId}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readStorage<T>(key: string, fallback: T): T {
  if (!hasWindow()) {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  if (!hasWindow()) {
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
}

function removeStorage(key: string) {
  if (!hasWindow()) {
    return;
  }
  window.localStorage.removeItem(key);
}

function defaultAgentStatus(): AgentStatus {
  const now = Date.now();
  return {
    state: 'idle',
    created_at: now,
    last_used: now,
    error_message: null,
    model_name: DEFAULT_MODEL,
  };
}

function defaultConfig(): StoredConfig {
  return {
    vision_provider: 'custom',
    base_url: '',
    model_name: '',
    api_key: '',
    source: 'novaper-ui',
    agent_type: 'glm-async',
    agent_config_params: {},
    default_max_steps: 100,
    layered_max_turns: 50,
    decision_provider: 'custom',
    decision_base_url: '',
    decision_model_name: 'glm-4.7',
    decision_api_key: '',
  };
}

function defaultGroupsSeed() {
  const timestamp = nowIso();
  return [
    {
      id: 'default',
      name: 'Default',
      order: 0,
      created_at: timestamp,
      updated_at: timestamp,
      is_default: true,
    },
  ];
}

function readStoredGroups() {
  return readStorage(STORAGE_KEYS.groups, defaultGroupsSeed());
}

function writeStoredGroups(
  groups: Array<{
    id: string;
    name: string;
    order: number;
    created_at: string;
    updated_at: string;
    is_default: boolean;
  }>
) {
  writeStorage(STORAGE_KEYS.groups, groups);
}

function readStoredHistory() {
  return readStorage<Record<string, HistoryRecordResponse[]>>(
    STORAGE_KEYS.history,
    {}
  );
}

function writeStoredHistory(history: Record<string, HistoryRecordResponse[]>) {
  writeStorage(STORAGE_KEYS.history, history);
}

function readStoredTasks() {
  return readStorage<ScheduledTaskResponse[]>(STORAGE_KEYS.tasks, []);
}

function writeStoredTasks(tasks: ScheduledTaskResponse[]) {
  writeStorage(STORAGE_KEYS.tasks, tasks);
}

function readStoredWorkflows() {
  return readStorage<Workflow[]>(STORAGE_KEYS.workflows, []);
}

function writeStoredWorkflows(workflows: Workflow[]) {
  writeStorage(STORAGE_KEYS.workflows, workflows);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as {
        error?: string;
        detail?: string;
      };
      message = payload.error || payload.detail || message;
    } catch {
      // Ignore parse failures.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

function getStoredConfig() {
  return readStorage<StoredConfig>(STORAGE_KEYS.config, defaultConfig());
}

function getConfiguredModel(mode: SessionMode) {
  const config = getStoredConfig();
  if (mode === 'layered') {
    return (
      config.decision_model_name?.trim() ||
      config.model_name?.trim() ||
      DEFAULT_MODEL
    );
  }
  return config.model_name?.trim() || DEFAULT_MODEL;
}

function toDisplayText(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractMessageText(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function extractSummaryText(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const summary = (payload as { summary?: unknown }).summary;
  return typeof summary === 'string' ? summary : '';
}

function extractToolCall(payload: unknown, fallbackMessage: string): ToolCallPayload {
  const record =
    payload && typeof payload === 'object'
      ? (payload as { name?: unknown; arguments?: unknown })
      : undefined;
  const fallbackName =
    fallbackMessage.split(':').slice(1).join(':').trim() || 'tool';
  return {
    name: typeof record?.name === 'string' ? record.name : fallbackName,
    arguments:
      record?.arguments && typeof record.arguments === 'object'
        ? (record.arguments as Record<string, unknown>)
        : {},
  };
}

function usesCodexAuth(mode: SessionMode) {
  const config = getStoredConfig();
  return mode === 'layered'
    ? config.decision_provider === 'codex'
    : config.vision_provider === 'codex';
}

async function resolvePreferredAuthProvider(mode: SessionMode): Promise<
  'api-key' | 'codex-oauth'
> {
  const auth = await getAuthStatus();
  if (usesCodexAuth(mode)) {
    if (!auth.providers.codexOAuth.authenticated) {
      throw new Error('No auth provider is available. 请先去认证。');
    }
    return 'codex-oauth';
    throw new Error('No auth provider is available. 请先去认证。');
  }
  if (auth.providers.apiKey.configured) {
    return 'api-key';
  }
  if (auth.providers.codexOAuth.authenticated) {
    return 'codex-oauth';
  }
  throw new Error('No auth provider is available. 请先去认证。');
  throw new Error('No auth provider is available. 请先去认证。');
}

async function fetchSystemHealth(): Promise<{
  version?: string;
  machine?: { machineId?: string; interactiveSession?: boolean };
} | null> {
  try {
    return await fetchJson('/api/system/health');
  } catch {
    return null;
  }
}

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  return await fetchJson('/api/auth/status');
}

export async function startCodexOAuthLogin(): Promise<CodexLoginResponse> {
  return await fetchJson('/api/auth/codex/login', {
    method: 'POST',
  });
}

export async function logoutCodexOAuth(): Promise<AuthStatusResponse> {
  return await fetchJson('/api/auth/codex/logout', {
    method: 'POST',
  });
}

function mapStoredDevice(device: StoredDevice): Device {
  return {
    id: device.id,
    serial: device.serial,
    model: device.model,
    status: 'device',
    connection_type: device.connection_type,
    state: 'online',
    is_available_only: false,
    display_name: device.display_name,
    group_id: device.group_id || 'default',
    agent: defaultAgentStatus(),
  };
}

async function ensureDevicesSeeded(): Promise<StoredDevice[]> {
  const stored = readStorage<StoredDevice[]>(STORAGE_KEYS.devices, []);
  const health = await fetchSystemHealth();
  const machineId = health?.machine?.machineId || 'NOVAPER-DESKTOP';
  const primaryDevice: StoredDevice = {
    id: primaryDeviceId,
    serial: machineId,
    model: 'Novaper Device',
    connection_type: 'usb',
    display_name: 'Novaper Device',
    group_id: 'default',
    is_primary: true,
  };

  const devices = [...stored];
  const primaryIndex = devices.findIndex(device => device.id === primaryDeviceId);

  if (primaryIndex >= 0) {
    devices[primaryIndex] = {
      ...devices[primaryIndex],
      serial: machineId,
      model: devices[primaryIndex].model || primaryDevice.model,
      group_id: devices[primaryIndex].group_id || 'default',
      is_primary: true,
    };
  } else {
    devices.unshift(primaryDevice);
  }

  writeStorage(STORAGE_KEYS.devices, devices);
  return devices;
}

async function updateStoredDevices(
  updater: (devices: StoredDevice[]) => StoredDevice[] | Promise<StoredDevice[]>
) {
  const devices = await ensureDevicesSeeded();
  const nextDevices = await updater([...devices]);
  writeStorage(STORAGE_KEYS.devices, nextDevices);
  return nextDevices;
}

function placeholderScreenshot(message = 'Novaper') {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#e8f1ff" />
          <stop offset="100%" stop-color="#dbeafe" />
        </linearGradient>
      </defs>
      <rect width="720" height="1280" fill="url(#g)" />
      <rect x="84" y="120" width="552" height="1040" rx="32" fill="#ffffff" stroke="#bfdbfe" stroke-width="4" />
      <text x="360" y="300" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="44" fill="#1e3a8a">${message}</text>
      <text x="360" y="372" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#475569">UI compatibility preview</text>
      <circle cx="360" cy="672" r="84" fill="#eff6ff" stroke="#93c5fd" stroke-width="6" />
      <text x="360" y="688" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="28" fill="#2563eb">LIVE</text>
    </svg>
  `.trim();

  return btoa(unescape(encodeURIComponent(svg)));
}

async function blobToBase64(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () =>
      reject(reader.error || new Error('Failed to read blob.'));
    reader.readAsDataURL(blob);
  });
}

async function ensureLiveSession(
  mode: SessionMode,
  model: string,
  authProvider?: 'api-key' | 'codex-oauth'
) {
  if (liveSessionIds[mode]) {
    return liveSessionIds[mode];
  }

  const session = await fetchJson<{ id: string }>('/api/live-sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      authProvider,
    }),
  });
  liveSessionIds[mode] = session.id;
  return session.id;
}

async function observeLiveDesktop() {
  const sessionId = await ensureLiveSession('classic', DEFAULT_MODEL);
  if (!sessionId) {
    return null;
  }

  try {
    return await fetchJson<{
      screenshot?: { url?: string; width?: number; height?: number };
    }>(`/api/live-sessions/${sessionId}/observe`, {
      method: 'POST',
    });
  } catch {
    return null;
  }
}

function clearLiveSession(mode: SessionMode) {
  liveSessionIds[mode] = null;
}

function createHistoryRecord(
  serial: string,
  source: HistoryRecordResponse['source'],
  taskText: string,
  finalMessage: string,
  success: boolean,
  steps: number,
  messages: MessageRecordResponse[]
) {
  const startedAt = messages[0]?.timestamp || nowIso();
  const endedAt = nowIso();
  const history = readStoredHistory();
  const record: HistoryRecordResponse = {
    id: uniqueId('history'),
    task_text: taskText,
    final_message: finalMessage,
    success,
    steps,
    start_time: startedAt,
    end_time: endedAt,
    duration_ms: Math.max(
      500,
      new Date(endedAt).getTime() - new Date(startedAt).getTime()
    ),
    source,
    source_detail: source === 'layered' ? 'layered-agent' : 'classic-chat',
    error_message: success ? null : finalMessage,
    messages,
  };

  history[serial] = [record, ...(history[serial] || [])];
  writeStoredHistory(history);
  return record;
}

function getDeviceByIdSync(deviceId: string) {
  const devices = readStorage<StoredDevice[]>(STORAGE_KEYS.devices, []);
  return devices.find(device => device.id === deviceId) || devices[0];
}

function getDeviceSerial(deviceId: string) {
  return getDeviceByIdSync(deviceId)?.serial || 'NOVAPER-DESKTOP';
}

export async function listDevices(): Promise<DeviceListResponse> {
  const devices = await ensureDevicesSeeded();
  return {
    devices: devices.map(mapStoredDevice),
  };
}

export async function getDevices(): Promise<Device[]> {
  const response = await listDevices();
  return response.devices;
}

export async function connectWifi(
  payload: WiFiConnectRequest
): Promise<WiFiConnectResponse> {
  const deviceId = payload.device_id || primaryDeviceId;
  await updateStoredDevices(devices =>
    devices.map(device =>
      device.id === deviceId ? { ...device, connection_type: 'wifi' } : device
    )
  );
  return {
    success: true,
    message: 'Connected over WiFi.',
    device_id: deviceId,
  };
}

export async function disconnectWifi(
  deviceId: string
): Promise<WiFiDisconnectResponse> {
  await updateStoredDevices(devices =>
    devices.map(device =>
      device.id === deviceId ? { ...device, connection_type: 'usb' } : device
    )
  );
  return {
    success: true,
    message: 'Disconnected WiFi device.',
  };
}

export async function connectWifiManual(
  payload: WiFiManualConnectRequest
): Promise<WiFiManualConnectResponse> {
  const id = uniqueId('wifi');
  await updateStoredDevices(devices => [
    ...devices,
    {
      id,
      serial: `${payload.ip}:${payload.port || 5555}`,
      model: 'Android Device',
      connection_type: 'wifi',
      display_name: payload.ip,
      group_id: 'default',
    },
  ]);
  return {
    success: true,
    message: 'Manual WiFi device added.',
    device_id: id,
  };
}

export async function pairWifi(
  payload: WiFiPairRequest
): Promise<WiFiPairResponse> {
  return await connectWifiManual({
    ip: payload.ip,
    port: payload.connection_port || 5555,
  });
}

export async function discoverRemoteDevices(
  payload: RemoteDeviceDiscoverRequest
): Promise<RemoteDeviceDiscoverResponse> {
  const url = payload.base_url.replace(/\/$/, '');
  return {
    success: true,
    message: 'Remote devices discovered.',
    devices: [
      {
        device_id: 'remote-phone-01',
        model: 'Remote Android',
        platform: 'android',
        status: `via ${url}`,
      },
      {
        device_id: 'remote-tablet-02',
        model: 'Remote Tablet',
        platform: 'android',
        status: `via ${url}`,
      },
    ],
  };
}

export async function addRemoteDevice(
  payload: RemoteDeviceAddRequest
): Promise<RemoteDeviceAddResponse> {
  const id = uniqueId('remote');
  await updateStoredDevices(devices => [
    ...devices,
    {
      id,
      serial: payload.device_id,
      model: 'Remote Android',
      connection_type: 'remote',
      display_name: payload.device_id,
      group_id: 'default',
    },
  ]);
  return {
    success: true,
    message: 'Remote device added.',
    serial: payload.device_id,
  };
}

export async function removeRemoteDevice(
  serial: string
): Promise<RemoteDeviceRemoveResponse> {
  await updateStoredDevices(devices =>
    devices.filter(device => device.is_primary || device.serial !== serial)
  );
  return {
    success: true,
    message: 'Remote device removed.',
  };
}

export function sendMessageStream(
  message: string,
  deviceId: string,
  onThinking: (event: ThinkingEvent) => void,
  onStep: (event: StepEvent) => void,
  onDone: (event: DoneEvent) => void,
  onError: (event: ErrorEvent) => void,
  onCancelled?: (event: CancelledEvent) => void
): { close: () => void } {
  const runId = ++classicChatToken;
  const createdAt = nowIso();
  const serial = getDeviceSerial(deviceId);
  const historyMessages: MessageRecordResponse[] = [
    {
      role: 'user',
      content: message,
      timestamp: createdAt,
    },
  ];
  let closed = false;
  let finalized = false;
  let stepCount = 0;
  let thinkingBuffer = '';
  let ignoredEventCount = 0;
  let eventSource: EventSource | null = null;
  let currentTool: ToolCallPayload | null = null;

  const closeStream = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const finishWithDone = (finalMessage: string) => {
    if (finalized || closed || runId !== classicChatToken) {
      return;
    }
    finalized = true;
    closeStream();
    createHistoryRecord(
      serial,
      'chat',
      message,
      finalMessage,
      true,
      stepCount,
      historyMessages
    );
    onDone({
      type: 'done',
      role: 'assistant',
      message: finalMessage,
      steps: stepCount,
      success: true,
    });
  };

  const finishWithError = (errorMessage: string, cancelled: boolean) => {
    if (finalized || closed || runId !== classicChatToken) {
      return;
    }
    finalized = true;
    closeStream();
    if (cancelled) {
      onCancelled?.({
        type: 'cancelled',
        role: 'assistant',
        message: errorMessage,
      });
      return;
    }
    onError({
      type: 'error',
      role: 'assistant',
      message: errorMessage,
    });
  };

  const handleLiveEvent = (liveEvent: LiveEventRecord) => {
    if (closed || finalized || runId !== classicChatToken) {
      return;
    }

    if (liveEvent.type === 'message') {
      if (liveEvent.message === 'User instruction') {
        return;
      }
      const text = extractMessageText(liveEvent.payload);
      if (!text) {
        return;
      }
      thinkingBuffer = thinkingBuffer ? `${thinkingBuffer}\n\n${text}` : text;
      onThinking({
        type: 'thinking',
        role: 'assistant',
        chunk: text,
      });
      return;
    }

    if (liveEvent.type === 'agent_route') {
      const agentType =
        liveEvent.payload &&
        typeof liveEvent.payload === 'object' &&
        'agentType' in liveEvent.payload
          ? (liveEvent.payload as { agentType: string }).agentType
          : 'desktop';
      onThinking({
        type: 'thinking',
        role: 'assistant',
        chunk: `[Agent: ${agentType === 'cli' ? 'CLI (pi)' : 'Desktop'}]`,
      });
      return;
    }

    if (liveEvent.type === 'tool_call') {
      currentTool = extractToolCall(liveEvent.payload, liveEvent.message);
      return;
    }

    if (liveEvent.type === 'computer_action') {
      stepCount += 1;
      const action = {
        action: 'computer_actions',
        payload: liveEvent.payload,
      };
      historyMessages.push({
        role: 'assistant',
        content: '',
        timestamp: liveEvent.at,
        thinking: thinkingBuffer || 'Executing desktop actions.',
        action,
        step: stepCount,
      });
      onStep({
        type: 'step',
        role: 'assistant',
        step: stepCount,
        thinking: thinkingBuffer || 'Executing desktop actions.',
        action,
        success: true,
        finished: false,
      });
      thinkingBuffer = '';
      currentTool = null;
      return;
    }

    if (liveEvent.type === 'tool_result') {
      const fallbackName =
        liveEvent.message.split(':').slice(1).join(':').trim() || 'tool';
      const tool = currentTool || {
        name: fallbackName,
        arguments: {},
      };
      stepCount += 1;
      const action = {
        action: tool.name,
        arguments: tool.arguments,
        result: liveEvent.payload,
      };
      historyMessages.push({
        role: 'assistant',
        content: '',
        timestamp: liveEvent.at,
        thinking: thinkingBuffer || `Executed ${tool.name}.`,
        action,
        step: stepCount,
      });
      onStep({
        type: 'step',
        role: 'assistant',
        step: stepCount,
        thinking: thinkingBuffer || `Executed ${tool.name}.`,
        action,
        success: true,
        finished: false,
      });
      thinkingBuffer = '';
      currentTool = null;
      return;
    }

    if (liveEvent.type === 'status') {
      if (liveEvent.message === 'Instruction completed.') {
        const finalMessage =
          extractSummaryText(liveEvent.payload) ||
          thinkingBuffer ||
          'Instruction completed.';
        historyMessages.push({
          role: 'assistant',
          content: finalMessage,
          timestamp: liveEvent.at,
        });
        finishWithDone(finalMessage);
        return;
      }
      if (/Stop requested/i.test(liveEvent.message)) {
        finishWithError('Task cancelled by user.', true);
      }
      return;
    }

    if (liveEvent.type === 'error') {
      finishWithError(liveEvent.message || 'Live session failed.', false);
    }
  };

  void (async () => {
    try {
      const authProvider = await resolvePreferredAuthProvider('classic');
      const model = getConfiguredModel('classic');
      const sessionId = await ensureLiveSession('classic', model, authProvider);
      const snapshot = await fetchJson<LiveSessionSnapshot>(
        `/api/live-sessions/${sessionId}`
      );
      ignoredEventCount = snapshot.events.length;
      eventSource = new EventSource(`/api/live-sessions/${sessionId}/events`);
      eventSource.onmessage = event => {
        if (closed || finalized || runId !== classicChatToken) {
          return;
        }
        if (ignoredEventCount > 0) {
          ignoredEventCount -= 1;
          return;
        }
        try {
          handleLiveEvent(JSON.parse(event.data) as LiveEventRecord);
        } catch {
          // Ignore malformed stream events.
        }
      };
      eventSource.onerror = () => {
        if (closed || finalized || runId !== classicChatToken) {
          return;
        }
        finishWithError('Live session stream disconnected.', false);
      };

      await fetchJson(`/api/live-sessions/${sessionId}/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instruction: message,
          model,
          authProvider,
        }),
      });
    } catch (error) {
      finishWithError(getErrorMessage(error), false);
    }
  })();

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      closeStream();
    },
  };
}

export async function getStatus(): Promise<StatusResponse> {
  const health = await fetchSystemHealth();
  const history = readStoredHistory();
  const stepCount = Object.values(history).reduce(
    (total, records) => total + records.length,
    0
  );

  return {
    version: health?.version || DEFAULT_VERSION,
    initialized: true,
    step_count: stepCount,
  };
}

export async function resetChat(_deviceId: string): Promise<{
  success: boolean;
  message: string;
  device_id?: string;
}> {
  classicChatToken += 1;
  const sessionId = liveSessionIds.classic;
  clearLiveSession('classic');
  if (sessionId) {
    try {
      await fetchJson(`/api/live-sessions/${sessionId}/stop`, {
        method: 'POST',
      });
    } catch {
      // Ignore stop failures during reset.
    }
  }
  return {
    success: true,
    message: 'Chat reset.',
  };
}

export async function abortChat(_deviceId: string): Promise<{
  success: boolean;
  message: string;
}> {
  classicChatToken += 1;
  const sessionId = liveSessionIds.classic;
  if (sessionId) {
    try {
      await fetchJson(`/api/live-sessions/${sessionId}/stop`, {
        method: 'POST',
      });
    } catch {
      // Ignore stop failures during abort.
    }
  }
  return {
    success: true,
    message: 'Chat aborted.',
  };
}

export async function getScreenshot(
  _deviceId?: string | null
): Promise<ScreenshotResponse> {
  try {
    const observed = await observeLiveDesktop();
    const screenshotUrl = observed?.screenshot?.url;
    if (screenshotUrl) {
      const response = await fetch(screenshotUrl);
      const blob = await response.blob();
      return {
        success: true,
        image: await blobToBase64(blob),
        width: observed?.screenshot?.width || 1280,
        height: observed?.screenshot?.height || 720,
        is_sensitive: false,
      };
    }
  } catch {
    // Fall through to placeholder.
  }

  return {
    success: true,
    image: placeholderScreenshot(),
    width: 720,
    height: 1280,
    is_sensitive: false,
  };
}

export async function sendTap(
  _x: number,
  _y: number,
  _deviceId?: string | null,
  _delay: number = 0
): Promise<TapResponse> {
  return { success: true };
}

export async function sendSwipe(
  _startX: number,
  _startY: number,
  _endX: number,
  _endY: number,
  _durationMs?: number,
  _deviceId?: string | null,
  _delay: number = 0
): Promise<SwipeResponse> {
  return { success: true };
}

export async function sendTouchDown(
  _x: number,
  _y: number,
  _deviceId?: string | null,
  _delay: number = 0
): Promise<TouchDownResponse> {
  return { success: true };
}

export async function sendTouchMove(
  _x: number,
  _y: number,
  _deviceId?: string | null,
  _delay: number = 0
): Promise<TouchMoveResponse> {
  return { success: true };
}

export async function sendTouchUp(
  _x: number,
  _y: number,
  _deviceId?: string | null,
  _delay: number = 0
): Promise<TouchUpResponse> {
  return { success: true };
}

export async function getConfig(): Promise<ConfigResponse> {
  return readStorage<StoredConfig>(STORAGE_KEYS.config, defaultConfig());
}

export async function saveConfig(
  config: ConfigSaveRequest
): Promise<ConfigSaveResponse> {
  const nextConfig: StoredConfig = {
    ...defaultConfig(),
    ...readStorage<StoredConfig>(STORAGE_KEYS.config, defaultConfig()),
    ...config,
    api_key: config.api_key || '',
    source: 'novaper-ui',
  };
  writeStorage(STORAGE_KEYS.config, nextConfig);
  return {
    success: true,
    message: 'Configuration saved.',
    restart_required: false,
  };
}

export async function deleteConfig(): Promise<{
  success: boolean;
  message: string;
}> {
  removeStorage(STORAGE_KEYS.config);
  return {
    success: true,
    message: 'Configuration deleted.',
  };
}

export async function checkVersion(): Promise<VersionCheckResponse> {
  const status = await getStatus();
  return {
    current_version: status.version,
    latest_version: null,
    has_update: false,
    release_url: 'https://github.com/Charlo-O/Novaper/releases',
    published_at: null,
    error: null,
  };
}

export async function discoverMdnsDevices(): Promise<MdnsDiscoverResponse> {
  return {
    success: true,
    devices: [
      {
        name: 'Android 14',
        ip: '192.168.1.21',
        port: 5555,
        has_pairing: false,
        service_type: '_adb-tls-connect._tcp',
      },
      {
        name: 'Pixel 8',
        ip: '192.168.1.38',
        port: 40341,
        has_pairing: true,
        pairing_port: 37017,
        service_type: '_adb-tls-pairing._tcp',
      },
    ],
  };
}

export async function generateQRPairing(
  timeout: number = 90
): Promise<QRPairGenerateResponse> {
  const sessionId = uniqueId('qr');
  qrSessions.set(sessionId, {
    sessionId,
    createdAt: Date.now(),
    cancelled: false,
  });
  return {
    success: true,
    qr_payload: `WIFI:T:ADB;S:Novaper Pairing;P:${sessionId};`,
    session_id: sessionId,
    expires_at: Date.now() + timeout * 1000,
    message: 'QR pairing started.',
  };
}

export async function getQRPairingStatus(
  sessionId: string
): Promise<QRPairStatusResponse> {
  const session = qrSessions.get(sessionId);
  if (!session || session.cancelled) {
    return {
      session_id: sessionId,
      status: 'error',
      message: 'Pairing session not found.',
      error: 'session_not_found',
    };
  }

  const elapsed = Date.now() - session.createdAt;
  const status =
    elapsed < 3000 ? 'listening' : elapsed < 6000 ? 'pairing' : 'connected';

  return {
    session_id: sessionId,
    status,
    device_id: status === 'connected' ? primaryDeviceId : undefined,
    message:
      status === 'connected' ? 'Device connected.' : 'Waiting for device.',
  };
}

export async function cancelQRPairing(
  sessionId: string
): Promise<QRPairCancelResponse> {
  const session = qrSessions.get(sessionId);
  if (session) {
    session.cancelled = true;
  }
  return {
    success: true,
    message: 'QR pairing cancelled.',
  };
}

export async function listWorkflows(): Promise<WorkflowListResponse> {
  return {
    workflows: readStoredWorkflows(),
  };
}

export async function getWorkflow(uuid: string): Promise<Workflow> {
  const workflow = readStoredWorkflows().find(item => item.uuid === uuid);
  if (!workflow) {
    throw new Error('Workflow not found.');
  }
  return workflow;
}

export async function createWorkflow(
  request: WorkflowCreateRequest
): Promise<Workflow> {
  const workflows = readStoredWorkflows();
  const workflow: Workflow = {
    uuid: uniqueId('workflow'),
    name: request.name,
    text: request.text,
  };
  writeStoredWorkflows([workflow, ...workflows]);
  return workflow;
}

export async function updateWorkflow(
  uuid: string,
  request: WorkflowUpdateRequest
): Promise<Workflow> {
  let updatedWorkflow: Workflow | null = null;
  const workflows = readStoredWorkflows().map(workflow => {
    if (workflow.uuid !== uuid) {
      return workflow;
    }
    updatedWorkflow = {
      ...workflow,
      name: request.name,
      text: request.text,
    };
    return updatedWorkflow;
  });

  if (!updatedWorkflow) {
    throw new Error('Workflow not found.');
  }

  writeStoredWorkflows(workflows);
  return updatedWorkflow;
}

export async function deleteWorkflow(uuid: string): Promise<void> {
  const workflows = readStoredWorkflows().filter(
    workflow => workflow.uuid !== uuid
  );
  writeStoredWorkflows(workflows);
}

export async function abortLayeredAgentChat(_sessionId: string): Promise<{
  success: boolean;
  message: string;
}> {
  layeredChatToken += 1;
  const sessionId = liveSessionIds.layered;
  if (sessionId) {
    try {
      await fetchJson(`/api/live-sessions/${sessionId}/stop`, {
        method: 'POST',
      });
    } catch {
      // Ignore stop failures during abort.
    }
  }
  return {
    success: true,
    message: 'Layered chat aborted.',
  };
}

export async function resetLayeredAgentSession(_sessionId: string): Promise<{
  success: boolean;
  message: string;
}> {
  layeredChatToken += 1;
  const sessionId = liveSessionIds.layered;
  clearLiveSession('layered');
  if (sessionId) {
    try {
      await fetchJson(`/api/live-sessions/${sessionId}/stop`, {
        method: 'POST',
      });
    } catch {
      // Ignore stop failures during reset.
    }
  }
  return {
    success: true,
    message: 'Layered chat reset.',
  };
}

export function sendLayeredMessageStream(
  message: string,
  deviceId: string,
  handlers: {
    onToolCall: (event: LayeredToolCallEvent) => void;
    onToolResult: (event: LayeredToolResultEvent) => void;
    onMessage: (event: LayeredMessageEvent) => void;
    onDone: (event: LayeredDoneEvent) => void;
    onError: (event: LayeredErrorEvent) => void;
  }
): { close: () => void } {
  const runId = ++layeredChatToken;
  const createdAt = nowIso();
  const serial = getDeviceSerial(deviceId);
  const historyMessages: MessageRecordResponse[] = [
    {
      role: 'user',
      content: message,
      timestamp: createdAt,
    },
  ];
  let closed = false;
  let finalized = false;
  let ignoredEventCount = 0;
  let eventSource: EventSource | null = null;
  let currentTool: ToolCallPayload | null = null;
  let latestContent = '';
  let stepCount = 0;

  const closeStream = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const finishWithDone = (content: string, success: boolean) => {
    if (finalized || closed || runId !== layeredChatToken) {
      return;
    }
    finalized = true;
    closeStream();
    historyMessages.push({
      role: 'assistant',
      content,
      timestamp: nowIso(),
    });
    createHistoryRecord(
      serial,
      'layered',
      message,
      content,
      success,
      stepCount,
      historyMessages
    );
    handlers.onDone({
      type: 'done',
      content,
      success,
    });
  };

  const finishWithError = (errorMessage: string) => {
    if (finalized || closed || runId !== layeredChatToken) {
      return;
    }
    finalized = true;
    closeStream();
    handlers.onError({
      type: 'error',
      message: errorMessage,
    });
  };

  const handleLiveEvent = (liveEvent: LiveEventRecord) => {
    if (closed || finalized || runId !== layeredChatToken) {
      return;
    }

    if (liveEvent.type === 'agent_route') {
      const agentType =
        liveEvent.payload &&
        typeof liveEvent.payload === 'object' &&
        'agentType' in liveEvent.payload
          ? (liveEvent.payload as { agentType: string }).agentType
          : 'desktop';
      handlers.onMessage({
        type: 'message',
        content: `[Agent: ${agentType === 'cli' ? 'CLI (pi)' : 'Desktop'}]`,
      });
      return;
    }

    if (liveEvent.type === 'tool_call') {
      currentTool = extractToolCall(liveEvent.payload, liveEvent.message);
      stepCount += 1;
      handlers.onToolCall({
        type: 'tool_call',
        tool_name: currentTool.name,
        tool_args: currentTool.arguments,
      });
      return;
    }

    if (liveEvent.type === 'tool_result') {
      const fallbackName =
        liveEvent.message.split(':').slice(1).join(':').trim() || 'tool';
      const toolName = currentTool?.name || fallbackName;
      handlers.onToolResult({
        type: 'tool_result',
        tool_name: toolName,
        result: toDisplayText(liveEvent.payload),
      });
      currentTool = null;
      return;
    }

    if (liveEvent.type === 'computer_action') {
      stepCount += 1;
      handlers.onToolCall({
        type: 'tool_call',
        tool_name: 'computer_actions',
        tool_args:
          liveEvent.payload && typeof liveEvent.payload === 'object'
            ? { actions: liveEvent.payload as Record<string, unknown> }
            : {},
      });
      return;
    }

    if (liveEvent.type === 'message') {
      if (liveEvent.message === 'User instruction') {
        return;
      }
      const text = extractMessageText(liveEvent.payload);
      if (!text) {
        return;
      }
      latestContent = text;
      handlers.onMessage({
        type: 'message',
        content: text,
      });
      return;
    }

    if (liveEvent.type === 'status') {
      if (liveEvent.message === 'Instruction completed.') {
        finishWithDone(
          extractSummaryText(liveEvent.payload) ||
            latestContent ||
            'Instruction completed.',
          true
        );
        return;
      }
      if (/Stop requested/i.test(liveEvent.message)) {
        finishWithError('Task cancelled by user.');
      }
      return;
    }

    if (liveEvent.type === 'error') {
      finishWithError(liveEvent.message || 'Live session failed.');
    }
  };

  void (async () => {
    try {
      const authProvider = await resolvePreferredAuthProvider('layered');
      const model = getConfiguredModel('layered');
      const sessionId = await ensureLiveSession('layered', model, authProvider);
      const snapshot = await fetchJson<LiveSessionSnapshot>(
        `/api/live-sessions/${sessionId}`
      );
      ignoredEventCount = snapshot.events.length;
      eventSource = new EventSource(`/api/live-sessions/${sessionId}/events`);
      eventSource.onmessage = event => {
        if (closed || finalized || runId !== layeredChatToken) {
          return;
        }
        if (ignoredEventCount > 0) {
          ignoredEventCount -= 1;
          return;
        }
        try {
          handleLiveEvent(JSON.parse(event.data) as LiveEventRecord);
        } catch {
          // Ignore malformed stream events.
        }
      };
      eventSource.onerror = () => {
        if (closed || finalized || runId !== layeredChatToken) {
          return;
        }
        finishWithError('Live session stream disconnected.');
      };

      await fetchJson(`/api/live-sessions/${sessionId}/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instruction: message,
          model,
          authProvider,
        }),
      });
    } catch (error) {
      finishWithError(getErrorMessage(error));
    }
  })();

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      closeStream();
    },
  };
}

/** Server-side history item from unified /api/history endpoint */
export interface ServerHistoryItem {
  id: string;
  type: 'live-session' | 'run';
  createdAt: string;
  updatedAt: string;
  status: string;
  instruction?: string;
  summary?: string;
  error?: string;
  hasToolEvents: boolean;
}

export interface ServerHistoryListResponse {
  items: ServerHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ServerHistoryDetail {
  type: 'live-session' | 'run';
  record: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

export async function listHistory(
  _serialno?: string,
  limit: number = 50,
  offset: number = 0
): Promise<HistoryListResponse> {
  const data = await fetchJson<ServerHistoryListResponse>(
    `/api/history?limit=${limit}&offset=${offset}`
  );

  // Map server items to the HistoryRecordResponse shape expected by the frontend
  const records: HistoryRecordResponse[] = data.items.map((item) => {
    const startTime = item.createdAt;
    const endTime = item.updatedAt;
    const durationMs =
      new Date(endTime).getTime() - new Date(startTime).getTime();
    const isError = item.status === 'error' || item.status === 'Failed';
    const isPlannedOnly = !!item.instruction && !item.hasToolEvents;

    return {
      id: item.id,
      task_text: item.instruction || (isPlannedOnly ? '计划任务（未执行）' : item.summary || item.type),
      final_message: item.error || item.summary || item.status,
      success: !isError,
      steps: 0,
      start_time: startTime,
      end_time: endTime,
      duration_ms: Math.max(durationMs, 0),
      source: item.type === 'run' ? 'layered' as const : 'chat' as const,
      source_detail: item.type,
      error_message: item.error || null,
      messages: [],
    };
  });

  return { records, total: data.total, limit: data.limit, offset: data.offset };
}

export async function getHistoryRecord(
  _serialno: string,
  recordId: string
): Promise<HistoryRecordResponse> {
  const data = await fetchJson<ServerHistoryDetail>(
    `/api/history/${recordId}`
  );

  const events = data.events || [];
  const record = data.record as Record<string, string | undefined>;
  const startTime = record.createdAt || new Date().toISOString();
  const endTime = record.updatedAt || startTime;
  const durationMs =
    new Date(endTime).getTime() - new Date(startTime).getTime();
  const isError = record.status === 'error' || record.status === 'Failed';

  // Map events to messages
  const messages: MessageRecordResponse[] = events.map((ev, idx) => ({
    role: (ev.type === 'message' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: String(ev.message || ''),
    step: ev.type === 'tool_call' || ev.type === 'computer_action' ? idx : null,
    thinking: null,
    action: ev.type === 'tool_call' || ev.type === 'computer_action' ? (ev.payload as Record<string, unknown> || null) : null,
    screenshot: null,
    timestamp: String(ev.at || ''),
  }));

  return {
    id: recordId,
    task_text: record.latestInstruction || record.summary || data.type,
    final_message: record.error || record.latestSummary || record.summary || record.status || '',
    success: !isError,
    steps: events.filter((e) => e.type === 'tool_call' || e.type === 'computer_action').length,
    start_time: startTime,
    end_time: endTime,
    duration_ms: Math.max(durationMs, 0),
    source: data.type === 'run' ? 'layered' : 'chat',
    source_detail: data.type,
    error_message: isError ? (record.error || null) : null,
    messages,
  };
}

export async function deleteHistoryRecord(
  _serialno: string,
  recordId: string
): Promise<void> {
  await fetchJson<{ deleted: boolean }>(`/api/history/${recordId}`, {
    method: 'DELETE',
  });
}

export async function clearHistory(_serialno?: string): Promise<void> {
  // Clear all by fetching all IDs and deleting one by one
  const data = await fetchJson<ServerHistoryListResponse>(
    `/api/history?limit=1000&offset=0`
  );
  for (const item of data.items) {
    try {
      await fetchJson<{ deleted: boolean }>(`/api/history/${item.id}`, {
        method: 'DELETE',
      });
    } catch {
      // best effort
    }
  }
}

export async function listScheduledTasks(): Promise<ScheduledTaskListResponse> {
  return {
    tasks: readStoredTasks(),
  };
}

export async function createScheduledTask(
  data: ScheduledTaskCreate
): Promise<ScheduledTaskResponse> {
  const task: ScheduledTaskResponse = {
    id: uniqueId('task'),
    name: data.name,
    workflow_uuid: data.workflow_uuid,
    device_serialnos: data.device_serialnos || [],
    device_group_id: data.device_group_id || null,
    cron_expression: data.cron_expression,
    enabled: data.enabled ?? true,
    created_at: nowIso(),
    updated_at: nowIso(),
    last_run_time: null,
    last_run_success: null,
    last_run_status: null,
    last_run_success_count: null,
    last_run_total_count: null,
    last_run_message: null,
    next_run_time: null,
  };
  const tasks = readStoredTasks();
  writeStoredTasks([task, ...tasks]);
  return task;
}

export async function getScheduledTask(
  taskId: string
): Promise<ScheduledTaskResponse> {
  const task = readStoredTasks().find(item => item.id === taskId);
  if (!task) {
    throw new Error('Scheduled task not found.');
  }
  return task;
}

export async function updateScheduledTask(
  taskId: string,
  data: ScheduledTaskUpdate
): Promise<ScheduledTaskResponse> {
  let updatedTask: ScheduledTaskResponse | null = null;
  const tasks = readStoredTasks().map(task => {
    if (task.id !== taskId) {
      return task;
    }
    updatedTask = {
      ...task,
      ...data,
      device_serialnos:
        data.device_serialnos === undefined
          ? task.device_serialnos
          : data.device_serialnos || [],
      device_group_id:
        data.device_group_id === undefined
          ? task.device_group_id || null
          : data.device_group_id,
      updated_at: nowIso(),
    };
    return updatedTask;
  });

  if (!updatedTask) {
    throw new Error('Scheduled task not found.');
  }

  writeStoredTasks(tasks);
  return updatedTask;
}

export async function deleteScheduledTask(taskId: string): Promise<void> {
  writeStoredTasks(readStoredTasks().filter(task => task.id !== taskId));
}

export async function enableScheduledTask(
  taskId: string
): Promise<ScheduledTaskResponse> {
  return await updateScheduledTask(taskId, { enabled: true });
}

export async function disableScheduledTask(
  taskId: string
): Promise<ScheduledTaskResponse> {
  return await updateScheduledTask(taskId, { enabled: false });
}

export async function updateDeviceName(
  serial: string,
  displayName: string | null
): Promise<DeviceNameResponse> {
  await updateStoredDevices(devices =>
    devices.map(device =>
      device.serial === serial
        ? { ...device, display_name: displayName }
        : device
    )
  );
  return {
    success: true,
    serial,
    display_name: displayName,
  };
}

export async function getDeviceName(
  serial: string
): Promise<DeviceNameResponse> {
  const device = (await ensureDevicesSeeded()).find(item => item.serial === serial);
  return {
    success: true,
    serial,
    display_name: device?.display_name || null,
  };
}

export async function listDeviceGroups(): Promise<DeviceGroupListResponse> {
  const groups = readStoredGroups();
  const devices = await ensureDevicesSeeded();
  return {
    groups: groups
      .slice()
      .sort((left, right) => left.order - right.order)
      .map(group => ({
        ...group,
        device_count: devices.filter(
          device => (device.group_id || 'default') === group.id
        ).length,
      })),
  };
}

export async function createDeviceGroup(name: string): Promise<DeviceGroup> {
  const groups = readStoredGroups();
  const group = {
    id: uniqueId('group'),
    name,
    order: groups.length,
    created_at: nowIso(),
    updated_at: nowIso(),
    is_default: false,
  };
  writeStoredGroups([...groups, group]);
  return {
    ...group,
    device_count: 0,
  };
}

export async function updateDeviceGroup(
  groupId: string,
  name: string
): Promise<DeviceGroup> {
  let updated: DeviceGroup | null = null;
  const groups = readStoredGroups().map(group => {
    if (group.id !== groupId) {
      return group;
    }
    updated = {
      ...group,
      name,
      updated_at: nowIso(),
      device_count: 0,
    };
    return updated;
  });

  if (!updated) {
    throw new Error('Device group not found.');
  }

  writeStoredGroups(
    groups.map(group => ({
      id: group.id,
      name: group.name,
      order: group.order,
      created_at: group.created_at,
      updated_at: group.updated_at,
      is_default: group.is_default,
    }))
  );
  return updated;
}

export async function deleteDeviceGroup(
  groupId: string
): Promise<DeviceGroupOperationResponse> {
  const groups = readStoredGroups();
  const target = groups.find(group => group.id === groupId);
  if (!target) {
    return {
      success: false,
      message: 'Device group not found.',
      error: 'not_found',
    };
  }
  if (target.is_default) {
    return {
      success: false,
      message: 'Default group cannot be deleted.',
      error: 'default_group',
    };
  }

  writeStoredGroups(groups.filter(group => group.id !== groupId));
  await updateStoredDevices(devices =>
    devices.map(device =>
      device.group_id === groupId ? { ...device, group_id: 'default' } : device
    )
  );

  return {
    success: true,
    message: 'Device group deleted.',
  };
}

export async function reorderDeviceGroups(
  groupIds: string[]
): Promise<DeviceGroupOperationResponse> {
  const groupsById = new Map(readStoredGroups().map(group => [group.id, group]));
  const reordered = groupIds
    .map((groupId, index) => {
      const group = groupsById.get(groupId);
      if (!group) {
        return null;
      }
      return {
        ...group,
        order: index,
        updated_at: nowIso(),
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    name: string;
    order: number;
    created_at: string;
    updated_at: string;
    is_default: boolean;
  }>;

  writeStoredGroups(reordered);
  return {
    success: true,
    message: 'Device groups reordered.',
  };
}

export async function assignDeviceToGroup(
  serial: string,
  groupId: string
): Promise<DeviceGroupOperationResponse> {
  await updateStoredDevices(devices =>
    devices.map(device =>
      device.serial === serial ? { ...device, group_id: groupId } : device
    )
  );

  return {
    success: true,
    message: 'Device moved to group.',
  };
}

// ---------------------------------------------------------------------------
// Plugin Management: Skill Repos, Skills, MCP Servers
// ---------------------------------------------------------------------------

export interface SkillRepo {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface DiscoverableSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  readmeUrl: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
}

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  directory: string;
  content: string;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
  enabled: boolean;
  installedAt: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// Skill Repos

export async function listSkillRepos(): Promise<SkillRepo[]> {
  return fetchJson<SkillRepo[]>('/api/plugins/skill-repos');
}

export async function addSkillRepo(
  repo: Omit<SkillRepo, 'enabled'> & { enabled?: boolean }
): Promise<SkillRepo> {
  return fetchJson<SkillRepo>('/api/plugins/skill-repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(repo),
  });
}

export async function updateSkillRepo(
  owner: string,
  name: string,
  updates: Partial<Pick<SkillRepo, 'branch' | 'enabled'>>
): Promise<SkillRepo> {
  return fetchJson<SkillRepo>(
    `/api/plugins/skill-repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }
  );
}

export async function deleteSkillRepo(owner: string, name: string): Promise<void> {
  await fetchJson(
    `/api/plugins/skill-repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
}

// Skill Discovery & Installation

export interface DiscoverSkillsResult {
  skills: DiscoverableSkill[];
  errors: string[];
}

export async function discoverSkills(forceRefresh = false): Promise<DiscoverSkillsResult> {
  const url = forceRefresh ? '/api/plugins/skills/discover?refresh=1' : '/api/plugins/skills/discover';
  return fetchJson<DiscoverSkillsResult>(url);
}

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  return fetchJson<InstalledSkill[]>('/api/plugins/skills');
}

export async function installSkill(skill: DiscoverableSkill): Promise<InstalledSkill> {
  return fetchJson<InstalledSkill>('/api/plugins/skills/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  });
}

export async function createLocalSkill(input: {
  name: string;
  description: string;
  content: string;
}): Promise<InstalledSkill> {
  return fetchJson<InstalledSkill>('/api/plugins/skills/local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateInstalledSkill(
  id: string,
  updates: Partial<Pick<InstalledSkill, 'enabled' | 'name' | 'description' | 'content'>>
): Promise<InstalledSkill> {
  return fetchJson<InstalledSkill>(`/api/plugins/skills/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export async function uninstallSkill(id: string): Promise<void> {
  await fetchJson(`/api/plugins/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// MCP Servers

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return fetchJson<McpServerConfig[]>('/api/plugins/mcp-servers');
}

export async function createMcpServer(
  input: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpServerConfig> {
  return fetchJson<McpServerConfig>('/api/plugins/mcp-servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateMcpServer(
  id: string,
  updates: Partial<Omit<McpServerConfig, 'id' | 'createdAt'>>
): Promise<McpServerConfig> {
  return fetchJson<McpServerConfig>(`/api/plugins/mcp-servers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await fetchJson(`/api/plugins/mcp-servers/${id}`, { method: 'DELETE' });
}
