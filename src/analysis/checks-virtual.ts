/**
 * Consistency checks of virtualization: what the virtual networking of the
 * model says against its cabling and addressing. Each runs only on data
 * that is present (an uplink without a cable, a port without VLANs, an
 * address in no network say nothing).
 *
 *   vswitch-uplink-vlan    a port group's VLAN that the switch port at the
 *                          far end of an uplink doesn't carry
 *   vnic-network-vlan      a guest's address in a network of another VLAN
 *                          than its port group's (or its passthrough port's)
 *   container-parent-vlan  a macvlan / ipvlan network whose subnet is in
 *                          another VLAN than its parent interface's
 *   ha-restart-portgroup   a VM of an HA cluster that can't restart on
 *                          another member (a port group missing there, or
 *                          bound to a host port by passthrough)
 *   hypervisor-overcommit  more vCPUs or memory in a hypervisor's VMs than
 *                          its inventory (info; both sides must be given)
 */
import { endL2, isBridgePort } from '../model/derive';
import { inPrefix } from './ipmath';
import { parsePrefix } from '../model/ip';
import { Device, Interface, LinkEnd, Model, ifaceKey } from '../model/types';
import { clusterMembers, guestsOf, portGroupL2, portGroupOf, sizeBytes, uplinkPorts, vnicPortGroup } from '../model/virtual';
import type { CheckDef } from './checks';

const iref = (d: string, i: string): string => `iface:${d}:${i}`;

/** The far end of a host port's cable, if cabled. */
function farEnd(model: Model, device: string, port: string): LinkEnd | undefined {
  const lid = model.index.ifaceLink.get(ifaceKey(device, port));
  const l = lid !== undefined ? model.index.links.get(lid) : undefined;
  if (!l) return undefined;
  return l.a.device === device && l.a.iface === port ? l.b : l.a;
}

/** The VLAN of the networks an address lies in (one VLAN, when they agree). */
function addrVlan(model: Model, text: string): { vlan: number; net: string } | undefined {
  const p = parsePrefix(text, false);
  if (!p) return undefined;
  let found: { vlan: number; net: string } | undefined;
  for (const n of model.networks) {
    if (n.vlan === undefined || !n.cidr) continue;
    const np = parsePrefix(n.cidr);
    if (!np || !inPrefix(np, p)) continue;
    if (found && found.vlan !== n.vlan) return undefined;
    found = { vlan: n.vlan, net: n.id };
  }
  return found;
}

/** The VLAN a host port's untagged frames are in at the far switch port (its access VLAN or native VLAN). */
function farUntagged(model: Model, host: string, port: string): { vlan: number; where: string } | undefined {
  const fe = farEnd(model, host, port);
  const l2 = fe ? endL2(model, fe) : undefined;
  if (!fe || !l2 || !isBridgePort(l2) || l2.untagged === undefined) return undefined;
  return { vlan: l2.untagged, where: `${fe.device}:${fe.iface}` };
}

export const VIRTUAL_CHECKS: CheckDef[] = [
  {
    id: 'vswitch-uplink-vlan',
    severity: 'error',
    title: 'Port group VLAN not carried by the switch port at an uplink',
    reads: 'services.hypervisor: vswitches (uplinks, port_groups); links; interfaces: vlans, native (at the uplinks’ far ends)',
    run(model, emit) {
      for (const h of model.devices) {
        if (!h.hypervisor) continue;
        h.hypervisor.vswitches.forEach((vs, vi) => {
          for (const port of uplinkPorts(model, h, vs)) {
            const fe = farEnd(model, h.id, port);
            const l2 = fe ? endL2(model, fe) : undefined;
            if (!fe || !l2 || !isBridgePort(l2)) continue;
            vs.portGroups.forEach((pg, pi) => {
              const pl = portGroupL2(pg);
              const missing = pl.vlans.filter((v) => l2.vlans.indexOf(v) < 0);
              if (!missing.length) return;
              emit({
                message: `port group "${pg.name}" of ${h.id} ${vs.name} (VLAN ${missing.join(', ')}): ${fe.device}:${fe.iface}, the switch port at uplink ${port}, doesn't carry ${missing.length > 1 ? 'them' : 'it'} — its frames are dropped there`,
                refs: ['device:' + h.id, iref(h.id, port), iref(fe.device, fe.iface as string)],
                at: { ref: 'device:' + h.id, field: `services.hypervisor.vswitches.${vi}.port_groups.${pi}.vlans` },
              });
            });
          }
        });
      }
    },
  },
  {
    id: 'vnic-network-vlan',
    severity: 'warning',
    title: 'Guest address in a network of another VLAN than its port group’s',
    reads: 'logical_interfaces (vnic): port_group, passthrough, ip; services.hypervisor: port_groups; networks: cidr, vlan; links',
    run(model, emit) {
      for (const d of model.devices) {
        for (const i of d.logical) {
          if (i.type !== 'vnic') continue;
          // the VLAN of its untagged frames: its port group's, or (passthrough) the far switch port's
          let vlan: number | undefined;
          let why = '';
          const x = vnicPortGroup(model, i);
          if (x) {
            vlan = portGroupL2(x.pg).untagged;
            why = `port group "${x.pg.name}"`;
          } else if (i.passthrough !== undefined && d.host !== undefined) {
            const f = farUntagged(model, d.host, i.passthrough);
            if (f) {
              vlan = f.vlan;
              why = `its passthrough port ${d.host}:${i.passthrough} (at ${f.where})`;
            }
          }
          for (const a of i.addresses) {
            const av = addrVlan(model, a);
            if (!av || vlan === undefined || av.vlan === vlan) continue;
            emit({ message: `${d.id}:${i.id} has ${a.split('/')[0]} in network ${av.net} (VLAN ${av.vlan}), but ${why} puts it in VLAN ${vlan}`, refs: [iref(d.id, i.id), 'network:' + av.net], at: { ref: iref(d.id, i.id), field: 'ip' } });
          }
          // its VLAN subinterfaces: their VLAN must pass the port group (guest tagging passes every one)
          if (!x) continue;
          const pl = portGroupL2(x.pg);
          for (const sub of d.logical) {
            if (sub.type !== 'virtual' || sub.id.indexOf(i.id + '.') !== 0) continue;
            for (const a of sub.addresses) {
              const av = addrVlan(model, a);
              if (!av || pl.kind === 'guest' || pl.vlans.indexOf(av.vlan) >= 0) continue;
              emit({ message: `${d.id}:${sub.id} has ${a.split('/')[0]} in network ${av.net} (VLAN ${av.vlan}), which port group "${x.pg.name}" doesn't carry (VLAN ${pl.vlans.join(', ')})`, refs: [iref(d.id, sub.id), 'network:' + av.net], at: { ref: iref(d.id, sub.id), field: 'ip' } });
            }
          }
        }
      }
    },
  },
  {
    id: 'container-parent-vlan',
    severity: 'warning',
    title: 'macvlan / ipvlan network in another VLAN than its parent interface',
    reads: 'services.container_engine: networks (parent, subnet); interfaces; networks: cidr, vlan; links',
    run(model, emit) {
      for (const h of model.devices) {
        if (!h.containerEngine) continue;
        h.containerEngine.networks.forEach((n, ni) => {
          if ((n.driver !== 'macvlan' && n.driver !== 'ipvlan') || !n.parent || !n.subnet) return;
          const av = addrVlan(model, n.subnet);
          if (!av) return;
          const p = model.index.interfaces.get(ifaceKey(h.id, n.parent));
          if (!p) return;
          let vlan: number | undefined;
          let why = '';
          const dot = p.id.lastIndexOf('.');
          if (p.type === 'virtual' && dot > 0 && /^[0-9]+$/.test(p.id.slice(dot + 1))) {
            vlan = Number(p.id.slice(dot + 1));
            why = `its parent ${p.id} (VLAN ${vlan})`;
          } else if (p.type === 'vnic') {
            const x = vnicPortGroup(model, p);
            vlan = x ? portGroupL2(x.pg).untagged : undefined;
            why = x ? `its parent ${p.id} on port group "${x.pg.name}"` : '';
          } else if (p.type === 'physical') {
            const f = farUntagged(model, h.id, p.id);
            vlan = f ? f.vlan : undefined;
            why = f ? `its parent ${p.id} (at ${f.where})` : '';
          }
          if (vlan === undefined || vlan === av.vlan) return;
          emit({ message: `container network "${n.name}" of ${h.id}: its subnet ${n.subnet} is in network ${av.net} (VLAN ${av.vlan}), but ${why} is in VLAN ${vlan}`, refs: ['device:' + h.id, iref(h.id, p.id), 'network:' + av.net], at: { ref: 'device:' + h.id, field: `services.container_engine.networks.${ni}.parent` } });
        });
      }
    },
  },
  {
    id: 'ha-restart-portgroup',
    severity: 'warning',
    title: 'VM of an HA cluster that can’t restart on another member',
    reads: 'services.hypervisor: cluster, port_groups; devices (vm): host; logical_interfaces (vnic): port_group, passthrough',
    run(model, emit) {
      for (const h of model.devices) {
        if (!h.hypervisor || !h.hypervisor.cluster) continue;
        const others = clusterMembers(model, h.hypervisor.cluster).filter((m) => m !== h);
        if (!others.length) continue;
        for (const vm of guestsOf(model, h.id)) {
          if (vm.type !== 'vm') continue;
          const pt = vm.logical.find((i) => i.type === 'vnic' && i.passthrough !== undefined);
          if (pt) {
            emit({ message: `${vm.id} is bound to ${h.id}:${pt.passthrough} by passthrough: it can't restart on another member of cluster ${h.hypervisor.cluster}`, refs: ['device:' + vm.id, iref(vm.id, pt.id), 'device:' + h.id], at: { ref: iref(vm.id, pt.id), field: 'passthrough' } });
            continue;
          }
          for (const o of others) {
            const missing = vm.logical.filter((i) => i.type === 'vnic' && i.portGroup !== undefined && !portGroupOf(o, i.portGroup));
            if (!missing.length) continue;
            emit({ message: `${vm.id} can't restart on ${o.id} (cluster ${h.hypervisor.cluster}): it has no port group ${missing.map((i) => `"${i.portGroup}"`).join(', ')}`, refs: ['device:' + vm.id, 'device:' + o.id], at: { ref: iref(vm.id, missing[0].id), field: 'port_group' } });
          }
        }
      }
    },
  },
  {
    id: 'hypervisor-overcommit',
    severity: 'info',
    title: 'More vCPUs or memory in a hypervisor’s VMs than it has',
    reads: 'services.hypervisor: cpu, ram; devices (vm): host, vcpu, ram',
    run(model, emit) {
      for (const h of model.devices) {
        if (!h.hypervisor) continue;
        const vms = guestsOf(model, h.id).filter((g) => g.type === 'vm');
        const cpu = vms.filter((v) => v.vcpu !== undefined);
        const ram = vms.filter((v) => sizeBytes(v.ram) !== undefined);
        const total = (xs: Device[], f: (d: Device) => number): number => xs.reduce((s, d) => s + f(d), 0);
        if (h.hypervisor.cpu !== undefined && cpu.length) {
          const n = total(cpu, (d) => d.vcpu as number);
          if (n > h.hypervisor.cpu) emit({ message: `the VMs of ${h.id} have ${n} vCPUs, more than its ${h.hypervisor.cpu} cores (overcommitted ${(n / h.hypervisor.cpu).toFixed(1)}:1)`, refs: ['device:' + h.id].concat(cpu.map((d) => 'device:' + d.id)), at: { ref: 'device:' + h.id, field: 'services.hypervisor.cpu' } });
        }
        const cap = sizeBytes(h.hypervisor.ram);
        if (cap !== undefined && ram.length) {
          const n = total(ram, (d) => sizeBytes(d.ram) as number);
          if (n > cap) emit({ message: `the VMs of ${h.id} have ${gib(n)} of memory, more than its ${h.hypervisor.ram}`, refs: ['device:' + h.id].concat(ram.map((d) => 'device:' + d.id)), at: { ref: 'device:' + h.id, field: 'services.hypervisor.ram' } });
        }
      }
    },
  },
];

function gib(n: number): string {
  const g = n / Math.pow(1024, 3);
  return `${Number.isInteger(g) ? g : g.toFixed(1)} GiB`;
}

/** (for the tests) the vnics of a device */
export function vnicsOf(d: Device): Interface[] {
  return d.logical.filter((i) => i.type === 'vnic');
}
