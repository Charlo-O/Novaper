import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface StoredDeviceRecord {
  id: string;
  serial: string;
  model: string;
  connection_type: "usb" | "wifi" | "remote";
  display_name: string | null;
  group_id: string;
  is_primary?: boolean;
  remote_base_url?: string | null;
}

export interface StoredDeviceGroupRecord {
  id: string;
  name: string;
  order: number;
  created_at: string;
  updated_at: string;
  is_default: boolean;
}

interface QrPairSessionRecord {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  cancelled: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultGroup() {
  const timestamp = nowIso();
  return {
    id: "default",
    name: "Default",
    order: 0,
    created_at: timestamp,
    updated_at: timestamp,
    is_default: true,
  } satisfies StoredDeviceGroupRecord;
}

export class DeviceStore {
  static readonly PRIMARY_DEVICE_ID = "novaper-primary-device";

  private readonly devicesPath: string;
  private readonly groupsPath: string;
  private devices = new Map<string, StoredDeviceRecord>();
  private groups = new Map<string, StoredDeviceGroupRecord>();
  private readonly qrSessions = new Map<string, QrPairSessionRecord>();

  constructor(private readonly rootDir: string) {
    this.devicesPath = path.join(rootDir, "devices.json");
    this.groupsPath = path.join(rootDir, "groups.json");
  }

  async loadFromDisk() {
    await fs.mkdir(this.rootDir, { recursive: true });

    const [deviceEntries, groupEntries] = await Promise.all([
      this.readJson<StoredDeviceRecord>(this.devicesPath),
      this.readJson<StoredDeviceGroupRecord>(this.groupsPath),
    ]);

    const seededGroups = groupEntries.length > 0 ? groupEntries : [defaultGroup()];
    this.groups = new Map(seededGroups.map((group) => [group.id, group]));
    if (!this.groups.has("default")) {
      const fallbackDefault = defaultGroup();
      this.groups.set(fallbackDefault.id, fallbackDefault);
    }

    this.devices = new Map(
      deviceEntries.map((device) => [
        device.id,
        {
          ...device,
          connection_type:
            device.connection_type === "wifi" || device.connection_type === "remote"
              ? device.connection_type
              : "usb",
          group_id: this.groups.has(device.group_id) ? device.group_id : "default",
        },
      ]),
    );

    await this.persistAll();
  }

  listDevices() {
    return [...this.devices.values()].sort((left, right) => {
      if (left.is_primary && !right.is_primary) {
        return -1;
      }
      if (!left.is_primary && right.is_primary) {
        return 1;
      }
      return left.serial.localeCompare(right.serial);
    });
  }

  getDeviceById(deviceId: string) {
    return this.devices.get(deviceId);
  }

  getDeviceBySerial(serial: string) {
    return this.listDevices().find((device) => device.serial === serial) ?? null;
  }

  listGroupsWithCounts() {
    const devices = this.listDevices();
    return [...this.groups.values()]
      .sort((left, right) => left.order - right.order)
      .map((group) => ({
        ...group,
        device_count: devices.filter((device) => (device.group_id || "default") === group.id).length,
      }));
  }

  resolveDeviceSerials(selection: {
    device_serialnos?: string[] | null;
    device_group_id?: string | null;
  }) {
    if (selection.device_group_id) {
      return this.listDevices()
        .filter((device) => (device.group_id || "default") === selection.device_group_id)
        .map((device) => device.serial);
    }

    if (Array.isArray(selection.device_serialnos) && selection.device_serialnos.length > 0) {
      const validSerials = new Set(this.listDevices().map((device) => device.serial));
      return [...new Set(selection.device_serialnos.filter((serial) => validSerials.has(serial)))];
    }

    return [];
  }

  async syncPrimaryDevice(machineId: string) {
    const primary = this.devices.get(DeviceStore.PRIMARY_DEVICE_ID);
    const next: StoredDeviceRecord = {
      id: DeviceStore.PRIMARY_DEVICE_ID,
      serial: machineId || "NOVAPER-DESKTOP",
      model: primary?.model || "Novaper Device",
      connection_type: primary?.connection_type === "wifi" ? "wifi" : "usb",
      display_name: primary?.display_name || "Novaper Device",
      group_id: this.groups.has(primary?.group_id || "") ? primary?.group_id || "default" : "default",
      is_primary: true,
      remote_base_url: null,
    };

    this.devices.set(next.id, next);
    await this.persistDevices();
    return next;
  }

  async setConnectionType(deviceId: string, connectionType: StoredDeviceRecord["connection_type"]) {
    const device = this.requireDeviceById(deviceId);
    const updated: StoredDeviceRecord = {
      ...device,
      connection_type: connectionType,
    };
    this.devices.set(device.id, updated);
    await this.persistDevices();
    return updated;
  }

  async addManualWifiDevice(input: { ip: string; port?: number | null }) {
    const serial = `${input.ip}:${input.port || 5555}`;
    const existing = this.getDeviceBySerial(serial);
    const next: StoredDeviceRecord = existing
      ? {
          ...existing,
          connection_type: "wifi",
          model: existing.model || "Android Device",
          display_name: existing.display_name || input.ip,
          group_id: existing.group_id || "default",
        }
      : {
          id: `wifi-${randomUUID()}`,
          serial,
          model: "Android Device",
          connection_type: "wifi",
          display_name: input.ip,
          group_id: "default",
          remote_base_url: null,
        };

    this.devices.set(next.id, next);
    await this.persistDevices();
    return next;
  }

  async addRemoteDevice(input: { baseUrl: string; deviceId: string }) {
    const existing = this.getDeviceBySerial(input.deviceId);
    const next: StoredDeviceRecord = existing
      ? {
          ...existing,
          connection_type: "remote",
          model: existing.model || "Remote Android",
          display_name: existing.display_name || input.deviceId,
          group_id: existing.group_id || "default",
          remote_base_url: input.baseUrl,
        }
      : {
          id: `remote-${randomUUID()}`,
          serial: input.deviceId,
          model: "Remote Android",
          connection_type: "remote",
          display_name: input.deviceId,
          group_id: "default",
          remote_base_url: input.baseUrl,
        };

    this.devices.set(next.id, next);
    await this.persistDevices();
    return next;
  }

  async removeRemoteDevice(serial: string) {
    const device = this.getDeviceBySerial(serial);
    if (!device || device.is_primary) {
      return false;
    }
    const deleted = this.devices.delete(device.id);
    if (!deleted) {
      return false;
    }
    await this.persistDevices();
    return true;
  }

  async updateDeviceName(serial: string, displayName: string | null) {
    const device = this.requireDeviceBySerial(serial);
    const updated: StoredDeviceRecord = {
      ...device,
      display_name: displayName,
    };
    this.devices.set(device.id, updated);
    await this.persistDevices();
    return updated;
  }

  async createGroup(name: string) {
    const timestamp = nowIso();
    const order = Math.max(-1, ...[...this.groups.values()].map((group) => group.order)) + 1;
    const group: StoredDeviceGroupRecord = {
      id: `group-${randomUUID()}`,
      name,
      order,
      created_at: timestamp,
      updated_at: timestamp,
      is_default: false,
    };
    this.groups.set(group.id, group);
    await this.persistGroups();
    return group;
  }

  async updateGroup(groupId: string, name: string) {
    const group = this.requireGroup(groupId);
    const updated: StoredDeviceGroupRecord = {
      ...group,
      name,
      updated_at: nowIso(),
    };
    this.groups.set(group.id, updated);
    await this.persistGroups();
    return updated;
  }

  async deleteGroup(groupId: string) {
    const group = this.groups.get(groupId);
    if (!group) {
      return { success: false, message: "Device group not found.", error: "not_found" } as const;
    }
    if (group.is_default) {
      return {
        success: false,
        message: "Default group cannot be deleted.",
        error: "default_group",
      } as const;
    }

    this.groups.delete(groupId);
    for (const device of this.devices.values()) {
      if (device.group_id === groupId) {
        this.devices.set(device.id, {
          ...device,
          group_id: "default",
        });
      }
    }
    await this.persistAll();
    return { success: true, message: "Device group deleted." } as const;
  }

  async reorderGroups(groupIds: string[]) {
    const specified = new Set(groupIds);
    const orderedGroups = [
      ...groupIds
        .map((groupId) => this.groups.get(groupId))
        .filter((group): group is StoredDeviceGroupRecord => Boolean(group)),
      ...[...this.groups.values()].filter((group) => !specified.has(group.id)).sort((left, right) => left.order - right.order),
    ];

    orderedGroups.forEach((group, index) => {
      this.groups.set(group.id, {
        ...group,
        order: index,
        updated_at: index === group.order ? group.updated_at : nowIso(),
      });
    });

    await this.persistGroups();
    return { success: true, message: "Device groups reordered." } as const;
  }

  async assignDeviceToGroup(serial: string, groupId: string) {
    this.requireGroup(groupId);
    const device = this.requireDeviceBySerial(serial);
    const updated: StoredDeviceRecord = {
      ...device,
      group_id: groupId,
    };
    this.devices.set(device.id, updated);
    await this.persistDevices();
    return updated;
  }

  listMdnsDevices() {
    return [
      {
        name: "Android 14",
        ip: "192.168.1.21",
        port: 5555,
        has_pairing: false,
        service_type: "_adb-tls-connect._tcp",
      },
      {
        name: "Pixel 8",
        ip: "192.168.1.38",
        port: 40341,
        has_pairing: true,
        pairing_port: 37017,
        service_type: "_adb-tls-pairing._tcp",
      },
    ];
  }

  discoverRemoteDevices(baseUrl: string) {
    const url = baseUrl.replace(/\/$/, "");
    return {
      success: true,
      message: "Remote devices discovered.",
      devices: [
        {
          device_id: "remote-phone-01",
          model: "Remote Android",
          platform: "android",
          status: `via ${url}`,
        },
        {
          device_id: "remote-tablet-02",
          model: "Remote Tablet",
          platform: "android",
          status: `via ${url}`,
        },
      ],
    };
  }

  createQrPairingSession(timeoutSeconds = 90) {
    const sessionId = `qr-${randomUUID()}`;
    const session: QrPairSessionRecord = {
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + timeoutSeconds * 1000,
      cancelled: false,
    };
    this.qrSessions.set(sessionId, session);
    return session;
  }

  getQrPairingStatus(sessionId: string) {
    const session = this.qrSessions.get(sessionId);
    if (!session || session.cancelled) {
      return {
        session_id: sessionId,
        status: "error" as const,
        message: "Pairing session not found.",
        error: "session_not_found",
      };
    }
    if (Date.now() > session.expiresAt) {
      return {
        session_id: sessionId,
        status: "timeout" as const,
        message: "Pairing session expired.",
        error: "session_expired",
      };
    }

    const elapsed = Date.now() - session.createdAt;
    const status =
      elapsed < 3000
        ? "listening"
        : elapsed < 6000
          ? "pairing"
          : "connected";

    return {
      session_id: sessionId,
      status,
      device_id: status === "connected" ? DeviceStore.PRIMARY_DEVICE_ID : undefined,
      message: status === "connected" ? "Device connected." : "Waiting for device.",
    };
  }

  cancelQrPairing(sessionId: string) {
    const session = this.qrSessions.get(sessionId);
    if (session) {
      session.cancelled = true;
    }
    return {
      success: true,
      message: "QR pairing cancelled.",
    };
  }

  private requireDeviceById(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    return device;
  }

  private requireDeviceBySerial(serial: string) {
    const device = this.getDeviceBySerial(serial);
    if (!device) {
      throw new Error(`Device not found: ${serial}`);
    }
    return device;
  }

  private requireGroup(groupId: string) {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Device group not found: ${groupId}`);
    }
    return group;
  }

  private async readJson<T>(filePath: string) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T[];
    } catch {
      return [];
    }
  }

  private async persistAll() {
    await Promise.all([this.persistDevices(), this.persistGroups()]);
  }

  private async persistDevices() {
    await fs.writeFile(this.devicesPath, `${JSON.stringify(this.listDevices(), null, 2)}\n`, "utf8");
  }

  private async persistGroups() {
    const groups = [...this.groups.values()].sort((left, right) => left.order - right.order);
    await fs.writeFile(this.groupsPath, `${JSON.stringify(groups, null, 2)}\n`, "utf8");
  }
}
