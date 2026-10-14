import { IpPrefix, addrKey, hasHostBits, parseAddress, parsePrefix, prefixContains, prefixProblem } from '../model/ip';
import { derive, interfaceAddresses } from '../model/derive';
import { CHECKS, CheckSetting, SEVERITIES, Target, runChecks } from '../analysis/checks';
import {
  CATEGORIES,
  Category,
  DIRECTIONS,
  DUPLEXES,
  Duplex,
  Device,
  Direction,
  DnsName,
  Group,
  Interface,
  InterfaceKind,
  LINE_STYLES,
  LOGICAL_IFACE_TYPES,
  LineStyle,
  Link,
  LinkEnd,
  Model,
  ModelIndex,
  ModelLayout,
  Network,
  PORT_MODES,
  PortMode,
  RelEndpoint,
  RouterIdValue,
  ServiceConfig,
  Relation,
  Route,
  TunnelEnd,
  VLAN_MAX,
  VLAN_MIN,
  VlanRange,
  deviceInterfaces,
  ifaceKey,
  relationDevices,
  routeKey,
} from '../model/types';
import { dnsNameKey, dnsNameProblem } from '../model/dns';
import { BUILTIN_SERVICES, PARAM_SCOPES, PARAM_TYPES, ParamDef, ParamScope, ParamType, ROUTER_ID_KEY, RouterIdUse, ServiceDef, ServiceRegistry, builtinServices, paramProblem, paramsAt, routerIdAddress, usesRouterId } from '../model/services';
import { DEVICE_TYPE_IDS, NO_DEVICE_TYPE, ROUTE_DEVICE_TYPES, deviceRoutingRole, deviceTypeLabel, isDeviceType, isLayer2Switch, routingRole } from '../model/device-types';
import { COLOR_RE, DEFAULT_STYLE, builtinProtocols, lookupProtocol, normalizeProtocol, protocolBase } from '../model/protocols';
import { YMap, YNode, YSeq, YamlError, YamlLimits, parseYaml } from '../yaml/parse';
import { FORMAT_VERSION, SCHEMA } from '../yaml/schema';
import { readDemands } from './demands';
import { readDeviceSimulation, readLinkSimulation } from './simulation';
import { Ctx, DEFAULT_MODEL_LIMITS, ID_RE, IFACE_RE, Issue, ModelLimits, Reader, TooManyErrors, get, isNull, kindOf, scalarText, suggest } from './reader';

export { DEFAULT_MODEL_LIMITS, ID_RE, IFACE_RE, scalarText, suggest };
export type { Issue, ModelLimits };
export { FORMAT_VERSION };

/** protocol ids: lower-case letters, digits and _ . + - */
export const PROTO_RE = /^[a-z0-9][a-z0-9_.+-]{0,39}$/;

export interface LoadResult {
  /**
   * The model built from everything that validated. Present whenever the
   * document is a mapping, even when there are errors, so drafts can be drawn.
   * Null only for YAML syntax errors or a non-mapping document.
   */
  model: Model | null;
  /** the parsed YAML tree (the editable document), null on syntax errors */
  root: YNode | null;
  errors: Issue[];
  warnings: Issue[];
  /**
   * Findings of the consistency checks (analysis/checks.ts), each attached
   * to the place it is about. They describe the network, not the format:
   * they never make a model invalid. Empty while the format has errors.
   */
  findings: Issue[];
}

/** largest accepted coordinate in the layout section */
export const MAX_COORD = 1000000;

// keys per mapping kind: the single definition is yaml/schema.ts
const TOP_KEYS = SCHEMA.top;
const GROUP_KEYS = SCHEMA.group;
const DEVICE_KEYS = SCHEMA.device;
const LINK_KEYS = SCHEMA.link;
const LINK_END_KEYS = SCHEMA.linkEnd;
const ROUTE_KEYS = SCHEMA.route;
const NET_KEYS = SCHEMA.network;
const REL_KEYS = SCHEMA.relation;
const EP_KEYS = SCHEMA.endpoint;
const PROTO_KEYS = SCHEMA.protocol;
const ATTRS_HINT = ' (custom data belongs under "attrs:")';

// ------------------------------------------------------------ main entry

export function loadModel(
  text: string,
  yamlLimits: Partial<YamlLimits> = {},
  modelLimits: Partial<ModelLimits> = {},
): LoadResult {
  let root: YNode | null;
  try {
    root = parseYaml(text, yamlLimits);
  } catch (e) {
    if (e instanceof YamlError) {
      return { model: null, root: null, errors: [{ severity: 'error', line: e.line, path: '', message: 'YAML: ' + e.message }], warnings: [], findings: [] };
    }
    throw e;
  }
  return validate(root, modelLimits);
}

export function validate(root: YNode | null, modelLimits: Partial<ModelLimits> = {}): LoadResult {
  const c = new Ctx({ ...DEFAULT_MODEL_LIMITS, ...modelLimits });
  let model: Model | null = null;
  try {
    model = build(root, c);
  } catch (e) {
    if (!(e instanceof TooManyErrors)) throw e;
    c.errors.push({ severity: 'error', line: 0, path: '', message: `stopped after ${c.errors.length} errors` });
    model = null;
  }
  return { model, root, errors: c.errors, warnings: c.warnings, findings: c.findings };
}

function build(root: YNode | null, c: Ctx): Model | null {
  const r = new Reader(c);
  const L = c.limits;
  if (!root) {
    const dummy: YNode = { kind: 'scalar', value: null, raw: '', quoted: false, line: 1, col: 1 };
    c.error(dummy, '', `the document is empty — expected a mapping starting with "netatlas: ${FORMAT_VERSION}"`);
    return null;
  }
  const top = r.map(root, '(document)');
  if (!top) return null;
  r.keys(top, TOP_KEYS, '', '');

  const verNode = get(top, 'netatlas');
  if (isNull(verNode)) {
    c.error(top, 'netatlas', `missing format version — add "netatlas: ${FORMAT_VERSION}" as the first line`, { key: 'netatlas', line: 1 });
  } else if (!(verNode!.kind === 'scalar' && verNode!.value === FORMAT_VERSION)) {
    c.error(verNode!, 'netatlas', `unsupported format version — the only supported model format is "netatlas: ${FORMAT_VERSION}"`);
  }
  const title = r.field(top, 'title', '', L.maxLabel) || 'Untitled network';
  const description = r.field(top, 'description', '', L.maxDescription);

  // Every top-level entity shares one id namespace, so "over:" and selections are unambiguous.
  const ids = new Map<string, { kind: string; line: number }>();
  const claim = (id: string, kind: string, m: YMap, path: string): boolean => {
    const prev = ids.get(id);
    if (prev) {
      c.error(
        get(m, 'id') as YNode,
        path + '.id',
        `duplicate id "${id}" (already used by a ${prev.kind}${prev.line ? ' on line ' + prev.line : ''}; ids must be unique across all sections)`,
      );
      return false;
    }
    ids.set(id, { kind, line: m.line });
    return true;
  };

  const capped = (items: YNode[], max: number, path: string, what: string): YNode[] => {
    if (items.length > max) {
      c.error(items[max], path, `too many ${what}: ${items.length} (limit ${max})`);
      return items.slice(0, max);
    }
    return items;
  };

  // ---------------------------------------------------------- protocols
  const protocols = builtinProtocols();
  const services = builtinServices();
  const protoItems = capped(r.list(get(top, 'protocols'), 'protocols'), L.maxProtocols, 'protocols', 'protocol definitions');
  const seenProto = new Set<string>();
  protoItems.forEach((n, i) => {
    const path = `protocols[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, PROTO_KEYS, path);
    const rawId = r.reqStr(m, 'id', path, 40);
    if (rawId === undefined) return;
    const id = normalizeProtocol(rawId);
    const idNode = get(m, 'id') as YNode;
    if (!PROTO_RE.test(id)) {
      c.error(idNode, path + '.id', `invalid protocol id "${rawId}": use lowercase letters, digits and _ . + -`);
      return;
    }
    if (seenProto.has(id)) {
      c.error(idNode, path + '.id', `protocol "${id}" is defined twice`);
      return;
    }
    seenProto.add(id);
    const base = protocols.get(id);
    const catS = r.field(m, 'category', path, 40);
    let category: Category = base ? base.category : 'other';
    if (catS !== undefined) {
      if (CATEGORIES.indexOf(catS as Category) < 0) {
        c.error(get(m, 'category') as YNode, path + '.category', `unknown category "${catS}"${suggest(catS, CATEGORIES)}`);
      } else category = catS as Category;
    } else if (!base) {
      c.warn(m, path, `protocol "${id}" has no category; using "other" (choose one of ${CATEGORIES.join(', ')})`, { key: 'category' });
    }
    const color = r.field(m, 'color', path, 20);
    if (color !== undefined && !COLOR_RE.test(color)) {
      c.error(get(m, 'color') as YNode, path + '.color', `invalid color "${color}": use #rgb or #rrggbb`);
    }
    const styleS = r.field(m, 'style', path, 20);
    let style: LineStyle = catS !== undefined || !base ? DEFAULT_STYLE[category] : base.style;
    if (styleS !== undefined) {
      if (LINE_STYLES.indexOf(styleS as LineStyle) < 0) {
        c.error(get(m, 'style') as YNode, path + '.style', `unknown style "${styleS}"${suggest(styleS, LINE_STYLES)}`);
      } else style = styleS as LineStyle;
    }
    const service = readServiceDefinition(r, c, m, path, id, rawId, r.field(m, 'label', path, 60) || (base ? base.label : rawId));
    if (service) {
      if (BUILTIN_SERVICE_IDS.indexOf(id) >= 0) c.error(get(m, get(m, 'params') ? 'params' : 'router_id') as YNode, path + '.params', `"${id}" is a built-in routing service: its parameters are fixed (define a protocol of your own to declare others)`);
      else services.set(id, service);
    }
    protocols.set(id, {
      id,
      label: r.field(m, 'label', path, 60) || (base ? base.label : rawId),
      category,
      color: color && COLOR_RE.test(color) ? color : base ? base.color : lookupProtocol(new Map(), id).color,
      style,
      description: r.field(m, 'description', path, L.maxDescription),
      custom: true,
    });
  });

  // ------------------------------------------------------------- groups
  const groups: Group[] = [];
  const groupNodes = new Map<string, YMap>();
  capped(r.list(get(top, 'groups'), 'groups'), L.maxGroups, 'groups', 'groups').forEach((n, i) => {
    const path = `groups[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, GROUP_KEYS, path, ATTRS_HINT);
    const id = r.id(m, path);
    if (!id || !claim(id, 'group', m, path)) return;
    const gpath = `groups.${id}`;
    groupNodes.set(id, m);
    const kind = (r.field(m, 'kind', gpath, 40) || '').toLowerCase();
    groups.push({
      id,
      label: r.field(m, 'label', gpath, L.maxLabel) || id,
      kind,
      parent: r.field(m, 'parent', gpath, 200),
      description: r.field(m, 'description', gpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), gpath + '.attrs'),
      line: m.line,
    });
  });
  const groupMap = new Map(groups.map((g) => [g.id, g] as [string, Group]));
  for (const g of groups) {
    if (g.parent === undefined) continue;
    if (!groupMap.has(g.parent)) {
      const pn = get(groupNodes.get(g.id) as YMap, 'parent') as YNode;
      c.error(pn, `groups.${g.id}.parent`, `unknown parent group "${g.parent}"${suggest(g.parent, groupMap.keys())}`);
      g.parent = undefined;
    }
  }
  for (const g of groups) {
    const seen = new Set<string>([g.id]);
    let p = g.parent;
    let depth = 1;
    while (p !== undefined) {
      const pn = (get(groupNodes.get(g.id) as YMap, 'parent') as YNode) || (groupNodes.get(g.id) as YMap);
      if (seen.has(p)) {
        c.error(pn, `groups.${g.id}.parent`, `group parent chain forms a cycle (${Array.from(seen).join(' → ')} → ${p})`);
        g.parent = undefined;
        break;
      }
      seen.add(p);
      if (++depth > L.maxGroupDepth) {
        c.error(pn, `groups.${g.id}.parent`, `groups are nested deeper than ${L.maxGroupDepth} levels`);
        g.parent = undefined;
        break;
      }
      p = (groupMap.get(p) as Group).parent;
    }
  }

  // ------------------------------------------------------------ devices
  const devices: Device[] = [];
  const interfaces = new Map<string, Interface>();
  /** "device:iface" -> the YAML node of each address in Interface.addresses (same order) */
  const ifaceAddrNodes = new Map<string, YNode[]>();
  /** "device:iface" -> where the interface is declared, e.g. "devices.r1.logical_interfaces[1]" */
  const ifacePaths = new Map<string, string>();
  /** canonical address -> first "device:iface" using it */
  const addrOwner = new Map<string, { where: string; node: YNode }>();
  /** "device:iface" -> the node of a virtual interface's "vlan" */
  const vlanNodes = new Map<string, YNode>();
  /** DNS name key -> the device that configures it first */
  const dnsOwner = new Map<string, string>();
  /** tunnel destinations: checked once every device is read */
  const destinations: Array<{ iface: Interface; node: YNode; path: string }> = [];
  /** where things are declared, for attaching check findings: device id / "device:iface" / "device:index" -> entry and path */
  const devNodes = new Map<string, { node: YMap; path: string }>();
  const ifaceNodes = new Map<string, YMap>();
  const routeNodes = new Map<string, { node: YMap; path: string }>();
  capped(r.list(get(top, 'devices'), 'devices'), L.maxDevices, 'devices', 'devices').forEach((n, i) => {
    const path = `devices[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, DEVICE_KEYS, path, ATTRS_HINT, { asn: 'the AS number belongs to BGP: enable it with protocols: {bgp: {asn: …}}' });
    const id = r.id(m, path);
    if (!id) return;
    const dpath = `devices.${id}`;
    if (!claim(id, 'device', m, path)) return;
    const group = r.field(m, 'group', dpath, 200);
    if (group !== undefined && !groupMap.has(group)) {
      c.error(get(m, 'group') as YNode, dpath + '.group', `unknown group "${group}"${suggest(group, groupMap.keys())}`);
    }
    let tier: number | undefined;
    const tierN = get(m, 'tier');
    if (!isNull(tierN)) {
      const t = tierN as YNode;
      if (t.kind !== 'scalar' || typeof t.value !== 'number' || !Number.isInteger(t.value) || t.value < 0 || t.value > 9) {
        c.error(t, dpath + '.tier', 'tier must be an integer from 0 (top) to 9 (bottom)');
      } else tier = t.value;
    }
    const dtype = deviceType(r, m, dpath, c);
    // layer3: only a switch has it (every other type's layer is its type)
    const l3Node = get(m, 'layer3');
    const layer3 = r.bool(l3Node, dpath + '.layer3');
    if (layer3 !== undefined && dtype !== 'switch') {
      c.error(l3Node as YNode, dpath + '.layer3', `layer3 is for switches (a switch routes with layer3: true); "${id}" is ${dtype === NO_DEVICE_TYPE ? 'a device without a type' : `a ${deviceTypeLabel(dtype) || dtype}`}, whose layer follows from its type`);
    }
    const dev: Device = {
      id,
      label: r.field(m, 'label', dpath, L.maxLabel) || id,
      type: dtype,
      layer3: dtype === 'switch' && layer3 === true ? true : undefined,
      simulation: readDeviceSimulation(r, c, get(m, 'simulation'), dpath + '.simulation', id, dtype, dtype === 'switch' && layer3 === true),
      group: group !== undefined && groupMap.has(group) ? group : undefined,
      tier,
      description: r.field(m, 'description', dpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), dpath + '.attrs'),
      interfaces: [],
      logical: [],
      dnsNames: [],
      routes: [],
      services: [],
      line: m.line,
    };
    // the routing services it enables (Layer 3+ devices only); the router IDs are resolved once its loopbacks are read
    const svcRids: Array<{ svc: ServiceConfig; text: string; node: YNode; path: string }> = [];
    const protoNode = get(m, 'protocols');
    if (!isNull(protoNode)) {
      if (isLayer2Switch(dev)) {
        c.error(protoNode as YNode, dpath + '.protocols', `"${id}" is a Layer 2 switch: it runs no routing protocols (set layer3: true to make it a Layer 3 switch)`);
      } else if (deviceRoutingRole(dev) !== 'router') {
        const what = dev.type === NO_DEVICE_TYPE ? 'a device without a type' : `a ${deviceTypeLabel(dev.type) || dev.type} (${dev.type})`;
        c.error(protoNode as YNode, dpath + '.protocols', `"${id}" is ${what}: only Layer 3+ devices (${ROUTER_TYPES.join(', ')}; a switch with layer3: true) run routing protocols`);
      } else dev.services = readServices(r, c, protoNode as YNode, dpath + '.protocols', services, 'device', id, svcRids);
    }
    devNodes.set(id, { node: m, path: dpath });
    let count = 0;
    /** address -> id of the interface of this device that has it (first one) */
    const ownAddrs = new Map<string, string>();
    /** tunnel sources of this device that name an interface: checked once all its interfaces are read */
    const sources: Array<{ iface: Interface; node: YNode; path: string }> = [];
    /** physical interface id -> the aggregate that lists it as a member (first one) */
    const memberOf = new Map<string, string>();
    /**
     * One interface of this device. `interfaces` holds the physical ones,
     * `logical_interfaces` the loopback, virtual and tunnel interfaces. Both
     * lists share the device's id namespace, so "device:interface" names
     * exactly one interface.
     */
    const readIface = (inode: YNode, ipath: string, where: 'interface' | 'logical'): Interface | null => {
      let im: YMap | null;
      if (inode.kind === 'scalar' && where === 'interface') {
        // shorthand: "- eth0"
        im = { kind: 'map', entries: new Map([['id', { key: 'id', keyLine: inode.line, value: inode }]]), line: inode.line, col: inode.col };
      } else im = r.map(inode, ipath);
      if (!im) return null;
      r.keys(im, SCHEMA[where], ipath, ATTRS_HINT);
      const iid = r.id(im, ipath, IFACE_RE, 'interface id');
      if (!iid) return null;
      const key = ifaceKey(id, iid);
      const prev = interfaces.get(key);
      if (prev) {
        c.error(
          get(im, 'id') as YNode,
          ipath + '.id',
          `duplicate interface "${iid}" on device "${id}" (already used by ${describeIface(prev)}; physical and logical interfaces share one set of ids per device)`,
        );
        return null;
      }
      if (interfaces.size >= L.maxInterfaces) {
        c.error(im, ipath, `too many interfaces in total (limit ${L.maxInterfaces})`);
        return null;
      }
      if (++count > L.maxInterfacesPerDevice) {
        c.error(im, ipath, `too many interfaces on one device (limit ${L.maxInterfacesPerDevice}, physical and logical together)`);
        return null;
      }
      let type: InterfaceKind = 'physical';
      if (where === 'logical') {
        // a draft without a (valid) type is kept as a virtual interface, the kind with the fewest rules
        type = 'virtual';
        const t = r.reqStr(im, 'type', ipath, 40);
        if (t !== undefined) {
          if (LOGICAL_IFACE_TYPES.indexOf(t as InterfaceKind) >= 0) type = t as InterfaceKind;
          else {
            c.error(
              get(im, 'type') as YNode,
              ipath + '.type',
              `"${t}" is not a logical interface type: use "loopback", "virtual" or "tunnel"` +
                (t === 'physical' ? ' (a physical interface belongs in the "interfaces:" list of the device)' : ' (an SVI, a VLAN interface, a bond or a subinterface is "virtual")'),
            );
          }
        }
      }
      const isLoop = type === 'loopback';
      const kind = isLoop ? 'loopback' : 'interface';
      // DHCP is a flag, never an address: omitted means false
      const dhcp = r.bool(get(im, 'dhcp'), ipath + '.dhcp') === true;
      const ipNode = get(im, 'ip');
      const addrNodes = r.list(ipNode, ipath + '.ip', true);
      const addrs: string[] = [];
      const addrsAt: YNode[] = [];
      const seenHere = new Set<string>();
      addrNodes.forEach((an, j) => {
        const a = r.str(an, `${ipath}.ip[${j}]`, 64);
        if (a === undefined) {
          if (isLoop) c.error(an, `${ipath}.ip[${j}]`, 'empty address');
          return;
        }
        addrs.push(a);
        addrsAt.push(an);
        const p = parsePrefix(a, !isLoop ? false : true);
        if (!p) {
          const why =
            a.toLowerCase() === 'dhcp'
              ? isLoop
                ? '"dhcp" is not an address, and a loopback cannot obtain its address by DHCP: write its address with prefix length'
                : '"dhcp" is not an address: to say that the interface obtains its address by DHCP, delete it here and set "dhcp: true"'
              : prefixProblem(a) || `"${a}" is not a valid address`;
          if (isLoop) c.error(an, `${ipath}.ip[${j}]`, `invalid loopback address: ${why}`);
          else c.warn(an, `${ipath}.ip[${j}]`, `${why}; it is shown as written`);
          return;
        }
        const k2 = addrKey(p);
        if (seenHere.has(k2)) {
          c.error(an, `${ipath}.ip[${j}]`, `address ${a} is listed twice on ${kind} "${iid}"`);
          return;
        }
        seenHere.add(k2);
        if (!ownAddrs.has(k2)) ownAddrs.set(k2, iid);
        const owner = addrOwner.get(k2);
        if (owner) c.warn(an, `${ipath}.ip[${j}]`, `address ${a.split('/')[0]} is also assigned to ${owner.where}`);
        else addrOwner.set(k2, { where: key, node: an });
      });
      if (dhcp && isLoop) {
        // an address of the device itself is always configured; the flag is reported, not dropped
        c.error(
          get(im, 'dhcp') as YNode,
          ipath + '.dhcp',
          `loopback "${iid}" cannot obtain its address by DHCP: a loopback's addresses are always configured — delete "dhcp: true" and write its address under "ip:"`,
        );
      } else if (dhcp && addrNodes.length) {
        // both are kept as written and reported: neither the flag nor the addresses are discarded
        c.error(
          ipNode as YNode,
          ipath + '.ip',
          `${kind} "${iid}" has "dhcp: true" and manually configured addresses; an interface either obtains its address by DHCP or has addresses configured — delete "ip:" or set "dhcp: false"`,
        );
      }
      if (isLoop && !addrs.length) {
        c.error(ipNode && !isNull(ipNode) ? ipNode : im, ipath + '.ip', `loopback "${iid}" needs at least one IPv4 or IPv6 address with prefix length (e.g. 10.255.0.1/32 or 2001:db8::1/128)`, ipNode && !isNull(ipNode) ? {} : { key: 'ip' });
      }
      const iface: Interface = {
        id: iid,
        device: id,
        label: r.field(im, 'label', ipath, L.maxLabel),
        type,
        dhcp,
        addresses: addrs,
        vrf: r.field(im, 'vrf', ipath, 100),
        mac: r.field(im, 'mac', ipath, 40),
        mtu: r.int(get(im, 'mtu'), ipath + '.mtu', 68, 65535, 'MTU'),
        members: [],
        services: [],
        description: r.field(im, 'description', ipath, L.maxDescription),
        attrs: r.attrs(get(im, 'attrs'), ipath + '.attrs'),
        line: im.line,
      };
      // settings per interface of services the device enables (a VRRP group …)
      const ip = get(im, 'protocols');
      if (!isNull(ip)) iface.services = readServices(r, c, ip as YNode, ipath + '.protocols', services, 'interface', id, [], dev);
      if (where === 'logical') {
        // Each association belongs to one type; on another type it is an error, not silently ignored.
        const only = (k: string, t: InterfaceKind, what: string): boolean => {
          const n = get(im as YMap, k);
          if (isNull(n)) return false;
          if (type === t) return true;
          c.error(n as YNode, `${ipath}.${k}`, `"${k}" applies to a ${t} interface only (${what}); "${iid}" is a ${type} interface — delete this key or change the type`);
          return false;
        };
        if (only('members', 'virtual', 'the member ports of a bond or aggregate')) {
          // member ports of an aggregate: physical interfaces of this device, each once
          r.list(get(im, 'members'), ipath + '.members', true).forEach((mn, j) => {
            const mp = `${ipath}.members[${j}]`;
            const mid = r.str(mn, mp, 200);
            if (mid === undefined) return;
            const target = interfaces.get(ifaceKey(id, mid));
            if (!target) {
              const ports = dev.interfaces.map((x) => x.id);
              c.error(mn, mp, `device "${id}" has no physical interface "${mid}"` + (ports.length ? suggest(mid, ports) : ' (the device declares no physical interfaces)'));
            } else if (target.type !== 'physical') {
              c.error(mn, mp, `"${mid}" is ${describeIface(target)}: the members of an aggregate are physical interfaces of the same device`);
            } else if (iface.members.indexOf(mid) >= 0) {
              c.error(mn, mp, `member port "${mid}" is listed twice`);
            } else {
              iface.members.push(mid);
              const other = memberOf.get(mid);
              if (other !== undefined) c.warn(mn, mp, `port "${mid}" is also a member of "${other}"; a port normally belongs to one aggregate`);
              else memberOf.set(mid, iid);
            }
          });
        }
        if (only('min_links', 'virtual', 'how many member links an aggregate needs')) {
          const ml = r.int(get(im, 'min_links'), ipath + '.min_links', 1, 64, 'minimum number of links');
          if (ml !== undefined && !iface.members.length) c.error(get(im, 'min_links') as YNode, ipath + '.min_links', `"min_links" applies to an aggregate: "${iid}" has no member ports`);
          else if (ml !== undefined) iface.minLinks = ml;
        }
        if (only('vlan', 'virtual', 'the VLAN a VLAN interface belongs to')) {
          iface.vlan = r.vlanId(get(im, 'vlan'), ipath + '.vlan');
          vlanNodes.set(key, get(im, 'vlan') as YNode);
        }
        for (const k of ['source', 'destination'] as Array<'source' | 'destination'>) {
          if (!only(k, 'tunnel', k === 'source' ? 'the local interface or address a tunnel is sourced from' : 'the remote end of a tunnel')) continue;
          const text = r.field(im, k, ipath, 200);
          if (text === undefined) continue;
          const end: TunnelEnd = { text };
          const addr = parsePrefix(text, false);
          if (addr) end.address = text;
          iface[k] = end;
          const node = get(im, k) as YNode;
          if (k === 'source') sources.push({ iface, node, path: `${ipath}.source` });
          else destinations.push({ iface, node, path: `${ipath}.destination` });
        }
      }
      interfaces.set(key, iface);
      ifaceAddrNodes.set(key, addrsAt);
      ifacePaths.set(key, ipath);
      ifaceNodes.set(key, im);
      return iface;
    };
    r.list(get(m, 'interfaces'), dpath + '.interfaces').forEach((inode, k) => {
      const i = readIface(inode, `${dpath}.interfaces[${k}]`, 'interface');
      if (i) dev.interfaces.push(i);
    });
    r.list(get(m, 'logical_interfaces'), dpath + '.logical_interfaces').forEach((inode, k) => {
      const i = readIface(inode, `${dpath}.logical_interfaces[${k}]`, 'logical');
      if (i) dev.logical.push(i);
    });
    dev.dnsNames = readDnsNames(r, c, m, dpath, dev, dnsOwner);
    dev.routes = readRoutes(r, c, m, dpath, dev, routeNodes);
    // the router IDs: the device's (shared by its protocols) and a protocol's own; applicable only with a protocol that uses one
    const ridNode = get(m, 'router_id');
    const ridText = r.field(m, 'router_id', dpath, 64);
    if (ridText !== undefined) {
      const v = resolveRouterId(c, dev, ridText, ridNode as YNode, dpath + '.router_id');
      if (v) dev.routerId = v;
      const users = dev.services.filter((s) => {
        const def = services.get(s.id);
        return !!def && usesRouterId(def);
      });
      if (!users.length) {
        const which = Array.from(services.values()).filter(usesRouterId).map((s) => s.label);
        c.warn(ridNode as YNode, dpath + '.router_id', `router_id is not applicable: none of the protocols "${id}" enables uses a router ID (${which.join(', ')} do); enable one or remove it`);
      }
    }
    for (const s of svcRids) {
      const v = resolveRouterId(c, dev, s.text, s.node, s.path);
      if (v) s.svc.routerId = v;
    }
    if (isLayer2Switch(dev)) layer2SwitchRules(c, m, dpath, dev);
    for (const s of dev.services) {
      const def = services.get(s.id);
      if (!def || def.routerId !== 'required' || s.routerId || dev.routerId || svcRids.some((x) => x.svc === s) || ridText !== undefined) continue;
      const sn = protoNode && !isNull(protoNode) && (protoNode as YNode).kind === 'map' ? get(protoNode as YMap, s.id) : undefined;
      c.error(sn && !isNull(sn) ? (sn as YNode) : (protoNode as YNode), `${dpath}.protocols.${s.id}`, `${def.label} needs a router ID: set the device's router_id (a loopback or an IPv4 address), or ${def.label}'s own router_id`, sn && !isNull(sn) ? { key: ROUTER_ID_KEY } : {});
    }
    // tunnel sources: an address (its interface is then derived), or any other interface of this device
    for (const s of sources) {
      const end = s.iface.source as TunnelEnd;
      end.device = id;
      if (end.address !== undefined) {
        const own = ownAddrs.get(addrKey(parsePrefix(end.address, false) as IpPrefix));
        if (own !== undefined && own !== s.iface.id) end.iface = own;
        else c.warn(s.node, s.path, `source address ${end.address} is not an address of an interface of "${id}"; the tunnel's source interface can't be derived`);
        continue;
      }
      const target = interfaces.get(ifaceKey(id, end.text));
      if (!target) {
        const names = deviceInterfaces(dev).map((x) => x.id).filter((x) => x !== s.iface.id);
        c.error(s.node, s.path, `tunnel source "${end.text}" is neither an IP address nor an interface of "${id}"` + (names.length ? suggest(end.text, names) : ''));
        s.iface.source = undefined;
      } else if (target.id === s.iface.id) {
        c.error(s.node, s.path, 'a tunnel cannot be sourced from itself');
        s.iface.source = undefined;
      } else end.iface = target.id;
    }
    devices.push(dev);
  });
  const deviceMap = new Map(devices.map((d) => [d.id, d] as [string, Device]));

  // tunnel destinations: an address (the device that has it is then derived), or a device / interface of the model
  for (const t of destinations) {
    const end = t.iface.destination as TunnelEnd;
    if (end.address !== undefined) {
      const owner = addrOwner.get(addrKey(parsePrefix(end.address, false) as IpPrefix));
      if (owner) {
        const colon = owner.where.indexOf(':');
        end.device = owner.where.slice(0, colon);
        end.iface = owner.where.slice(colon + 1);
      }
      continue;
    }
    const colon = end.text.indexOf(':');
    const dname = colon < 0 ? end.text : end.text.slice(0, colon);
    const iname = colon < 0 ? undefined : end.text.slice(colon + 1);
    const target = deviceMap.get(dname);
    if (!target) {
      c.error(t.node, t.path, `tunnel destination "${end.text}" is neither an IP address nor a device or "device:interface" of this model` + suggest(dname, deviceMap.keys()));
      t.iface.destination = undefined;
    } else if (iname !== undefined && !interfaces.has(ifaceKey(dname, iname))) {
      const names = deviceInterfaces(target).map((x) => x.id);
      c.error(t.node, t.path, `device "${dname}" has no interface "${iname}"` + (names.length ? suggest(iname, names) : ' (the device declares no interfaces)'));
      t.iface.destination = undefined;
    } else if (dname === t.iface.device && iname === t.iface.id) {
      c.error(t.node, t.path, 'a tunnel cannot have itself as its destination');
      t.iface.destination = undefined;
    } else {
      end.device = dname;
      end.iface = iname;
    }
  }

  /**
   * Parse "dev" / "dev:iface" / a mapping. A relation endpoint is nothing
   * more; a link end may also have the layer-2 tagging of its port.
   */
  const endpoint = (n: YNode, path: string, extended: boolean): (RelEndpoint & { tag: L2Tag }) | null => {
    let device: string | undefined;
    let iface: string | undefined;
    let tag: L2Tag = { tagged: [] };
    if (n.kind === 'scalar') {
      const s = r.str(n, path, 200);
      if (s === undefined) {
        c.error(n, path, 'endpoint is empty — use "device" or "device:interface"');
        return null;
      }
      const colon = s.indexOf(':');
      device = colon < 0 ? s : s.slice(0, colon);
      iface = colon < 0 ? undefined : s.slice(colon + 1);
    } else if (n.kind === 'map') {
      r.keys(n, extended ? EP_KEYS : LINK_END_KEYS, path, '');
      device = r.reqStr(n, 'device', path, 200);
      iface = r.field(n, 'interface', path, 200);
      // the layer-2 tagging of the port at this end: a fact of the link end, kept exactly as configured
      if (!extended) tag = readTagging(r, c, n, path);
      if (device === undefined) return null;
    } else {
      c.error(n, path, `expected "device", "device:interface" or a mapping with "device:" but found ${kindOf(n)}`);
      return null;
    }
    const dev = deviceMap.get(device);
    const devNode = n.kind === 'map' ? (get(n, 'device') as YNode) : n;
    if (!dev) {
      c.error(devNode, path, `unknown device "${device}"${suggest(device, deviceMap.keys())}`);
      return null;
    }
    if (iface !== undefined && !interfaces.has(ifaceKey(device, iface))) {
      const names = deviceInterfaces(dev).map((x) => x.id);
      c.error(
        n.kind === 'map' ? (get(n, 'interface') as YNode) : n,
        path,
        `device "${device}" has no interface "${iface}"` + (names.length ? suggest(iface, names) : ' (the device declares no interfaces)'),
      );
      return null;
    }
    return { device, iface, tag };
  };

  // -------------------------------------------------------------- links
  const links: Link[] = [];
  const linkNodes = new Map<string, YMap>();
  /** "<link id>.a" / ".b" -> the node of that end */
  const endNodes = new Map<string, YNode>();
  const ifaceLink = new Map<string, string>();
  capped(r.list(get(top, 'links'), 'links'), L.maxLinks, 'links', 'links').forEach((n, i) => {
    const path = `links[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, LINK_KEYS, path, ATTRS_HINT);
    const id = r.id(m, path);
    if (!id) return;
    const lpath = `links.${id}`;
    if (!claim(id, 'link', m, path)) return;
    const ends: Array<LinkEnd | null> = ['a', 'b'].map((side) => {
      const en = get(m, side);
      if (isNull(en)) {
        c.error(m, lpath, `missing required key "${side}" (a physical link joins two endpoints "a" and "b")`, { key: side });
        return null;
      }
      const ep = endpoint(en as YNode, `${lpath}.${side}`, false);
      if (!ep) return null;
      if (ep.iface !== undefined) {
        const key = ifaceKey(ep.device, ep.iface);
        const inf = interfaces.get(key) as Interface;
        if (inf.type !== 'physical') {
          c.error(
            en as YNode,
            `${lpath}.${side}`,
            `"${key}" is ${describeIface(inf)}, not a physical interface — a physical link must end on a physical interface. ` +
              (inf.members.length ? `Cable its member ports (${inf.members.join(', ')}) instead; ` : inf.source && inf.source.iface ? `Its source is "${inf.source.iface}"; ` : '') +
              'Tunnels and sessions between logical interfaces are relations.',
          );
          return null;
        }
        const used = ifaceLink.get(key);
        if (used !== undefined) {
          c.error(en as YNode, `${lpath}.${side}`, `interface "${key}" is already cabled by link "${used}" (one cable per port)`);
          return null;
        }
        ifaceLink.set(key, id);
      }
      const end: LinkEnd = { device: ep.device, iface: ep.iface, tagged: ep.tag.tagged };
      if (ep.tag.speed !== undefined) end.speed = ep.tag.speed;
      if (ep.tag.duplex !== undefined) end.duplex = ep.tag.duplex;
      if (ep.tag.mode !== undefined) end.mode = ep.tag.mode;
      if (ep.tag.untagged !== undefined) end.untagged = ep.tag.untagged;
      endNodes.set(`${id}.${side}`, en as YNode);
      return end;
    });
    const [a, b] = ends;
    if (!a || !b) return;
    if (a.device === b.device && a.iface === b.iface) {
      c.error(m, lpath, 'a link cannot connect an endpoint to itself');
      return;
    }
    linkNodes.set(id, m);
    links.push({
      id,
      a,
      b,
      medium: (r.field(m, 'medium', lpath, 40) || 'unspecified').toLowerCase(),
      speed: r.field(m, 'speed', lpath, 40),
      label: r.field(m, 'label', lpath, L.maxLabel),
      cable: r.field(m, 'cable', lpath, L.maxLabel),
      direction: directionField(r, c, m, lpath, 'from end a to end b'),
      simulation: readLinkSimulation(r, c, get(m, 'simulation'), lpath + '.simulation'),
      description: r.field(m, 'description', lpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), lpath + '.attrs'),
      line: m.line,
    });
  });

  // ----------------------------------------------------------- networks
  const networks: Network[] = [];
  const netNodes = new Map<string, YMap>();
  const seenPrefixes: Array<{ id: string; p: IpPrefix }> = [];
  capped(r.list(get(top, 'networks'), 'networks'), L.maxNetworks, 'networks', 'networks').forEach((n, i) => {
    const path = `networks[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, NET_KEYS, path, ATTRS_HINT);
    const id = r.id(m, path);
    if (!id) return;
    const npath = `networks.${id}`;
    if (!claim(id, 'network', m, path)) return;
    netNodes.set(id, m);
    // the one prefix is the authority for membership, so it must be a real prefix: exactly one, never a list
    const cidrNode = get(m, 'cidr');
    let cidr: string | undefined;
    if (isNull(cidrNode)) {
      c.error(m, npath + '.cidr', `network "${id}" needs its IP network: add "cidr:" with one prefix (e.g. 192.0.2.0/24 or 2001:db8::/64)`, { key: 'cidr' });
    } else if ((cidrNode as YNode).kind === 'seq') {
      const items = (cidrNode as YSeq).items;
      c.error(
        cidrNode as YNode,
        npath + '.cidr',
        items.length
          ? `"cidr" lists ${items.length} prefixes, but a network has exactly one: keep one here (written without brackets, e.g. cidr: 192.0.2.0/24) and make a separate network for each other prefix`
          : 'a network needs exactly one prefix, e.g. cidr: 192.0.2.0/24 (not an empty list)',
      );
    } else {
      const text = r.str(cidrNode, npath + '.cidr', 64);
      const p = text !== undefined ? parsePrefix(text) : null;
      if (text === undefined) {
        // (r.str reported a non-text value)
      } else if (!p) c.error(cidrNode as YNode, npath + '.cidr', `invalid network prefix: ${prefixProblem(text)}`);
      else {
        cidr = text;
        if (hasHostBits(p)) c.warn(cidrNode as YNode, npath + '.cidr', `${text} has bits set beyond /${p.prefix}; the network is the whole /${p.prefix} that contains it`);
        // the same prefix twice: two objects for one network, so membership would be listed twice
        const same = seenPrefixes.find((x) => prefixContains(x.p, p) && prefixContains(p, x.p));
        if (same) c.warn(cidrNode as YNode, npath + '.cidr', `network "${id}" has the same prefix as network "${same.id}"; both list the same members`);
        else seenPrefixes.push({ id, p });
      }
    }
    networks.push({
      id,
      label: r.field(m, 'label', npath, L.maxLabel) || id,
      cidr,
      vlan: r.vlanId(get(m, 'vlan'), npath + '.vlan'),
      description: r.field(m, 'description', npath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), npath + '.attrs'),
      line: m.line,
    });
  });
  const networkMap = new Map(networks.map((x) => [x.id, x] as [string, Network]));

  // ---------------------------------------------------------- relations
  const relations: Relation[] = [];
  const overNodes = new Map<string, YNode>();
  const relNodes = new Map<string, YMap>();
  capped(r.list(get(top, 'relations'), 'relations'), L.maxRelations, 'relations', 'relations').forEach((n, i) => {
    const path = `relations[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, REL_KEYS, path, ATTRS_HINT);
    const id = r.id(m, path);
    if (!id) return;
    const rpath = `relations.${id}`;
    if (!claim(id, 'relation', m, path)) return;
    const protoRaw = r.reqStr(m, 'protocol', rpath, 40);
    if (protoRaw === undefined) {
      // report missing endpoints as well, so a new relation shows everything still to fill in
      const eps = get(m, 'endpoints');
      if (isNull(eps) || (eps!.kind === 'seq' && eps!.items.length < 2)) {
        c.error(eps && !isNull(eps) ? eps : m, rpath + '.endpoints', 'a relation needs at least 2 endpoints', eps && !isNull(eps) ? {} : { key: 'endpoints' });
      }
      return;
    }
    const proto = normalizeProtocol(protoRaw);
    if (!PROTO_RE.test(proto)) {
      c.error(get(m, 'protocol') as YNode, rpath + '.protocol', `invalid protocol name "${protoRaw}": use letters, digits and _ . + -`);
      return;
    }
    const catS = r.field(m, 'category', rpath, 40);
    let category: Category | undefined;
    if (catS !== undefined) {
      if (CATEGORIES.indexOf(catS as Category) < 0) {
        c.error(get(m, 'category') as YNode, rpath + '.category', `unknown category "${catS}"${suggest(catS, CATEGORIES)}`);
      } else category = catS as Category;
    }
    const def = lookupProtocol(protocols, proto, category);
    if (!protocols.has(proto) && catS === undefined && def.category === 'other') {
      c.warn(
        get(m, 'protocol') as YNode,
        rpath + '.protocol',
        `protocol "${proto}" is not built in; it is drawn as category "other". Add "category:" here or define it under "protocols:"`,
      );
    }
    const epNode = get(m, 'endpoints');
    const epNodes = r.list(epNode, rpath + '.endpoints');
    if (epNodes.length > L.maxEndpoints) c.error(epNode as YNode, rpath + '.endpoints', `too many endpoints (limit ${L.maxEndpoints})`);
    const endpoints = epNodes
      .slice(0, L.maxEndpoints)
      .map((x, k): RelEndpoint | null => {
        const e = endpoint(x, `${rpath}.endpoints[${k}]`, true);
        return e && { device: e.device, iface: e.iface };
      })
      .filter((x): x is RelEndpoint => x !== null);
    if (epNodes.length < 2) {
      c.error(epNode && !isNull(epNode) ? epNode : m, rpath + '.endpoints', 'a relation needs at least 2 endpoints', epNode && !isNull(epNode) ? {} : { key: 'endpoints' });
      return;
    }
    const overNode = get(m, 'over');
    const over = r.list(overNode, rpath + '.over', true)
      .map((x, k) => r.str(x, `${rpath}.over[${k}]`, 200))
      .filter((x): x is string => x !== undefined);
    if (overNode) overNodes.set(id, overNode);
    relNodes.set(id, m);
    const rel: Relation = {
      id,
      protocol: proto,
      category: category || def.category,
      label: r.field(m, 'label', rpath, L.maxLabel),
      endpoints,
      over,
      direction: directionField(r, c, m, rpath, 'from the first endpoint to the last'),
      description: r.field(m, 'description', rpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), rpath + '.attrs'),
      line: m.line,
    };
    if (endpoints.length === epNodes.length && relationDevices(rel).length < 2) {
      c.warn(epNode as YNode, rpath + '.endpoints', 'all endpoints are on the same device');
    }
    relations.push(rel);
  });
  const relationMap = new Map(relations.map((x) => [x.id, x] as [string, Relation]));
  const linkMap = new Map(links.map((x) => [x.id, x] as [string, Link]));

  // resolve "over"
  for (const rel of relations) {
    const on = overNodes.get(rel.id) || (relNodes.get(rel.id) as YMap);
    const items = on.kind === 'seq' ? on.items : [on];
    const ok: string[] = [];
    rel.over.forEach((o, k) => {
      const at = items[k] || on;
      if (o === rel.id) {
        c.error(at, `relations.${rel.id}.over`, 'a relation cannot be carried over itself');
      } else if (relationMap.has(o) || linkMap.has(o) || networkMap.has(o)) {
        if (ok.indexOf(o) < 0) ok.push(o);
        const carrier = relationMap.get(o);
        if (carrier) {
          const cd = relationDevices(carrier);
          const missing = relationDevices(rel).filter((d) => cd.indexOf(d) < 0);
          if (missing.length) {
            c.warn(at, `relations.${rel.id}.over`, `carried over "${o}", but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not an endpoint of "${o}"`);
          }
        }
      } else {
        const kind = ids.get(o);
        // suggest from every declared id of a carrying kind (even ones that failed validation)
        const known = Array.from(ids.entries())
          .filter(([, v]) => v.kind === 'link' || v.kind === 'relation' || v.kind === 'network')
          .map(([key]) => key)
          .filter((key) => key !== rel.id);
        c.error(
          at,
          `relations.${rel.id}.over`,
          kind && kind.kind !== 'link' && kind.kind !== 'relation' && kind.kind !== 'network'
            ? `"${o}" is a ${kind.kind}; "over" may only reference links, relations or networks`
            : kind
              ? `"${o}" has errors of its own, see there`
              : `unknown link, relation or network "${o}"${suggest(o, known)}`,
        );
      }
    });
    rel.over = ok;
  }
  // cycle detection among relation->relation "over" edges
  const state = new Map<string, number>();
  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      c.error(overNodes.get(id) || (relNodes.get(id) as YMap), `relations.${id}.over`, `"over" forms a cycle: ${stack.concat(id).join(' → ')}`);
      return;
    }
    state.set(id, 1);
    const rel = relationMap.get(id) as Relation;
    for (const o of rel.over) if (relationMap.has(o)) visit(o, stack.concat(id));
    state.set(id, 2);
  };
  for (const rel of relations) visit(rel.id, []);
  // (cycles are reported above; renderers and highlighting are cycle-safe, so drafts still draw)

  // a Layer 2 switch is no endpoint of a routing, first-hop redundancy, BFD, LDP or PIM relation, nor of a tunnel or overlay
  for (const rel of relations) {
    const base = protocolBase(protocols, rel.protocol);
    const l3 = rel.category === 'tunnel' || rel.category === 'overlay' || LAYER3_PROTOCOLS.indexOf(base) >= 0;
    if (!l3) continue;
    for (const d of relationDevices(rel)) {
      const dev = deviceMap.get(d);
      if (!dev || !isLayer2Switch(dev)) continue;
      c.error(relNodes.get(rel.id) as YMap, `relations.${rel.id}.endpoints`, `"${d}" is a Layer 2 switch: it can't be an endpoint of ${lookupProtocol(protocols, rel.protocol).label} (that needs routing; set layer3: true on "${d}" to make it a Layer 3 switch)`);
    }
  }

  // ------------------------------------------------------------- layout
  // Presentation only: problems here are warnings and the entry is ignored,
  // so stored positions can never change what the model means.
  const layout: ModelLayout = { physical: new Map(), logical: new Map(), manual: { physical: new Set(), logical: new Set() } };
  const layoutNode = get(top, 'layout');
  if (!isNull(layoutNode)) {
    const ln = layoutNode as YNode;
    if (ln.kind !== 'map') c.warn(ln, 'layout', 'layout must be a mapping with "physical:" and/or "logical:"; it is ignored');
    else {
      ln.entries.forEach((e, view) => {
        if (view === 'manual') {
          // which nodes were placed by hand, per view (only used for the layout status)
          if (isNull(e.value)) return;
          if (e.value.kind !== 'map') {
            c.warn(e.value, 'layout.manual', 'expected "physical: [ids]" and/or "logical: [ids]"; ignored');
            return;
          }
          e.value.entries.forEach((me, mview) => {
            if ((mview !== 'physical' && mview !== 'logical') || me.value.kind !== 'seq') {
              c.warn(e.value, 'layout.manual.' + mview, 'expected "physical: [ids]" or "logical: [ids]"; ignored', { key: mview, line: me.keyLine });
              return;
            }
            for (const it of me.value.items) {
              const id = scalarText(it);
              if (id !== undefined) layout.manual[mview].add(id);
            }
          });
          return;
        }
        if (view !== 'physical' && view !== 'logical') {
          c.warn(ln, 'layout.' + view, `unknown layout view "${view}" (use physical, logical or manual); it is ignored`, { key: view, line: e.keyLine });
          return;
        }
        if (isNull(e.value)) return;
        if (e.value.kind !== 'map') {
          c.warn(e.value, 'layout.' + view, 'expected a mapping of "id: [x, y]" entries; ignored');
          return;
        }
        e.value.entries.forEach((pe, id) => {
          const p = `layout.${view}.${id}`;
          const known =
            view === 'physical'
              ? deviceMap.has(id)
              : deviceMap.has(id) || networkMap.has(id) || (relationMap.has(id) && relationDevices(relationMap.get(id) as Relation).length >= 3);
          if (!known) {
            const what = view === 'physical' ? 'device' : 'device, network or multipoint relation';
            c.warn(e.value, p, `position for "${id}", which is not a ${what} in this model; it is ignored`, { key: id, line: pe.keyLine });
            return;
          }
          const v = pe.value;
          const nums = v.kind === 'seq' && v.items.length === 2 ? v.items.map((it) => (it.kind === 'scalar' && typeof it.value === 'number' ? it.value : NaN)) : [];
          if (nums.length !== 2 || !nums.every((x) => isFinite(x) && Math.abs(x) <= MAX_COORD)) {
            c.warn(v, p, `position must be [x, y] with numbers between -${MAX_COORD} and ${MAX_COORD}; ignored`);
            return;
          }
          layout[view].set(id, { x: nums[0], y: nums[1] });
        });
      });
    }
  }

  // ------------------------------------------------------------- checks
  // which consistency checks are switched off or have another severity in this model
  const checkSettings = new Map<string, CheckSetting>();
  const checksNode = get(top, 'checks');
  if (!isNull(checksNode)) {
    const cm = r.map(checksNode, 'checks');
    if (cm) {
      const ids = CHECKS.map((x) => x.id);
      const values = ['off'].concat(SEVERITIES as readonly string[]);
      cm.entries.forEach((e, id) => {
        const p = 'checks.' + id;
        if (ids.indexOf(id) < 0) {
          c.error(cm, p, `unknown check "${id}"${suggest(id, ids, 0)}`, { key: id, line: e.keyLine });
          return;
        }
        const v = r.str(e.value, p, 20);
        if (v === undefined) return;
        if (values.indexOf(v) < 0) c.error(e.value, p, `"${v}" is not a setting for a check: use "off", "error", "warning" or "info"${suggest(v, values)}`);
        else checkSettings.set(id, v as CheckSetting);
      });
    }
  }

  const routes = new Map<string, Route>();
  for (const d of devices) for (const rt of d.routes) routes.set(routeKey(d.id, rt.index), rt);
  const index: ModelIndex = {
    groups: groupMap,
    devices: deviceMap,
    interfaces,
    links: linkMap,
    networks: networkMap,
    relations: relationMap,
    ifaceLink,
    routes,
  };
  const model: Model = {
    version: FORMAT_VERSION,
    title,
    description,
    groups,
    devices,
    links,
    networks,
    relations,
    protocols,
    services,
    layout,
    checks: checkSettings,
    demands: [],
    index,
  };
  model.demands = readDemands(r, c, top, model);
  // Derived VLANs are never chosen for the user: conflicting networks are reported.
  derive(model).addresses.forEach((assocs, key) => {
    assocs.forEach((a, j) => {
      if (a.vlan.state !== 'ambiguous') return;
      const at = (ifaceAddrNodes.get(key) as YNode[])[j];
      const nets = a.networks.filter((n) => (networkMap.get(n) as Network).vlan !== undefined).map((n) => `"${n}" (VLAN ${(networkMap.get(n) as Network).vlan})`);
      c.warn(at, `${ifacePaths.get(key)}.ip`, `the VLAN of ${a.address} on ${key} is ambiguous: it lies in ${nets.join(' and ')}; no VLAN is derived for it`);
    });
  });
  // A VLAN written on a virtual interface and the VLAN of the network its address lies in are two statements of one fact.
  for (const d of devices) {
    for (const i of d.logical) {
      if (i.vlan === undefined) continue;
      const other = interfaceAddresses(model, d.id, i.id).filter((a) => a.vlan.state === 'vlan' && a.vlan.vlan !== i.vlan)[0];
      if (!other || other.vlan.state !== 'vlan') continue;
      const key = ifaceKey(d.id, i.id);
      const vn = vlanNodes.get(key);
      if (vn) c.warn(vn, `${ifacePaths.get(key)}.vlan`, `"${i.id}" is the interface of VLAN ${i.vlan}, but its address ${other.address} lies in a network of VLAN ${other.vlan.vlan}`);
    }
  }

  // ------------------------------------------------------ consistency checks
  // They describe the network, not the format, so they run on a model whose format is valid; each finding is
  // attached to the entry (and field) it is about.
  if (!c.errors.length) {
    const place = (t: Target): { node: YNode; path: string; key?: string } | null => {
      const colon = t.ref.indexOf(':');
      const kind = t.ref.slice(0, colon);
      const id = t.ref.slice(colon + 1);
      let base: { node: YNode; path: string } | null = null;
      let field = t.field;
      if (kind === 'device') base = devNodes.get(id) || null;
      else if (kind === 'iface') {
        const n = ifaceNodes.get(id);
        if (n) base = { node: n, path: ifacePaths.get(id) as string };
      } else if (kind === 'route') base = routeNodes.get(id) || null;
      else if (kind === 'link') {
        const n = linkNodes.get(id);
        if (n) base = { node: n, path: `links.${id}` };
        // a field of one end ("a.untagged"): the end, then its key
        const dot = field ? field.indexOf('.') : -1;
        if (field && dot > 0) {
          const side = field.slice(0, dot);
          const en = endNodes.get(`${id}.${side}`);
          if (en) {
            base = { node: en, path: `links.${id}.${side}` };
            field = field.slice(dot + 1);
          }
        }
      } else if (kind === 'network') {
        const n = netNodes.get(id);
        if (n) base = { node: n, path: `networks.${id}` };
      } else if (kind === 'relation') {
        const n = relNodes.get(id);
        if (n) base = { node: n, path: `relations.${id}` };
      } else if (kind === 'group') {
        const n = groupNodes.get(id);
        if (n) base = { node: n, path: `groups.${id}` };
      }
      if (!base) return null;
      if (!field) return base;
      // a field inside a block ("protocols.bgp.asn"): as deep as it is written, then about the next key
      let at: { node: YNode; path: string } = base;
      for (const k of field.split('.')) {
        const fv = at.node.kind === 'map' ? get(at.node, k) : undefined;
        if (fv && !isNull(fv)) at = { node: fv, path: `${at.path}.${k}` };
        else return at.node.kind === 'map' ? { node: at.node, path: `${at.path}.${k}`, key: k } : at;
      }
      return at;
    };
    for (const f of runChecks(model, checkSettings)) {
      const at = place(f.at);
      if (!at) continue;
      c.finding(f.severity, at.node, at.path, f.message, at.key !== undefined ? { key: at.key } : {}, f.check, f.refs);
    }
  }
  return model;
}

/** The port settings written on a link end: speed, duplex and layer-2 tagging. */
interface L2Tag {
  speed?: string;
  duplex?: Duplex;
  mode?: PortMode;
  untagged?: number;
  tagged: VlanRange[];
}

/**
 * The tagging of a link end's port: `mode` (access or trunk), the untagged
 * VLAN (an access port's VLAN, a trunk's native VLAN) and the tagged VLANs,
 * each an ID or a range "100-199". VLAN IDs are 1–4094. Tagging needs a
 * mode, so nothing is assumed about a port that doesn't say what it is.
 */
function readTagging(r: Reader, c: Ctx, n: YMap, path: string): L2Tag {
  const out: L2Tag = { tagged: [] };
  // the port's configured speed and duplex (the connection's speed is the link's)
  out.speed = r.field(n, 'speed', path, 40);
  const duplex = r.field(n, 'duplex', path, 20);
  if (duplex !== undefined) {
    if ((DUPLEXES as readonly string[]).indexOf(duplex) >= 0) out.duplex = duplex as Duplex;
    else c.error(get(n, 'duplex') as YNode, path + '.duplex', `unknown duplex "${duplex}": use "full", "half" or "auto"${suggest(duplex, DUPLEXES)}`);
  }
  const mode = r.field(n, 'mode', path, 40);
  if (mode !== undefined) {
    if ((PORT_MODES as readonly string[]).indexOf(mode) >= 0) out.mode = mode as PortMode;
    else c.error(get(n, 'mode') as YNode, path + '.mode', `unknown port mode "${mode}": use "access" (one untagged VLAN) or "trunk" (tagged VLANs, plus a native one)${suggest(mode, PORT_MODES)}`);
  }
  out.untagged = r.vlanId(get(n, 'untagged'), path + '.untagged');
  const seen: number[] = [];
  r.list(get(n, 'tagged'), path + '.tagged', true).forEach((item, k) => {
    const ip = `${path}.tagged[${k}]`;
    const t = item.kind === 'scalar' ? scalarText(item) : undefined;
    const m = t !== undefined ? /^([0-9]{1,4})(?:\s*-\s*([0-9]{1,4}))?$/.exec(t) : null;
    const from = m ? Number(m[1]) : NaN;
    const to = m ? Number(m[2] !== undefined ? m[2] : m[1]) : NaN;
    if (!m || !(from >= VLAN_MIN && to <= VLAN_MAX && from <= to) || /^0/.test(m[1]) || (m[2] !== undefined && /^0/.test(m[2]))) {
      c.error(item, ip, `${t !== undefined ? `"${t}"` : kindOf(item)} is not a VLAN ID or range: use a whole number from ${VLAN_MIN} to ${VLAN_MAX}, or a range such as 100-199`);
      return;
    }
    const twice: number[] = [];
    for (let v = from; v <= to; v++) if (seen.indexOf(v) >= 0) twice.push(v);
    if (twice.length) {
      c.error(item, ip, `VLAN ${twice[0]}${twice.length > 1 ? ' and others' : ''} listed twice in "tagged" on this end`);
      return;
    }
    for (let v = from; v <= to; v++) seen.push(v);
    out.tagged.push({ from, to });
  });
  if (out.mode === undefined && mode === undefined && (out.untagged !== undefined || !isNull(get(n, 'tagged')))) {
    const k = out.untagged !== undefined ? 'untagged' : 'tagged';
    c.error(get(n, k) as YNode, path + '.' + k, 'VLAN tagging needs the port mode: add "mode: access" (one untagged VLAN) or "mode: trunk" (tagged VLANs, plus an untagged native VLAN)');
  }
  return out;
}

/**
 * The static routes of a device. Each has a destination prefix and a next
 * hop: an address (`via`), an exit interface of this device, both, or
 * `blackhole: true`. Only devices whose type routes may have them (see
 * model/device-types.ts routingRole). A route with errors is reported and
 * left out of the model; its entry stays in the file.
 */
function readRoutes(r: Reader, c: Ctx, m: YMap, dpath: string, dev: Device, nodes: Map<string, { node: YMap; path: string }>): Route[] {
  const out: Route[] = [];
  const listNode = get(m, 'routes');
  const items = r.list(listNode, dpath + '.routes');
  if (!items.length) return out;
  const role = routingRole(dev.type);
  if (role === null) {
    const what = dev.type === NO_DEVICE_TYPE ? 'has no type' : `is of type ${deviceTypeLabel(dev.type)}`;
    c.error(listNode as YNode, dpath + '.routes', `device "${dev.id}" ${what}, which has no routing table: static routes are allowed on ${ROUTE_DEVICE_TYPES.join(', ')} devices — set the type or delete the routes`);
    return out;
  }
  const L = c.limits;
  const ifaceIds = deviceInterfaces(dev).map((i) => i.id);
  items.forEach((n, k) => {
    const path = `${dpath}.routes[${k}]`;
    const rm = r.map(n, path);
    if (!rm) return;
    r.keys(rm, ROUTE_KEYS, path, ATTRS_HINT);
    let ok = true;
    const prefixText = r.reqStr(rm, 'prefix', path, 64);
    const p = prefixText !== undefined ? parsePrefix(prefixText) : null;
    if (prefixText === undefined) ok = false;
    else if (!p) {
      c.error(get(rm, 'prefix') as YNode, path + '.prefix', `invalid destination prefix: ${prefixProblem(prefixText)} (a default route is 0.0.0.0/0 or ::/0)`);
      ok = false;
    } else if (hasHostBits(p)) {
      c.warn(get(rm, 'prefix') as YNode, path + '.prefix', `${prefixText} has bits set beyond /${p.prefix}; the route is for the whole /${p.prefix} that contains it`);
    }
    const via = r.field(rm, 'via', path, 64);
    if (via !== undefined) {
      const a = parseAddress(via);
      if (!a) {
        c.error(get(rm, 'via') as YNode, path + '.via', via.indexOf('/') >= 0 && parseAddress(via.slice(0, via.indexOf('/'))) ? `write the next-hop address without a prefix length: ${via.slice(0, via.indexOf('/'))}` : `"${via}" is not an IPv4 or IPv6 address`);
        ok = false;
      } else if (p && a.version !== p.version) {
        c.error(get(rm, 'via') as YNode, path + '.via', `the next hop ${via} is an IPv${a.version} address, the destination ${prefixText} an IPv${p.version} prefix`);
        ok = false;
      }
    }
    const iface = r.field(rm, 'interface', path, 200);
    if (iface !== undefined && ifaceIds.indexOf(iface) < 0) {
      c.error(get(rm, 'interface') as YNode, path + '.interface', `device "${dev.id}" has no interface "${iface}"` + (ifaceIds.length ? suggest(iface, ifaceIds) : ' (the device declares no interfaces)'));
      ok = false;
    }
    const blackhole = r.bool(get(rm, 'blackhole'), path + '.blackhole') === true;
    if (blackhole && (via !== undefined || iface !== undefined)) {
      c.error(get(rm, 'blackhole') as YNode, path + '.blackhole', 'a blackhole route drops the traffic and has no next hop: delete "via" and "interface", or delete "blackhole: true"');
      ok = false;
    } else if (!blackhole && via === undefined && iface === undefined) {
      c.error(rm, path, `${prefixText ? 'route ' + prefixText : 'a route'} needs a next hop: "via" (an address), "interface" (an exit interface of "${dev.id}"), both, or "blackhole: true"`, { key: 'via' });
      ok = false;
    }
    const distance = r.int(get(rm, 'distance'), path + '.distance', 1, 255, 'administrative distance');
    if (!isNull(get(rm, 'distance')) && distance === undefined) ok = false;
    const metric = r.int(get(rm, 'metric'), path + '.metric', 0, 4294967295, 'metric');
    if (!isNull(get(rm, 'metric')) && metric === undefined) ok = false;
    const route: Route = {
      device: dev.id,
      index: k,
      prefix: prefixText || '',
      blackhole,
      vrf: r.field(rm, 'vrf', path, 100),
      name: r.field(rm, 'name', path, L.maxLabel),
      description: r.field(rm, 'description', path, L.maxDescription),
      attrs: r.attrs(get(rm, 'attrs'), path + '.attrs'),
      line: rm.line,
    };
    if (via !== undefined) route.via = via;
    if (iface !== undefined) route.iface = iface;
    if (distance !== undefined) route.distance = distance;
    if (metric !== undefined) route.metric = metric;
    nodes.set(routeKey(dev.id, k), { node: rm, path });
    if (ok) out.push(route);
  });
  return out;
}

/**
 * The DNS names of a device: each a valid name, configured once on the
 * device, associated with one or more of its interfaces that have DHCP off.
 * The association is to an interface, not to one of its addresses.
 */
function readDnsNames(r: Reader, c: Ctx, m: YMap, dpath: string, dev: Device, owner: Map<string, string>): DnsName[] {
  const out: DnsName[] = [];
  const seen = new Map<string, string>();
  const all = deviceInterfaces(dev);
  r.list(get(m, 'dns_names'), dpath + '.dns_names').forEach((n, k) => {
    const path = `${dpath}.dns_names[${k}]`;
    const nm = r.map(n, path);
    if (!nm) return;
    r.keys(nm, SCHEMA.dnsName, path);
    const name = r.reqStr(nm, 'name', path, 300);
    const nameNode = get(nm, 'name') as YNode;
    let ok = name !== undefined;
    if (name !== undefined) {
      const why = dnsNameProblem(name);
      const key = dnsNameKey(name);
      if (why) {
        c.error(nameNode, path + '.name', `invalid DNS name "${name}": ${why}`);
        ok = false;
      } else if (seen.has(key)) {
        c.error(nameNode, path + '.name', `DNS name "${name}" is listed twice on device "${dev.id}" (also as "${seen.get(key)}"); write it once and associate it with every interface it applies to`);
        ok = false;
      } else {
        seen.set(key, name);
        const prev = owner.get(key);
        if (prev !== undefined) c.warn(nameNode, path + '.name', `DNS name "${name}" is also configured on device "${prev}"`);
        else owner.set(key, dev.id);
      }
    }
    const ifNode = get(nm, 'interfaces');
    const ifaces: string[] = [];
    const items = r.list(ifNode, path + '.interfaces', true);
    items.forEach((x, j) => {
      const ip = `${path}.interfaces[${j}]`;
      const id = r.str(x, ip, 200);
      if (id === undefined) return;
      const target = all.find((i) => i.id === id);
      if (!target) {
        const names = all.map((i) => i.id);
        c.error(x, ip, `device "${dev.id}" has no interface "${id}"` + (names.length ? suggest(id, names) : ' (the device declares no interfaces)'));
      } else if (target.dhcp) {
        c.error(x, ip, `interface "${id}" obtains its address by DHCP, so a DNS name can't be associated with it; associate the name with an interface whose addresses are configured, or set "dhcp: false" on "${id}"`);
      } else if (ifaces.indexOf(id) >= 0) {
        c.error(x, ip, `interface "${id}" is listed twice for this DNS name`);
      } else {
        ifaces.push(id);
        return;
      }
      ok = false;
    });
    if (!items.length) {
      const has = ifNode && !isNull(ifNode);
      c.error(has ? (ifNode as YNode) : nm, path + '.interfaces', `DNS name "${name || '?'}" is associated with no interface — list one or more interfaces of "${dev.id}" under "interfaces:"`, has ? {} : { key: 'interfaces' });
      ok = false;
    }
    if (ok && name !== undefined) out.push({ name, interfaces: ifaces, line: nm.line });
  });
  return out;
}

/** A relation's or a link's direction: bidirectional unless "direction: unidirectional" is written. Anything else is an error. */
function directionField(r: Reader, c: Ctx, m: YMap, path: string, way: string): Direction {
  const d = r.field(m, 'direction', path, 40);
  if (d === undefined) return 'bidirectional';
  if ((DIRECTIONS as readonly string[]).indexOf(d) >= 0) return d as Direction;
  c.error(get(m, 'direction') as YNode, path + '.direction', `unknown direction "${d}": use "bidirectional" (the default) or "unidirectional" (${way})${suggest(d, DIRECTIONS)}`);
  return 'bidirectional';
}

/** "a loopback", "a tunnel interface of eth0" … for messages. */
function describeIface(i: Interface): string {
  if (i.type === 'loopback') return 'a loopback';
  if (i.type === 'physical') return 'a physical interface';
  return `a ${i.type} interface`;
}

/** A device's type: one of the format's device types, or none. Anything else is an error. */
function deviceType(r: Reader, m: YMap, dpath: string, c: Ctx): string {
  const t = r.field(m, 'type', dpath, 40);
  if (t === undefined) return NO_DEVICE_TYPE;
  if (isDeviceType(t)) return t;
  c.error(get(m, 'type') as YNode, dpath + '.type', `unknown device type "${t}"${suggest(t, DEVICE_TYPE_IDS, 20)}`);
  return NO_DEVICE_TYPE;
}

// ------------------------------------------------------------ routing services

const ROUTER_TYPES = ROUTE_DEVICE_TYPES.filter((t) => routingRole(t) === 'router' && t !== 'switch');
/**
 * What a Layer 2 switch (a switch without layer3: true) may have of
 * layer 3: one management interface with addresses (a VLAN interface or a
 * management port), its VRF (a management VRF) and static routes in it or
 * in the default table (a default gateway towards management). Everything
 * else is Layer 3 configuration and an error: a second interface with
 * addresses (that would be inter-VLAN routing), a tunnel interface, a
 * VRRP / HSRP … group, a router ID, a VRF on an interface without
 * addresses, a route in another VRF. (Routing protocols are refused where
 * `protocols:` is read; relations of routing, tunnel and overlay protocols
 * at it are refused with the relations.)
 */
function layer2SwitchRules(c: Ctx, m: YMap, dpath: string, dev: Device): void {
  const fix = 'set layer3: true to make it a Layer 3 switch';
  const nodeOf = (i: Interface): { node: YNode; path: string } => {
    const lists: Array<['interfaces' | 'logical_interfaces', Interface[]]> = [['interfaces', dev.interfaces], ['logical_interfaces', dev.logical]];
    for (const [key, list] of lists) {
      const k = list.indexOf(i);
      if (k < 0) continue;
      const items = get(m, key) as YNode;
      // the interface's own entry (a mapping with its id, or the "- eth0" shorthand), else the list
      const idOf = (x: YNode): string => {
        const n = x.kind === 'map' ? get(x, 'id') : x;
        return n && n.kind === 'scalar' ? String(n.value) : '';
      };
      const found = items.kind === 'seq' ? items.items.find((x) => idOf(x) === i.id) : undefined;
      return { node: found || items, path: `${dpath}.${key}.${i.id}` };
    }
    return { node: m, path: dpath };
  };
  const ridNode = get(m, 'router_id');
  if (ridNode && !isNull(ridNode)) c.error(ridNode as YNode, dpath + '.router_id', `"${dev.id}" is a Layer 2 switch: it has no router ID (${fix})`);
  const all = deviceInterfaces(dev);
  const addressed = all.filter((i) => i.addresses.length || i.dhcp);
  const mgmt = addressed[0];
  for (const i of addressed.slice(1)) {
    const at = nodeOf(i);
    c.error(at.node, at.path, `"${dev.id}" is a Layer 2 switch: it has one management interface with addresses (${mgmt.id}); ${i.id} with addresses too would route between subnets (${fix})`);
  }
  for (const i of all) {
    const at = nodeOf(i);
    if (i.type === 'tunnel') c.error(at.node, at.path, `"${dev.id}" is a Layer 2 switch: tunnel interface ${i.id} needs routing (${fix})`);
    if (i.services.length) c.error(at.node, at.path + '.protocols', `"${dev.id}" is a Layer 2 switch: ${i.id} can't be a member of a ${i.services.map((s) => s.id.toUpperCase()).join(', ')} group (${fix})`);
    if (i.vrf !== undefined && i !== mgmt) c.error(at.node, at.path + '.vrf', `"${dev.id}" is a Layer 2 switch: only its management interface may be in a VRF (VRF ${i.vrf} on ${i.id}; ${fix})`);
  }
  const mvrf = mgmt ? mgmt.vrf : undefined;
  dev.routes.forEach((rt) => {
    if (rt.vrf === undefined || rt.vrf === mvrf) return;
    c.error(m, `${dpath}.routes[${rt.index}].vrf`, `"${dev.id}" is a Layer 2 switch: its routes are for management, in ${mvrf ? 'VRF ' + mvrf + ' or ' : ''}the default table (VRF ${rt.vrf}; ${fix})`);
  });
}

/** The protocols (base ids) whose relations need a Layer 3 device at every end (besides tunnels and overlays). */
const LAYER3_PROTOCOLS = ['bgp', 'ospf', 'isis', 'eigrp', 'rip', 'ldp', 'pim', 'bfd', 'vrrp', 'hsrp', 'glbp', 'carp'];

const BUILTIN_SERVICE_IDS = BUILTIN_SERVICES.map((s) => s.id);

/**
 * A protocol of the model's `protocols:` section that declares `params` (a
 * list, possibly empty) or `router_id` is a routing service devices can
 * enable; its parameters are declared like the built-in ones.
 */
function readServiceDefinition(r: Reader, c: Ctx, m: YMap, path: string, id: string, rawId: string, label: string): ServiceDef | null {
  const pn = get(m, 'params');
  const rn = get(m, 'router_id');
  if (isNull(pn) && isNull(rn)) return null;
  let routerId: RouterIdUse = 'none';
  const ru = r.field(m, 'router_id', path, 20);
  if (ru !== undefined) {
    if (ru === 'required' || ru === 'optional' || ru === 'none') routerId = ru;
    else c.error(rn as YNode, path + '.router_id', `router_id of a protocol says whether it uses a router ID: "required", "optional" or "none"`);
  }
  const params: ParamDef[] = [];
  r.list(pn, path + '.params').forEach((n, i) => {
    const ppath = `${path}.params[${i}]`;
    const pm = r.map(n, ppath);
    if (!pm) return;
    r.keys(pm, SCHEMA.param, ppath);
    const key = r.reqStr(pm, 'key', ppath, 40);
    if (key === undefined) return;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key) || key === ROUTER_ID_KEY) {
      c.error(get(pm, 'key') as YNode, ppath + '.key', key === ROUTER_ID_KEY ? '"router_id" is the shared router ID: declare it with the protocol\'s router_id instead' : `invalid parameter key "${key}": use lowercase letters, digits, _ and -, starting with a letter`);
      return;
    }
    if (params.some((p) => p.key === key)) {
      c.error(get(pm, 'key') as YNode, ppath + '.key', `parameter "${key}" is declared twice`);
      return;
    }
    const typeS = r.field(pm, 'type', ppath, 20) || 'text';
    if (PARAM_TYPES.indexOf(typeS as ParamType) < 0) c.error(get(pm, 'type') as YNode, ppath + '.type', `unknown parameter type "${typeS}"${suggest(typeS, PARAM_TYPES)}`);
    const scopeS = r.field(pm, 'scope', ppath, 20) || 'device';
    if (PARAM_SCOPES.indexOf(scopeS as ParamScope) < 0) c.error(get(pm, 'scope') as YNode, ppath + '.scope', `unknown scope "${scopeS}": use device, interface or endpoint`);
    const p: ParamDef = { key, label: r.field(pm, 'label', ppath, 60) || key, type: (PARAM_TYPES.indexOf(typeS as ParamType) >= 0 ? typeS : 'text') as ParamType, scope: (PARAM_SCOPES.indexOf(scopeS as ParamScope) >= 0 ? scopeS : 'device') as ParamScope };
    if (r.bool(get(pm, 'required'), ppath + '.required')) p.required = true;
    if (p.type === 'int') {
      p.min = r.int(get(pm, 'min'), ppath + '.min', 0, 4294967295, 'minimum') ?? 0;
      p.max = r.int(get(pm, 'max'), ppath + '.max', 0, 4294967295, 'maximum') ?? 4294967295;
    }
    const vals = r.list(get(pm, 'values'), ppath + '.values', true).map((x, j) => r.str(x, `${ppath}.values[${j}]`, 60)).filter((x): x is string => x !== undefined);
    if (p.type === 'enum') {
      if (!vals.length) c.error(pm, ppath + '.values', `an enum parameter needs its values`, { key: 'values' });
      p.values = vals;
    }
    const sug = r.list(get(pm, 'suggest'), ppath + '.suggest', true).map((x, j) => r.str(x, `${ppath}.suggest[${j}]`, 60)).filter((x): x is string => x !== undefined);
    if (sug.length) p.suggest = sug;
    const help = r.field(pm, 'description', ppath, 300);
    if (help) p.help = help;
    params.push(p);
  });
  return { id, label: label || rawId, routerId, params, sessions: true, builtin: false };
}

/**
 * A `protocols:` block of a device (the services it enables, each a mapping
 * of parameters, `{}` without any) or of an interface (its settings of the
 * device's services that have interface parameters). Values are kept as
 * written when valid; a missing mandatory parameter is an error.
 */
function readServices(
  r: Reader,
  c: Ctx,
  node: YNode,
  path: string,
  services: ServiceRegistry,
  scope: 'device' | 'interface',
  device: string,
  rids: Array<{ svc: ServiceConfig; text: string; node: YNode; path: string }>,
  dev?: Device,
): ServiceConfig[] {
  const m = r.map(node, path);
  if (!m) return [];
  const out: ServiceConfig[] = [];
  m.entries.forEach((e, key) => {
    const spath = `${path}.${key}`;
    const def = services.get(key);
    if (!def) {
      c.error(m, spath, `"${key}" is not a routing service${suggest(key, services.keys(), 20)} (a protocol of the model becomes one when its definition declares params)`, { key, line: e.keyLine });
      return;
    }
    const svc: ServiceConfig = { id: key, values: new Map(), line: e.keyLine };
    const own = paramsAt(def, scope);
    if (scope === 'interface') {
      if (!own.length) {
        c.error(m, spath, `${def.label} has no settings per interface; enable it on the device (its protocols:)`, { key, line: e.keyLine });
        return;
      }
      if (dev && !dev.services.some((s) => s.id === key)) {
        c.error(m, spath, `${def.label} is not enabled on "${device}": enable it in the device's protocols: first`, { key, line: e.keyLine });
      }
    }
    const v = e.value;
    if (!isNull(v)) {
      const pm = r.map(v, spath);
      if (pm) {
        const allowed = own.map((p) => p.key).concat(scope === 'device' && def.routerId !== 'none' ? [ROUTER_ID_KEY] : []);
        const where: { [k: string]: string } = {};
        for (const p of def.params) {
          if (p.scope === scope) continue;
          where[p.key] = p.scope === 'interface' ? `${p.label} is set per interface, in the interface's protocols:` : p.scope === 'endpoint' ? `${p.label} is set on ${def.label} relations, in their attrs (per device: ${p.key}: {${device}: …})` : `${p.label} is set on the device, in its protocols:`;
        }
        if (scope === 'interface' || def.routerId === 'none') where[ROUTER_ID_KEY] = `${def.label} uses no router ID`;
        r.keys(pm, allowed, spath, '', where);
        pm.entries.forEach((pe, pk) => {
          if (pk === ROUTER_ID_KEY && allowed.indexOf(pk) >= 0) {
            const t = r.str(pe.value, `${spath}.${pk}`, 64);
            if (t !== undefined) rids.push({ svc, text: t, node: pe.value, path: `${spath}.${pk}` });
            return;
          }
          const p = own.find((x) => x.key === pk);
          if (!p) return;
          const pv = pe.value;
          if (isNull(pv) || pv.kind !== 'scalar') {
            c.error(pv && !isNull(pv) ? pv : pm, `${spath}.${pk}`, `${p.label} needs a single value`, isNull(pv) ? { key: pk } : {});
            return;
          }
          const t = scalarText(pv) || '';
          const why = paramProblem(p, t);
          if (why) c.error(pv, `${spath}.${pk}`, why);
          else svc.values.set(pk, t.trim());
        });
      }
    }
    // mandatory parameters: nothing is chosen for the user
    for (const p of own) {
      if (!p.required || svc.values.has(p.key)) continue;
      const pm = !isNull(v) && v.kind === 'map' ? (v as YMap) : null;
      if (pm && pm.entries.has(p.key)) continue;
      c.error(pm || m, spath, `${def.label} needs ${p.label.charAt(0).toLowerCase() + p.label.slice(1)} (${p.key})${p.help ? ': ' + p.help : ''}`, pm ? { key: p.key } : { key, line: e.keyLine });
    }
    out.push(svc);
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A router ID as written: an IPv4 address, or a loopback of the device that has an IPv4 address. */
function resolveRouterId(c: Ctx, dev: Device, text: string, node: YNode, path: string): RouterIdValue | null {
  if (routerIdAddress(text)) return { text, address: text.trim() };
  const lo = dev.logical.find((i) => i.id === text);
  if (lo && lo.type === 'loopback') {
    const v4 = lo.addresses.map((a) => parsePrefix(a, true)).find((p) => !!p && p.version === 4);
    if (!v4) {
      c.error(node, path, `loopback "${text}" has no IPv4 address to be the router ID`);
      return { text, iface: text };
    }
    return { text, iface: text, address: (v4 as IpPrefix).bytes.join('.') };
  }
  const any = deviceInterfaces(dev).find((i) => i.id === text);
  const loops = dev.logical.filter((i) => i.type === 'loopback').map((i) => i.id);
  c.error(
    node,
    path,
    any
      ? `"${text}" is ${any.type === 'physical' ? 'a port' : 'not a loopback'}: a router ID is an IPv4 address or a loopback of "${dev.id}"`
      : `"${text}" is not a router ID: write an IPv4 address (e.g. 10.255.0.1) or the id of a loopback of "${dev.id}"${loops.length ? suggest(text, loops) : ''}`,
  );
  return null;
}
