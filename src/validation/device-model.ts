/**
 * The parts of a device that say what it is and how it does it: its kind
 * (and `kind_label` for `other`), its role, its mode, a System's purpose and
 * icon, its port pairs and management interfaces, and the built-in
 * functions of the appliance types — a VPN gateway's VPN gateway
 * (`services.vpn`) and a Security gateway's Domain separation
 * (`services.separation`). Read with each device; what they reference
 * (interfaces, networks, domains, profiles) is checked once every device is
 * read (checkDeviceModel). Nothing is chosen for the user: every value the
 * behaviour depends on must be written.
 */
import { capabilities } from '../model/capabilities';
import { kindsOf, modesOf, purposeDef, ROLES, SYSTEM_PURPOSES, typeDef } from '../model/device-types';
import { parseAddress, parsePrefix } from '../model/ip';
import { Device, Interface, Network, PortPair, SEPARATION_IMPLEMENTATIONS, SeparationRule, SeparationService, TRANSFER_PROFILES, TransferProfile, VPN_OPERATIONS, VPN_TECHNOLOGIES, VpnService } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, Reader, get, isNull, suggest } from './reader';
import { readSvcSim } from './virtual';
import { SvcDef, serviceDef, serviceEligibility, isBuiltIn } from '../model/service-registry';

/** where a device's model parts are written, for the checks with the whole model */
export interface DeviceModelNodes {
  device: string;
  map: YMap;
  path: string;
  pairs?: Array<{ node: YMap; path: string; pair: PortPair }>;
  managementNode?: YNode;
  vpnNode?: YMap;
  separationNode?: YMap;
}

/** "a router", "a Security gateway", "a device without a type" (in a sentence). */
function aType(type: string): string {
  const t = typeDef(type);
  if (!t) return 'a device without a type';
  return (/^[AEIOU]/.test(t.label) && !/^(Endpoint|IDS)/.test(t.label) ? 'an ' : 'a ') + t.label;
}

const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,39}$/;

/** A role as written, matched to a known one by its id or name (any case); a custom role as written. */
export function normalizeRole(text: string): string {
  const k = text.trim().toLowerCase().replace(/\s*\/\s*/g, '/').replace(/[\s-]+/g, '_');
  for (const r of ROLES) {
    if (r.id === k) return r.id;
    const l = r.label.toLowerCase().replace(/\s*\/\s*/g, '/').replace(/[\s-]+/g, '_');
    if (l === k || l.split('/').indexOf(k) >= 0) return r.id;
  }
  return text.trim();
}

/** Kind, role, mode, purpose and icon of a device. */
export function readDeviceModel(r: Reader, c: Ctx, m: YMap, dpath: string, dev: Device, nodes: DeviceModelNodes): void {
  const def = typeDef(dev.type);
  // kind (and its own name when it is "other")
  const kn = get(m, 'kind');
  const kl = r.field(m, 'kind_label', dpath, 60);
  if (!isNull(kn)) {
    const k = r.str(kn, dpath + '.kind', 40);
    if (k !== undefined) {
      if (!def) c.error(kn as YNode, dpath + '.kind', `a kind is a subtype of the device's type: "${dev.id}" has no type yet — choose its type first`);
      else if (!kindsOf(dev.type).some((x) => x.id === k)) {
        const list = kindsOf(dev.type).map((x) => x.id).join(', ');
        c.error(kn as YNode, dpath + '.kind', `"${k}" is not a kind of ${def.label}${suggest(k, kindsOf(dev.type).map((x) => x.id))} (its kinds: ${list}; "other" with kind_label for any other)`);
      } else {
        dev.kind = k;
        if (k === 'other') {
          if (kl === undefined) c.error(m, dpath + '.kind_label', `kind "other" needs its name: write kind_label (e.g. "Fiber modem")`, { key: 'kind_label' });
          else dev.kindLabel = kl;
        }
      }
    }
  }
  if (kl !== undefined && dev.kind !== 'other' && (dev.kind !== undefined || isNull(kn))) {
    c.error(get(m, 'kind_label') as YNode, dpath + '.kind_label', `kind_label names a kind "other"; ${dev.kind ? `"${dev.id}" is of kind "${dev.kind}" — delete kind_label` : `"${dev.id}" has no kind — write kind: other, or delete kind_label`}`);
  }
  // role: a known one (by id or name) or a custom one
  const rn = get(m, 'role');
  if (!isNull(rn)) {
    const t = r.str(rn, dpath + '.role', 40);
    if (t !== undefined) {
      if (!ROLE_RE.test(t)) c.error(rn as YNode, dpath + '.role', `"${t}" is not a role: a role is a short name (letters, digits, spaces, - _ . /), e.g. ${ROLES.slice(0, 4).map((x) => x.id).join(', ')} or a role of your own`);
      else dev.role = normalizeRole(t);
    }
  }
  // mode: the type's
  const mn = get(m, 'mode');
  if (!isNull(mn)) {
    const t = r.str(mn, dpath + '.mode', 40);
    const ms = modesOf(dev.type);
    if (t !== undefined) {
      if (!ms.length) c.error(mn as YNode, dpath + '.mode', `${aType(dev.type)} has no mode — delete "mode" (a Firewall, an IDS/IPS and an Access point have one)`);
      else if (!ms.some((x) => x.id === t)) c.error(mn as YNode, dpath + '.mode', `"${t}" is not a mode of ${typeDef(dev.type)!.label}: use ${ms.map((x) => x.id).join(' or ')}`);
      else dev.mode = t;
    }
  }
  // a System's purpose (required) and icon
  const isSystem = def !== undefined && def.behaviour === 'system';
  const pn = get(m, 'purpose');
  if (isSystem) {
    if (isNull(pn)) c.error(m, dpath + '.purpose', `System "${dev.id}" needs its purpose: what it does (${SYSTEM_PURPOSES.map((p) => p.id).join(', ')})`, { key: 'purpose' });
    else {
      const t = r.str(pn, dpath + '.purpose', 40);
      if (t !== undefined) {
        if (!purposeDef(t)) c.error(pn as YNode, dpath + '.purpose', `"${t}" is not a purpose${suggest(t, SYSTEM_PURPOSES.map((p) => p.id))}: use ${SYSTEM_PURPOSES.map((p) => p.id).join(', ')}`);
        else dev.purpose = t;
      }
    }
  } else if (!isNull(pn)) c.error(pn as YNode, dpath + '.purpose', `only a System has a purpose; "${dev.id}" is ${aType(dev.type)}, whose behaviour is its type's — delete "purpose"`);
  const icn = get(m, 'icon');
  if (!isNull(icn)) {
    const t = r.str(icn, dpath + '.icon', 40);
    if (t !== undefined) {
      if (!isSystem) c.error(icn as YNode, dpath + '.icon', `only a System chooses its icon; "${dev.id}" is ${aType(dev.type)} (its kind may have an icon of its own) — delete "icon"`);
      else {
        const p = purposeDef(dev.purpose);
        if (!p) c.error(icn as YNode, dpath + '.icon', `a System's icon is one of its purpose's: choose its purpose first`);
        else if (!p.icons.some((x) => x.id === t)) c.error(icn as YNode, dpath + '.icon', `"${t}" is not an icon of a ${p.label} System: use ${p.icons.map((x) => x.id).join(', ')}`);
        else dev.icon = t;
      }
    }
  }
  nodes.map = m;
  nodes.path = dpath;
  // port pairs and management interfaces (checked against its interfaces later)
  const pairsN = get(m, 'port_pairs');
  if (!isNull(pairsN)) {
    nodes.pairs = [];
    r.list(pairsN, dpath + '.port_pairs').forEach((pn2, j) => {
      const ppath = `${dpath}.port_pairs[${j}]`;
      const pm = r.map(pn2, ppath);
      if (!pm) return;
      r.keys(pm, SCHEMA.portPair, ppath);
      const a = r.reqStr(pm, 'a', ppath, 200);
      const b = r.reqStr(pm, 'b', ppath, 200);
      const dir = r.field(pm, 'direction', ppath, 20);
      if (dir !== undefined && dir !== 'both' && dir !== 'a_to_b') c.error(get(pm, 'direction') as YNode, ppath + '.direction', `"${dir}" is not a direction: use both or a_to_b (only from port a to port b)`);
      const copy = r.list(get(pm, 'copy'), ppath + '.copy', true).map((x, k) => r.str(x, `${ppath}.copy[${k}]`, 200)).filter((x): x is string => x !== undefined);
      if (a === undefined || b === undefined) return;
      const pair: PortPair = { a, b, direction: dir === 'a_to_b' ? 'a_to_b' : 'both', copy, line: pm.line };
      dev.portPairs.push(pair);
      nodes.pairs!.push({ node: pm, path: ppath, pair });
    });
  }
  const mgN = get(m, 'management');
  if (!isNull(mgN)) {
    nodes.managementNode = mgN;
    dev.management = r.list(mgN, dpath + '.management', true).map((x, k) => r.str(x, `${dpath}.management[${k}]`, 200)).filter((x): x is string => x !== undefined);
  }
}

/** The appliance functions in a device's `services:`: a VPN gateway's `vpn`, a Security gateway's `separation` (each required there, nowhere else). */
export function readApplianceFunctions(r: Reader, c: Ctx, n: YNode | undefined, path: string, dev: Device, nodes: DeviceModelNodes): void {
  const m = !isNull(n) && (n as YNode).kind === 'map' ? (n as YMap) : null;
  const vn = m ? get(m, 'vpn') : undefined;
  const sn = m ? get(m, 'separation') : undefined;
  // the VPN gateway: built into a VPN gateway, a service of a router, a routed firewall, a server or a VM (the registry says who)
  const vpnDef = serviceDef('vpn') as SvcDef;
  if (!isNull(vn) && !isBuiltIn(vpnDef, dev)) {
    if (serviceEligibility(vpnDef, dev) === null) readVpn(r, c, vn as YNode, path + '.vpn', dev, nodes);
  } else if (typeDef(dev.type) && typeDef(dev.type)!.behaviour === 'vpn_gateway') {
    if (isNull(vn)) c.error(m || nodes.map, path + '.vpn', `${typeDef('vpn_gateway')!.label} "${dev.id}" needs the configuration of its VPN: its operation (site-to-site or remote access), technology and tunnels or listener`, { key: m ? 'vpn' : 'services' });
    else readVpn(r, c, vn as YNode, path + '.vpn', dev, nodes);
  }
  // Domain separation: built into a Security gateway, and only there
  if (typeDef(dev.type) && typeDef(dev.type)!.behaviour === 'security_gateway') {
    if (isNull(sn)) c.error(m || nodes.map, path + '.separation', `Security gateway "${dev.id}" needs its Domain separation: its implementation, its two domains with their interfaces, and what may cross`, { key: m ? 'separation' : 'services' });
    else readSeparation(r, c, sn as YNode, path + '.separation', dev, nodes);
  }
}

function readVpn(r: Reader, c: Ctx, n: YNode, path: string, dev: Device, nodes: DeviceModelNodes): void {
  const m = r.map(n, path);
  if (!m) return;
  nodes.vpnNode = m;
  r.keys(m, SCHEMA.vpn, path);
  const v: VpnService = { tunnels: [], protected: [], line: m.line };
  const op = r.field(m, 'operation', path, 30);
  if (op === undefined) c.error(m, path + '.operation', `the VPN gateway needs its operation: ${VPN_OPERATIONS.map((x) => `${x.id} (${x.label.toLowerCase()})`).join(' or ')}`, { key: 'operation' });
  else if (!VPN_OPERATIONS.some((x) => x.id === op)) c.error(get(m, 'operation') as YNode, path + '.operation', `"${op}" is not an operation: use ${VPN_OPERATIONS.map((x) => x.id).join(' or ')}`);
  else v.operation = op as VpnService['operation'];
  const tech = r.field(m, 'technology', path, 30);
  if (tech === undefined) c.error(m, path + '.technology', `the VPN gateway needs its technology: ${VPN_TECHNOLOGIES.map((x) => x.id).join(', ')}`, { key: 'technology' });
  else if (!VPN_TECHNOLOGIES.some((x) => x.id === tech)) c.error(get(m, 'technology') as YNode, path + '.technology', `"${tech}" is not a supported VPN technology${suggest(tech, VPN_TECHNOLOGIES.map((x) => x.id))}: use ${VPN_TECHNOLOGIES.map((x) => x.id).join(', ')}`);
  else v.technology = tech;
  const strs = (key: string): string[] => r.list(get(m, key), `${path}.${key}`, true).map((x, k) => r.str(x, `${path}.${key}[${k}]`, 200)).filter((x): x is string => x !== undefined);
  v.tunnels = strs('tunnels');
  v.protected = strs('protected');
  v.listener = r.field(m, 'listener', path, 200);
  v.pool = r.field(m, 'pool', path, 64);
  const only = (key: string, op2: string): void => {
    if (!isNull(get(m, key))) c.error(get(m, key) as YNode, `${path}.${key}`, `"${key}" is for ${op2 === 'site_to_site' ? 'site-to-site' : 'remote access'} operation; this VPN gateway is ${v.operation === 'site_to_site' ? 'site-to-site' : 'remote access'} — delete it`);
  };
  if (v.operation === 'site_to_site') {
    if (!v.tunnels.length) c.error(m, path + '.tunnels', `a site-to-site VPN gateway needs its tunnels: its tunnel interfaces (each with its local endpoint as source and its peer as destination)`, { key: 'tunnels' });
    only('listener', 'remote_access');
    only('pool', 'remote_access');
  }
  if (v.operation === 'remote_access') {
    if (v.listener === undefined) c.error(m, path + '.listener', `a remote-access VPN gateway needs its listener: the interface its clients connect to`, { key: 'listener' });
    if (v.pool === undefined) c.error(m, path + '.pool', `a remote-access VPN gateway needs its client address pool (a prefix, e.g. 10.250.0.0/24)`, { key: 'pool' });
    else if (!parsePrefix(v.pool)) c.error(get(m, 'pool') as YNode, path + '.pool', `"${v.pool}" is not a prefix (write it with its length, e.g. 10.250.0.0/24)`);
    only('tunnels', 'site_to_site');
  }
  if (!v.protected.length && v.operation) c.error(m, path + '.protected', `the VPN gateway needs its protected networks: the networks behind it its tunnels reach (network ids or prefixes)`, { key: 'protected' });
  dev.vpn = v;
}

function readSeparation(r: Reader, c: Ctx, n: YNode, path: string, dev: Device, nodes: DeviceModelNodes): void {
  const m = r.map(n, path);
  if (!m) return;
  nodes.separationNode = m;
  r.keys(m, SCHEMA.separation, path);
  const s: SeparationService = { domains: [], directions: [], rules: [], profiles: [], line: m.line };
  const impl = r.field(m, 'implementation', path, 30);
  if (impl === undefined) c.error(m, path + '.implementation', `Domain separation needs its implementation: ${SEPARATION_IMPLEMENTATIONS.map((x) => `${x.id} (${x.label.toLowerCase()})`).join(', ')}`, { key: 'implementation' });
  else if (!SEPARATION_IMPLEMENTATIONS.some((x) => x.id === impl)) c.error(get(m, 'implementation') as YNode, path + '.implementation', `"${impl}" is not an implementation: use ${SEPARATION_IMPLEMENTATIONS.map((x) => x.id).join(', ')}`);
  else s.implementation = impl as SeparationService['implementation'];
  // the two domains
  const dn = get(m, 'domains');
  const dl = r.list(dn, path + '.domains');
  if (isNull(dn)) c.error(m, path + '.domains', `Domain separation needs its two domains, each with its name and its interfaces (e.g. Red and Black)`, { key: 'domains' });
  else if (dl.length !== 2) c.error(dn as YNode, path + '.domains', `a Security gateway separates exactly two domains; ${dl.length} are written (use another Security gateway for a further boundary)`);
  dl.forEach((x, j) => {
    const dp = `${path}.domains[${j}]`;
    const dm = r.map(x, dp);
    if (!dm) return;
    r.keys(dm, SCHEMA.sepDomain, dp);
    const name = r.reqStr(dm, 'name', dp, 40);
    const ifs = r.list(get(dm, 'interfaces'), dp + '.interfaces', true).map((y, k) => r.str(y, `${dp}.interfaces[${k}]`, 200)).filter((y): y is string => y !== undefined);
    if (isNull(get(dm, 'interfaces'))) c.error(dm, dp + '.interfaces', `domain ${name ? `"${name}"` : j + 1} needs its interfaces: the data interfaces on its side`, { key: 'interfaces' });
    if (name === undefined) return;
    if (s.domains.some((d) => d.name === name)) {
      c.error(get(dm, 'name') as YNode, dp + '.name', `the two domains need different names ("${name}" twice)`);
      return;
    }
    s.domains.push({ name, interfaces: ifs, line: dm.line });
  });
  const names = s.domains.map((d) => d.name);
  const isDomain = (x: string | undefined, node: YNode, p: string): boolean => {
    if (x === undefined) return false;
    if (names.indexOf(x) < 0) {
      c.error(node, p, `"${x}" is not one of its domains${names.length ? ` (${names.join(', ')})` : ''}${suggest(x, names)}`);
      return false;
    }
    return true;
  };
  // the permitted directions
  const dirN = get(m, 'directions');
  if (isNull(dirN)) c.error(m, path + '.directions', `Domain separation needs its permitted directions: from which domain to which information may be transferred (one or both)`, { key: 'directions' });
  r.list(dirN, path + '.directions').forEach((x, j) => {
    const dp = `${path}.directions[${j}]`;
    const dm = r.map(x, dp);
    if (!dm) return;
    r.keys(dm, SCHEMA.sepDirection, dp);
    const from = r.reqStr(dm, 'from', dp, 40);
    const to = r.reqStr(dm, 'to', dp, 40);
    const ok = isDomain(from, get(dm, 'from') as YNode, dp + '.from') && isDomain(to, get(dm, 'to') as YNode, dp + '.to');
    if (!ok || from === undefined || to === undefined) return;
    if (from === to) c.error(dm, dp, `a direction is from one domain to the other: "${from}" to "${to}"`);
    else if (s.directions.some((d) => d.from === from && d.to === to)) c.error(dm, dp, `the direction ${from} → ${to} is written twice`);
    else s.directions.push({ from, to });
  });
  // the profiles (a protocol break's)
  const profN = get(m, 'profiles');
  if (!isNull(profN) && s.implementation && s.implementation !== 'protocol_break') c.error(profN as YNode, path + '.profiles', `transfer profiles are a protocol break's; this implementation (${s.implementation}) forwards permitted traffic itself — delete "profiles"`);
  r.list(profN, path + '.profiles').forEach((x, j) => {
    const pp = `${path}.profiles[${j}]`;
    const pm = r.map(x, pp);
    if (!pm) return;
    r.keys(pm, SCHEMA.transferProfile, pp);
    const id = r.id(pm, pp);
    if (!id) return;
    if (s.profiles.some((p) => p.id === id)) {
      c.error(get(pm, 'id') as YNode, pp + '.id', `duplicate transfer profile "${id}"`);
      return;
    }
    const prof: TransferProfile = { id, line: pm.line };
    const t = r.field(pm, 'type', pp, 30);
    if (t === undefined) c.error(pm, pp + '.type', `transfer profile "${id}" needs its type: what transfer it models (${TRANSFER_PROFILES.map((y) => y.id).join(', ')})`, { key: 'type' });
    else if (!TRANSFER_PROFILES.some((y) => y.id === t)) c.error(get(pm, 'type') as YNode, pp + '.type', `"${t}" is not a transfer NetAtlas can model through a protocol break: supported are ${TRANSFER_PROFILES.map((y) => `${y.id} (${y.label})`).join(', ')}`);
    else prof.type = t;
    const tp = TRANSFER_PROFILES.find((y) => y.id === prof.type);
    const end = (key: 'listen' | 'forward'): YMap | null => {
      const en = get(pm, key);
      if (isNull(en)) {
        c.error(pm, `${pp}.${key}`, key === 'listen' ? `transfer profile "${id}" needs where the gateway listens: listen: {interface, port}` : `transfer profile "${id}" needs where the gateway sends the new transfer: forward: {address, port}`, { key });
        return null;
      }
      const em = r.map(en, `${pp}.${key}`);
      if (em) r.keys(em, key === 'listen' ? SCHEMA.profileListen : SCHEMA.profileForward, `${pp}.${key}`);
      return em;
    };
    const lm = end('listen');
    if (lm) {
      prof.listenInterface = r.reqStr(lm, 'interface', pp + '.listen', 200);
      prof.listenPort = isNull(get(lm, 'port')) ? undefined : r.int(get(lm, 'port'), pp + '.listen.port', 1, 65535, 'port');
      if (isNull(get(lm, 'port'))) c.error(lm, pp + '.listen.port', `transfer profile "${id}" needs the port it listens on${tp ? ` (${tp.label}: usually ${tp.port})` : ''}`, { key: 'port' });
    }
    const fm = end('forward');
    if (fm) {
      prof.forwardAddress = r.reqStr(fm, 'address', pp + '.forward', 64);
      if (prof.forwardAddress !== undefined && !parseAddress(prof.forwardAddress)) c.error(get(fm, 'address') as YNode, pp + '.forward.address', `"${prof.forwardAddress}" is not an address: where the new transfer goes (an address in the other domain)`);
      prof.forwardPort = isNull(get(fm, 'port')) ? undefined : r.int(get(fm, 'port'), pp + '.forward.port', 1, 65535, 'port');
      if (isNull(get(fm, 'port'))) c.error(fm, pp + '.forward.port', `transfer profile "${id}" needs the port it sends to${tp ? ` (${tp.label}: usually ${tp.port})` : ''}`, { key: 'port' });
    }
    s.profiles.push(prof);
  });
  if (s.implementation === 'protocol_break' && isNull(profN)) c.error(m, path + '.profiles', `a protocol break needs its transfer profiles: for each permitted transfer, what it models, where the gateway listens and where it sends the new transfer`, { key: 'profiles' });
  // the rules, in order
  const rulesN = get(m, 'rules');
  r.list(rulesN, path + '.rules').forEach((x, j) => {
    const rp = `${path}.rules[${j}]`;
    const rm = r.map(x, rp);
    if (!rm) return;
    r.keys(rm, SCHEMA.sepRule, rp);
    const id = r.id(rm, rp);
    if (!id) return;
    if (s.rules.some((y) => y.id === id)) {
      c.error(get(rm, 'id') as YNode, rp + '.id', `duplicate rule "${id}"`);
      return;
    }
    const from = r.reqStr(rm, 'from', rp, 40);
    const to = r.reqStr(rm, 'to', rp, 40);
    const okF = isDomain(from, get(rm, 'from') as YNode, rp + '.from');
    const okT = isDomain(to, get(rm, 'to') as YNode, rp + '.to');
    if (okF && okT && from !== undefined && to !== undefined) {
      if (from === to) c.error(rm, rp, `rule "${id}" must go from one domain to the other`);
      else if (!s.directions.some((d) => d.from === from && d.to === to)) c.error(rm, rp + '.from', `rule "${id}" transfers ${from} → ${to}, a direction that is not permitted (directions: ${s.directions.map((d) => `${d.from} → ${d.to}`).join(', ') || 'none'})`, { key: 'from' });
    }
    // every match is written: nothing empty is taken as "any"
    const addr = (key: 'source' | 'destination'): string | undefined => {
      const v = r.field(rm, key, rp, 64);
      if (v === undefined) {
        c.error(rm, `${rp}.${key}`, `rule "${id}" needs its ${key}: an address, a prefix or "any" (written; an empty match is never "any")`, { key });
        return undefined;
      }
      if (v !== 'any' && !parsePrefix(v, false)) c.error(get(rm, key) as YNode, `${rp}.${key}`, `"${v}" is not an address or prefix (or "any")`);
      return v;
    };
    const src = addr('source');
    const dst = addr('destination');
    const proto = r.field(rm, 'protocol', rp, 10);
    if (proto === undefined) c.error(rm, rp + '.protocol', `rule "${id}" needs its protocol: tcp, udp, icmp or any`, { key: 'protocol' });
    else if (['tcp', 'udp', 'icmp', 'any'].indexOf(proto) < 0) c.error(get(rm, 'protocol') as YNode, rp + '.protocol', `"${proto}" is not a protocol of a rule: use tcp, udp, icmp or any`);
    const ports = r.field(rm, 'ports', rp, 120);
    if ((proto === 'tcp' || proto === 'udp') && ports === undefined) c.error(rm, rp + '.ports', `rule "${id}" (${proto}) needs its destination ports: ports or ranges ("443", "8000-8080") or "any"`, { key: 'ports' });
    if (ports !== undefined && proto !== 'tcp' && proto !== 'udp') c.error(get(rm, 'ports') as YNode, rp + '.ports', `ports are for tcp and udp; rule "${id}" is ${proto || 'without a protocol'} — delete them`);
    if (ports !== undefined && ports !== 'any' && !/^\s*\d{1,5}(\s*-\s*\d{1,5})?(\s*,\s*\d{1,5}(\s*-\s*\d{1,5})?)*\s*$/.test(ports)) c.error(get(rm, 'ports') as YNode, rp + '.ports', `"${ports}" is not a list of ports ("443", "80, 443", "8000-8080") or "any"`);
    const profile = r.field(rm, 'profile', rp, 200);
    if (s.implementation === 'protocol_break') {
      if (profile === undefined) c.error(rm, rp + '.profile', `rule "${id}" needs its transfer profile: in a protocol break, every permitted transfer is one the gateway terminates and starts again`, { key: 'profile' });
      else if (!s.profiles.some((p) => p.id === profile)) c.error(get(rm, 'profile') as YNode, rp + '.profile', `unknown transfer profile "${profile}"${suggest(profile, s.profiles.map((p) => p.id))}`);
    } else if (profile !== undefined && s.implementation) c.error(get(rm, 'profile') as YNode, rp + '.profile', `a transfer profile is a protocol break's; this implementation forwards permitted packets — delete "profile"`);
    if (from === undefined || to === undefined || src === undefined || dst === undefined || proto === undefined) return;
    const rule: SeparationRule = { id, from, to, source: src, destination: dst, protocol: proto, line: rm.line };
    const desc = r.field(rm, 'description', rp, 300);
    if (desc !== undefined) rule.description = desc;
    if (ports !== undefined) rule.ports = ports;
    if (profile !== undefined) rule.profile = profile;
    s.rules.push(rule);
  });
  s.simulation = readSvcSim(r, c, get(m, 'simulation'), path + '.simulation', 'separation', 'Domain separation');
  dev.separation = s;
}

/**
 * What the model parts reference, once every device's interfaces are known:
 * port pairs and management interfaces, a transparent firewall's data ports,
 * the VPN gateway's tunnels, listener and protected networks, and the
 * separation's domain interfaces and profiles.
 */
export function checkDeviceModel(c: Ctx, dev: Device, nodes: DeviceModelNodes, networks: Network[], ifaceOf: (id: string) => Interface | undefined): void {
  const caps = capabilities(dev);
  const p = nodes.path;
  // port pairs
  if (nodes.pairs) {
    if (!caps.needsPortPairs) c.error(get(nodes.map, 'port_pairs') as YNode, p + '.port_pairs', `port pairs are an inline device's (an inline IDS/IPS, an inline or pass-through System); "${dev.id}" passes traffic its own way — delete them`);
    const used = new Map<string, string>();
    for (const x of nodes.pairs) {
      const { a, b, copy } = x.pair;
      for (const [key, port] of [['a', a], ['b', b]] as Array<[string, string]>) {
        const i = ifaceOf(port);
        if (!i) c.error(get(x.node, key) as YNode, `${x.path}.${key}`, `"${dev.id}" has no port "${port}"`);
        else if (i.type !== 'physical') c.error(get(x.node, key) as YNode, `${x.path}.${key}`, `"${port}" is a ${i.type} interface: a pair is of two ports (physical interfaces)`);
        else if (used.has(port)) c.error(get(x.node, key) as YNode, `${x.path}.${key}`, `port "${port}" is already in ${used.get(port)}: a port is in one pair`);
        else used.set(port, `pair ${a}–${b}`);
      }
      if (a === b) c.error(x.node, x.path, `a pair is of two different ports ("${a}" twice)`);
      if (copy.length && caps.inspection) c.error(get(x.node, 'copy') as YNode, x.path + '.copy', `an IDS/IPS inspects what passes; copies for monitors come from a TAP (a pass-through or inline System) — delete "copy"`);
      copy.forEach((cp, k) => {
        const i = ifaceOf(cp);
        if (!i) c.error(get(x.node, 'copy') as YNode, `${x.path}.copy[${k}]`, `"${dev.id}" has no port "${cp}"`);
        else if (used.has(cp)) c.error(get(x.node, 'copy') as YNode, `${x.path}.copy[${k}]`, `port "${cp}" is already in ${used.get(cp)}: a copy port only receives copies`);
        else used.set(cp, `the copies of pair ${a}–${b}`);
      });
    }
  }
  if (caps.needsPortPairs && !dev.portPairs.length) c.error(nodes.map, p + '.port_pairs', `"${dev.id}" passes traffic only between paired ports: write its port_pairs (e.g. [{a: eth0, b: eth1}])`, { key: 'port_pairs' });
  // management interfaces
  if (nodes.managementNode) {
    if (!caps.managementInterfaces) c.error(nodes.managementNode, p + '.management', `management interfaces are kept apart from the data path on a transparent firewall, an IDS/IPS or a Security gateway; "${dev.id}" doesn't separate them — delete "management"`);
    dev.management.forEach((id, k) => {
      if (!ifaceOf(id)) c.error(nodes.managementNode as YNode, `${p}.management[${k}]`, `"${dev.id}" has no interface "${id}"`);
    });
  }
  const data = dev.interfaces.filter((i) => dev.management.indexOf(i.id) < 0);
  // a transparent firewall's (and a filtering bridge's) data ports have no addresses
  if (caps.firewallPolicy && caps.l2Forward) {
    for (const i of data) if (i.addresses.length || i.dhcp) c.error(nodes.map, `${p}.interfaces`, `"${dev.id}" is a transparent firewall: its data port "${i.id}" has no address (put the firewall's own address on a management interface)`, { key: 'interfaces' });
  }
  // the VPN gateway's references
  const v = dev.vpn;
  if (v && nodes.vpnNode) {
    const vp = p + '.services.vpn';
    v.tunnels.forEach((t, k) => {
      const i = ifaceOf(t);
      if (!i) c.error(get(nodes.vpnNode!, 'tunnels') as YNode, `${vp}.tunnels[${k}]`, `"${dev.id}" has no interface "${t}"`);
      else if (i.type !== 'tunnel') c.error(get(nodes.vpnNode!, 'tunnels') as YNode, `${vp}.tunnels[${k}]`, `"${t}" is a ${i.type} interface: a VPN tunnel is a tunnel interface (with its source and destination)`);
      else if (!i.source || !i.destination) c.error(get(nodes.vpnNode!, 'tunnels') as YNode, `${vp}.tunnels[${k}]`, `tunnel "${t}" needs its source (the local endpoint) and its destination (the peer)`);
    });
    if (v.listener !== undefined) {
      const i = ifaceOf(v.listener);
      if (!i) c.error(get(nodes.vpnNode, 'listener') as YNode, vp + '.listener', `"${dev.id}" has no interface "${v.listener}"`);
      else if (!i.addresses.length && !i.dhcp) c.error(get(nodes.vpnNode, 'listener') as YNode, vp + '.listener', `the clients connect to an address: "${v.listener}" has none`);
    }
    v.protected.forEach((x, k) => {
      if (!networks.some((n) => n.id === x) && !parsePrefix(x)) c.error(get(nodes.vpnNode!, 'protected') as YNode, `${vp}.protected[${k}]`, `"${x}" is neither a network of the model nor a prefix${suggest(x, networks.map((n) => n.id))}`);
    });
  }
  // the separation's references
  const s = dev.separation;
  if (s && nodes.separationNode) {
    const sp = p + '.services.separation';
    const seen = new Map<string, string>();
    s.domains.forEach((d, j) => {
      d.interfaces.forEach((id, k) => {
        const at = `${sp}.domains[${j}].interfaces[${k}]`;
        const i = ifaceOf(id);
        if (!i) c.error(nodes.separationNode!, at, `"${dev.id}" has no interface "${id}"`);
        else if (dev.management.indexOf(id) >= 0) c.error(nodes.separationNode!, at, `"${id}" is a management interface: it is never part of a domain (it would be a way around the separation)`);
        else if (seen.has(id)) c.error(nodes.separationNode!, at, `"${id}" is already in domain "${seen.get(id)}": an interface belongs to one domain`);
        else {
          seen.set(id, d.name);
          if (s.implementation === 'filtering_bridge' && (i.addresses.length || i.dhcp)) c.error(nodes.separationNode!, at, `a filtering bridge has no address in its domains: "${id}" has one (put the gateway's own address on a management interface)`);
          if ((s.implementation === 'filtering_router' || s.implementation === 'protocol_break') && !i.addresses.length && !i.dhcp && i.type !== 'virtual') c.error(nodes.separationNode!, at, `a ${s.implementation === 'protocol_break' ? 'protocol break' : 'filtering router'} has an address in each domain: "${id}" has none`);
        }
      });
    });
    // a data port in no domain carries nothing (said, not an error: it may be spare)
    for (const i of data) if (!seen.has(i.id) && (i.addresses.length || dev.management.indexOf(i.id) < 0) && dev.management.indexOf(i.id) < 0 && s.domains.length === 2) c.warn(nodes.map, `${p}.interfaces`, `"${i.id}" is in neither domain and not a management interface: it carries nothing`, { key: 'interfaces' });
    s.profiles.forEach((pr, j) => {
      if (pr.listenInterface === undefined) return;
      const d = s.domains.find((x) => x.interfaces.indexOf(pr.listenInterface as string) >= 0);
      if (!d) c.error(nodes.separationNode!, `${sp}.profiles[${j}].listen.interface`, `profile "${pr.id}" listens on "${pr.listenInterface}", which is in neither domain`);
    });
    s.rules.forEach((ru, j) => {
      const pr = ru.profile !== undefined ? s.profiles.find((x) => x.id === ru.profile) : undefined;
      if (!pr || pr.listenInterface === undefined) return;
      const d = s.domains.find((x) => x.interfaces.indexOf(pr.listenInterface as string) >= 0);
      if (d && d.name !== ru.from) c.error(nodes.separationNode!, `${sp}.rules[${j}].profile`, `rule "${ru.id}" starts in "${ru.from}", but its profile "${pr.id}" listens in "${d.name}"`);
      const tp = TRANSFER_PROFILES.find((x) => x.id === pr.type);
      if (tp && (ru.protocol !== tp.transport || (ru.ports !== undefined && ru.ports !== 'any' && pr.listenPort !== undefined && !portIn(ru.ports, pr.listenPort)))) {
        c.error(nodes.separationNode!, `${sp}.rules[${j}]`, `rule "${ru.id}" must match what its profile "${pr.id}" listens for: ${tp.transport} port ${pr.listenPort !== undefined ? pr.listenPort : tp.port}`);
      }
    });
  }
}

/** Is a port in a list of ports and ranges ("80, 443", "8000-8080")? */
export function portIn(list: string, port: number): boolean {
  if (list.trim() === 'any') return true;
  return list.split(',').some((x) => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(x);
    if (!m) return false;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    return port >= a && port <= b;
  });
}

