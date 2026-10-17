/**
 * PTP (the `ptp` service, model/ptp.ts) with the whole model: what its
 * clock function needs of the device and its interfaces. The parameters
 * themselves are the registry's (their types, ranges and the profile's
 * conditions).
 *
 *   ordinary     one PTP port: an interface of its own with an IPv4
 *                address (UDP/IPv4); its role (may become the grandmaster,
 *                or receiver only) is written;
 *   boundary     two or more such ports, on a device that forwards (a
 *                router, a Layer 3 switch, a routed firewall, a forwarding
 *                System): synchronized on one, a source on the others;
 *   transparent  a bridge's ports (a switch's, without addresses): it
 *                corrects what it forwards between them, never becomes a
 *                time source, keeps no election data.
 * The intervals are the profile's powers of two; an offset and a drift are
 * written with their units. Nothing is substituted: a function the device
 * can't have is an error, never another function.
 */
import { capabilities } from '../model/capabilities';
import { parseClockOffset, parseDrift, PTP_RANGES } from '../model/ptp';
import { Model, ifaceKey } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { Ctx, get } from './reader';
import { ServiceNodes } from './services';

export function checkPtp(c: Ctx, model: Model, all: ServiceNodes[]): void {
  for (const sn of all) {
    const d = model.index.devices.get(sn.device);
    const svc = d && d.appServices ? d.appServices.get('ptp') : undefined;
    if (!d || !svc || !sn.map) continue;
    const node = get(sn.map, 'ptp') as YMap;
    const path = `${sn.path}.ptp`;
    const at = (k: string): YNode => ((node && node.kind === 'map' ? get(node, k) : undefined) || node) as YNode;
    const v = svc.values;
    const clock = v.clock as string | undefined;
    const ifs = Array.isArray(v.interfaces) ? (v.interfaces as string[]) : [];
    const caps = capabilities(d);
    if (clock === 'transparent') {
      if (!caps.l2Forward) c.error(at('clock'), path + '.clock', `"${d.id}" bridges nothing: a transparent clock corrects the frames a switch forwards — choose ordinary or boundary`);
      for (const id of ifs) {
        const i = model.index.interfaces.get(ifaceKey(d.id, id));
        if (!i) continue;
        if (i.addresses.length || i.dhcp || i.type === 'loopback' || i.type === 'tunnel' || (i.type === 'virtual' && !i.members.length)) c.error(at('interfaces'), path + '.interfaces', `${id} is not a port of the switch: a transparent clock's ports are the ports it forwards between (an ordinary or boundary clock's ports have addresses)`);
      }
      if (ifs.length && ifs.length < 2) c.error(at('interfaces'), path + '.interfaces', 'a transparent clock corrects between its ports: name at least two');
    } else if (clock === 'ordinary' || clock === 'boundary') {
      if (clock === 'ordinary' && ifs.length !== 1 && ifs.length) c.error(at('interfaces'), path + '.interfaces', `an ordinary clock has one PTP port: ${ifs.length} are named — choose one, or make it a boundary clock`);
      if (clock === 'boundary') {
        if (ifs.length === 1) c.error(at('interfaces'), path + '.interfaces', 'a boundary clock has several PTP ports (synchronized on one, a source on the others): name at least two, or make it an ordinary clock');
        if (!caps.l3Forward && !caps.l2Forward) c.error(at('clock'), path + '.clock', `"${d.id}" forwards nothing: a boundary clock sits between networks (a router, a Layer 3 switch) — make it an ordinary clock`);
      }
      for (const id of ifs) {
        const i = model.index.interfaces.get(ifaceKey(d.id, id));
        if (!i) continue;
        // UDP/IPv4: its PTP port sends from an IPv4 address of its own (configured, or a DHCP lease)
        if (!i.dhcp && !i.addresses.some((a) => a.indexOf(':') < 0)) c.error(at('interfaces'), path + '.interfaces', `${id} has no IPv4 address: the profile carries PTP over UDP/IPv4 — give it an address, or name an interface that has one`);
      }
    }
    const pow = (k: string, ok: readonly number[], what: string): void => {
      const x = v[k];
      if (typeof x === 'number' && ok.indexOf(x) < 0) c.error(at(k), `${path}.${k}`, `the ${what} is one of ${ok.map((s) => s / 1000 + ' s').join(', ')} in this profile`);
    };
    pow('announce_interval', PTP_RANGES.announce, 'Announce interval');
    pow('sync_interval', PTP_RANGES.sync, 'Sync interval');
    pow('delay_req_interval', PTP_RANGES.delayReq, 'Delay request interval');
    if (typeof v.clock_offset === 'string' && parseClockOffset(v.clock_offset as string) === null) c.error(at('clock_offset'), path + '.clock_offset', `"${v.clock_offset}" is not an offset: write it with its sign and unit (+250us, -3ms, 0)`);
    if (typeof v.drift === 'string' && parseDrift(v.drift as string) === null) c.error(at('drift'), path + '.drift', `"${v.drift}" is not a drift: write it in ppm (20ppm, -5ppm), at most ±1000 ppm`);
    if (v.role === 'receiver_only' && typeof v.clock_class === 'number' && (v.clock_class as number) !== 255) c.error(at('clock_class'), path + '.clock_class', 'a receiver-only clock announces clock class 255: delete "clock_class" (it never becomes a time source)');
  }
}
