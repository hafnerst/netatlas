/**
 * What a device listens on because of its services and applications: one
 * definition for validation (binding conflicts), the simulation (which
 * ports are open, and on which addresses) and the details. Pure.
 *
 * A service listens on all of the device's addresses, on its port (the
 * profile's conventional one when none is written: NTP udp/123, an MQTT
 * broker tcp/1883 …). A listener application listens on its port, on all
 * addresses or, with `bind`, on one interface's addresses only.
 */
import { appProfile } from '../model/applications';
import type { Device } from '../model/types';

export interface Listener {
  proto: 'tcp' | 'udp';
  port: number;
  /** listens on this interface's addresses only (none: all of the device's) */
  bind?: string;
  /** what listens: a service ("NTP") or an application ("app:registers") */
  owner: string;
  /** the application's id, when an application listens */
  app?: string;
}

/** The conventional port of the MQTT broker service (IANA: 1883 without TLS). */
export const MQTT_PORT = 1883;

/** The ports a device's services listen on (all addresses). */
export function serviceListeners(d: Device | undefined): Listener[] {
  const out: Listener[] = [];
  if (!d) return out;
  const add = (proto: 'tcp' | 'udp', port: number, owner: string): void => {
    if (!out.some((x) => x.proto === proto && x.port === port)) out.push({ proto, port, owner });
  };
  const s = d.appServices;
  if (s) {
    if (s.has('ntp')) add('udp', 123, 'NTP');
    const aaa = s.get('aaa');
    if (aaa) aaa.values.protocol === 'tacacs' ? add('tcp', 49, 'AAA') : add('udp', 1812, 'AAA');
    const log = s.get('syslog');
    if (log) add(log.values.transport === 'tcp' ? 'tcp' : 'udp', typeof log.values.port === 'number' ? (log.values.port as number) : 514, 'Syslog collector');
    const px = s.get('proxy');
    if (px && typeof px.values.listener === 'number') add('tcp', px.values.listener as number, 'Proxy');
    const lb = s.get('load_balancing');
    if (lb && typeof lb.values.port === 'number') add('tcp', lb.values.port as number, 'Load balancing');
    if (s.has('wireless_controller')) add('udp', 5246, 'Wireless controller');
    const st = s.get('storage');
    for (const p of st && Array.isArray(st.values.protocols) ? (st.values.protocols as string[]) : []) add('tcp', p === 'nfs' ? 2049 : p === 'smb' ? 445 : 3260, 'Storage service');
    const mq = s.get('mqtt_broker');
    if (mq) add('tcp', typeof mq.values.port === 'number' ? (mq.values.port as number) : MQTT_PORT, 'MQTT broker');
    const ptp = s.get('ptp');
    if (ptp) {
      add('udp', 319, 'PTP (event messages)');
      add('udp', 320, 'PTP (general messages)');
    }
  }
  return out;
}

/** The ports its listener applications listen on, each with its bind interface. */
export function appListeners(d: Device | undefined): Listener[] {
  const out: Listener[] = [];
  for (const a of d && d.applications ? d.applications : []) {
    const p = appProfile(a.profile);
    if (!p || !p.listener || a.port === undefined) continue;
    out.push({ proto: p.transport, port: a.port, bind: a.bind, owner: `application ${a.id}`, app: a.id });
  }
  return out;
}

/** Everything a device listens on: its services' ports, then its applications'. */
export function deviceListeners(d: Device | undefined): Listener[] {
  return serviceListeners(d).concat(appListeners(d));
}

/** Two listeners claim the same transport, port and address (both on all addresses, or one on all, or the same interface)? */
export function listenersConflict(a: Listener, b: Listener): boolean {
  return a.proto === b.proto && a.port === b.port && (a.bind === undefined || b.bind === undefined || a.bind === b.bind);
}
