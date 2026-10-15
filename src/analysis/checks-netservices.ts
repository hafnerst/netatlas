/**
 * The consistency checks of the servers' DHCP and DNS services: a DHCP
 * client with no server it can reach (in its broadcast domain, or through a
 * DHCP relay on a router's interface there), and a relay that points to no
 * DHCP server of the model. A client whose cable goes to a cloud (a
 * provider's network) is served from outside the model. Pure.
 */
import { formatAddr, inPrefix, networkOf } from './ipmath';
import { IpAddr, parsePrefix } from '../model/ip';
import { Device, Model, deviceInterfaces } from '../model/types';
import { broadcastPeers, buildNet } from './sim/net';

type Emit = (f: { message: string; refs: string[]; at: { ref: string; field?: string } }) => void;

interface SvcCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  reads: string;
  run(model: Model, emit: Emit): void;
}

/** The DHCP servers of the model and the IPv4 networks of their scopes. */
function dhcpServers(model: Model): Array<{ d: Device; nets: Array<ReturnType<typeof networkOf>> }> {
  const out: Array<{ d: Device; nets: Array<ReturnType<typeof networkOf>> }> = [];
  for (const d of model.devices) {
    const dh = d.netServices && d.netServices.dhcp;
    if (!dh) continue;
    const nets = dh.scopes
      .map((s) => model.networks.find((n) => n.id === s.network))
      .map((n) => (n && n.cidr ? parsePrefix(n.cidr) : null))
      .filter((p): p is NonNullable<typeof p> => !!p && p.version === 4)
      .map((p) => networkOf(p));
    out.push({ d, nets });
  }
  return out;
}

/** The IPv4 addresses of a device. */
function v4Addrs(d: Device): IpAddr[] {
  const out: IpAddr[] = [];
  for (const i of deviceInterfaces(d)) for (const t of i.addresses) {
    const p = parsePrefix(t, false);
    if (p && p.version === 4) out.push({ version: 4, bytes: p.bytes });
  }
  return out;
}

export const NETSERVICE_CHECKS: SvcCheck[] = [
  {
    id: 'dhcp-no-server',
    severity: 'warning',
    title: 'A DHCP client that reaches no DHCP server',
    reads: 'interfaces: dhcp, dhcp_relay; servers: services dhcp scopes; links and their VLAN tagging',
    run(model, emit) {
      const servers = dhcpServers(model);
      // (no DHCP server in the model at all: the model doesn't describe its DHCP; nothing is reported)
      if (!servers.length) return;
      const net = buildNet(model);
      for (const d of model.devices) {
        for (const i of deviceInterfaces(d)) {
          if (!i.dhcp) continue;
          // a cable to a cloud: a provider's DHCP, outside the model
          const toCloud = model.links.some((l) => {
            const me = (l.a.device === d.id && l.a.iface === i.id) || (l.b.device === d.id && l.b.iface === i.id);
            const o = l.a.device === d.id ? l.b.device : l.a.device;
            return me && (model.index.devices.get(o) || { type: '' }).type === 'cloud';
          });
          if (toCloud) continue;
          const peers = broadcastPeers(net, d.id, i.id);
          const served = peers.some((p) => {
            // a server in the same broadcast domain with a scope of that subnet
            const s = servers.find((x) => x.d.id === p.dev);
            if (s && p.l3.addrs.some((a) => s.nets.some((n) => inPrefix(n, a.addr)))) return true;
            // a relay there to a server with a scope of the relay's subnet
            const ri = model.index.interfaces.get(p.dev + ':' + p.l3.id);
            if (!ri || !ri.dhcpRelay) return false;
            return ri.dhcpRelay.some((ra) => servers.some((x) => v4Addrs(x.d).some((a) => formatAddr(a) === ra) && p.l3.addrs.some((a) => x.nets.some((n) => inPrefix(n, a.addr)))));
          });
          if (served) continue;
          emit({
            message: `${d.id}:${i.id} takes its address by DHCP, but no DHCP server of the model reaches it: none with a scope of its subnet in its broadcast domain, and no DHCP relay there (dhcp_relay on the router's interface) to one`,
            refs: ['device:' + d.id, `iface:${d.id}:${i.id}`],
            at: { ref: `iface:${d.id}:${i.id}`, field: 'dhcp' },
          });
        }
      }
    },
  },
  {
    id: 'dhcp-relay-no-server',
    severity: 'warning',
    title: 'A DHCP relay to an address that is no DHCP server of the model',
    reads: 'interfaces: dhcp_relay; servers: services dhcp',
    run(model, emit) {
      const servers = dhcpServers(model);
      for (const d of model.devices) {
        for (const i of deviceInterfaces(d)) {
          for (const ra of i.dhcpRelay || []) {
            if (servers.some((x) => v4Addrs(x.d).some((a) => formatAddr(a) === ra))) continue;
            emit({ message: `${d.id}:${i.id} relays DHCP to ${ra}, which is no DHCP server of the model`, refs: ['device:' + d.id, `iface:${d.id}:${i.id}`], at: { ref: `iface:${d.id}:${i.id}`, field: 'dhcp_relay' } });
          }
        }
      }
    },
  },
];
