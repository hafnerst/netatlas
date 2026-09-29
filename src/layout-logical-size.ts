/** Node sizes for the logical view (shared by layout and rendering). */
import { textWidth } from './geometry';

export const HUB_R = 12;
export const DEVICE_H = 50;
export const CHIP_H = 16;
/** loopback chips shown under a device in the logical view */
export const MAX_CHIPS = 3;

/** Number of chip rows below the device box (loopbacks, plus a "+N more" row). */
export function chipRows(loopbackCount: number): number {
  return loopbackCount === 0 ? 0 : Math.min(loopbackCount, MAX_CHIPS) + (loopbackCount > MAX_CHIPS ? 1 : 0);
}

export function logicalDeviceSize(label: string, loopbackCount: number): { w: number; h: number } {
  const rows = chipRows(loopbackCount);
  return { w: Math.max(140, Math.min(250, textWidth(label, 13) + 64)), h: DEVICE_H + (rows ? rows * CHIP_H + 6 : 0) };
}

export function networkSize(label: string, sub: string): { w: number; h: number } {
  return { w: Math.max(120, textWidth(label, 12) + 34, textWidth(sub, 10) + 34), h: sub ? 42 : 32 };
}

export function networkSubtitle(kind: string, cidr: string[], vlan?: string): string {
  const parts: string[] = [];
  if (vlan) parts.push('VLAN ' + vlan);
  if (cidr.length) parts.push(cidr.slice(0, 2).join(', ') + (cidr.length > 2 ? ' …' : ''));
  if (!parts.length) parts.push(kind);
  return parts.join(' · ');
}
