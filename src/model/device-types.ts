/**
 * The device types of the format. A device's `type` must be one of these
 * identifiers (or be absent); anything else is a validation error.
 */
export interface DeviceTypeDef {
  /** identifier used in YAML */
  id: string;
  /** name shown in the UI */
  label: string;
}

export const DEVICE_TYPES: ReadonlyArray<DeviceTypeDef> = [
  { id: 'router', label: 'Router' },
  { id: 'switch', label: 'Switch' },
  { id: 'firewall', label: 'Firewall' },
  { id: 'ap', label: 'Access point' },
  { id: 'server', label: 'Server' },
  { id: 'vm', label: 'Virtual machine' },
  { id: 'container', label: 'Container' },
  { id: 'storage', label: 'Storage' },
  { id: 'load_balancer', label: 'Load balancer' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'ids_ips', label: 'IDS/IPS' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'endpoint', label: 'Endpoint' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'system', label: 'System' },
];

export const DEVICE_TYPE_IDS: ReadonlyArray<string> = DEVICE_TYPES.map((t) => t.id);

/** Model value of a device without a (valid) type. */
export const NO_DEVICE_TYPE = 'generic';

export function isDeviceType(id: string): boolean {
  return DEVICE_TYPE_IDS.indexOf(id) >= 0;
}

/** Display name of a device type; '' for a device without a valid type. */
export function deviceTypeLabel(id: string): string {
  for (const t of DEVICE_TYPES) if (t.id === id) return t.label;
  return '';
}

/** Second line of a device box: the display name of its type. */
export function deviceSubtitle(type: string): string {
  return deviceTypeLabel(type);
}
