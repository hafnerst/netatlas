import { IpPrefix, addrKey, hasHostBits, parsePrefix, prefixContains, prefixProblem } from '../model/ip';
import { derive, interfaceAddresses, networkMismatch, networkMismatchText } from '../model/derive';
import {
  CATEGORIES,
  Category,
  DIRECTIONS,
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
  RelEndpoint,
  Relation,
  TunnelEnd,
  deviceInterfaces,
  ifaceKey,
  relationDevices,
} from '../model/types';
import { dnsNameKey, dnsNameProblem } from '../model/dns';
import { DEVICE_TYPE_IDS, NO_DEVICE_TYPE, isDeviceType } from '../model/device-types';
import { COLOR_RE, DEFAULT_STYLE, builtinProtocols, lookupProtocol, normalizeProtocol } from '../model/protocols';
import { YMap, YNode, YSeq, YamlError, YamlLimits, parseYaml } from '../yaml/parse';
import { FORMAT_VERSION, RENAMED_GROUP_KINDS, RETIRED, SCHEMA } from '../yaml/schema';
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
}

/** largest accepted coordinate in the layout section */
export const MAX_COORD = 1000000;

// keys per mapping kind: the single definition is yaml/schema.ts
const TOP_KEYS = SCHEMA.top;
const GROUP_KEYS = SCHEMA.group;
const DEVICE_KEYS = SCHEMA.device;
const LINK_KEYS = SCHEMA.link;
const LINK_END_KEYS = SCHEMA.linkEnd;
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
      return { model: null, root: null, errors: [{ severity: 'error', line: e.line, path: '', message: 'YAML: ' + e.message }], warnings: [] };
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
  return { model, root, errors: c.errors, warnings: c.warnings };
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
    if (Object.prototype.hasOwnProperty.call(RENAMED_GROUP_KINDS, kind)) {
      c.error(get(m, 'kind') as YNode, gpath + '.kind', `group kind "${kind}" is not accepted — write "kind: ${RENAMED_GROUP_KINDS[kind]}"`);
    }
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
  capped(r.list(get(top, 'devices'), 'devices'), L.maxDevices, 'devices', 'devices').forEach((n, i) => {
    const path = `devices[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, DEVICE_KEYS, path, ATTRS_HINT, RETIRED.device);
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
    const dev: Device = {
      id,
      label: r.field(m, 'label', dpath, L.maxLabel) || id,
      type: deviceType(r, m, dpath, c),
      group: group !== undefined && groupMap.has(group) ? group : undefined,
      tier,
      description: r.field(m, 'description', dpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), dpath + '.attrs'),
      interfaces: [],
      logical: [],
      dnsNames: [],
      line: m.line,
    };
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
      r.keys(im, SCHEMA[where], ipath, ATTRS_HINT, RETIRED[where]);
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
        members: [],
        description: r.field(im, 'description', ipath, L.maxDescription),
        attrs: r.attrs(get(im, 'attrs'), ipath + '.attrs'),
        line: im.line,
      };
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

  /** link ends whose network ids are checked once the networks are read */
  const endNetworks: Array<{ end: LinkEnd; nodes: YNode[]; path: string }> = [];
  /**
   * Parse "dev" / "dev:iface" / a mapping. A relation endpoint is nothing
   * more; a link end may also list the networks the cable carries there.
   */
  const endpoint = (n: YNode, path: string, extended: boolean): (RelEndpoint & { networks: string[]; netNodes: YNode[] }) | null => {
    let device: string | undefined;
    let iface: string | undefined;
    const networks: string[] = [];
    const netNodes: YNode[] = [];
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
      r.keys(n, extended ? EP_KEYS : LINK_END_KEYS, path, '', extended ? RETIRED.endpoint : RETIRED.linkEnd);
      device = r.reqStr(n, 'device', path, 200);
      iface = r.field(n, 'interface', path, 200);
      if (!extended) {
        // networks the cable carries at this end: a fact of the link end, kept exactly as configured
        r.list(get(n, 'networks'), path + '.networks', true).forEach((nn, k) => {
          const id = r.str(nn, `${path}.networks[${k}]`, 200);
          if (id === undefined) return;
          if (networks.indexOf(id) >= 0) c.error(nn, `${path}.networks[${k}]`, `network "${id}" is listed twice on this end`);
          else {
            networks.push(id);
            netNodes.push(nn);
          }
        });
      }
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
    return { device, iface, networks, netNodes };
  };

  // -------------------------------------------------------------- links
  const links: Link[] = [];
  const linkNodes = new Map<string, YMap>();
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
      const end: LinkEnd = { device: ep.device, iface: ep.iface, networks: ep.networks };
      endNetworks.push({ end, nodes: ep.netNodes, path: `${lpath}.${side}.networks` });
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
      description: r.field(m, 'description', lpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), lpath + '.attrs'),
      line: m.line,
    });
  });

  // ----------------------------------------------------------- networks
  const networks: Network[] = [];
  const seenPrefixes: Array<{ id: string; p: IpPrefix }> = [];
  capped(r.list(get(top, 'networks'), 'networks'), L.maxNetworks, 'networks', 'networks').forEach((n, i) => {
    const path = `networks[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, NET_KEYS, path, ATTRS_HINT, RETIRED.network);
    const id = r.id(m, path);
    if (!id) return;
    const npath = `networks.${id}`;
    if (!claim(id, 'network', m, path)) return;
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

  // link ends: every network id must name a network; the two ends are configured independently, a difference is reported, never repaired
  for (const { end, nodes, path } of endNetworks) {
    const ok: string[] = [];
    end.networks.forEach((nid, k) => {
      if (networkMap.has(nid)) ok.push(nid);
      else c.error(nodes[k], `${path}[${k}]`, `unknown network "${nid}"${suggest(nid, networkMap.keys())}`);
    });
    end.networks = ok;
  }
  for (const l of links) {
    const mm = networkMismatch(l.a.networks, l.b.networks);
    if (mm) c.warn(linkNodes.get(l.id) as YMap, `links.${l.id}`, `the two ends of this link carry different networks (${networkMismatchText(mm, (nid) => (networkMap.get(nid) as Network).label)})`);
  }

  // ---------------------------------------------------------- relations
  const relations: Relation[] = [];
  const overNodes = new Map<string, YNode>();
  const relNodes = new Map<string, YMap>();
  capped(r.list(get(top, 'relations'), 'relations'), L.maxRelations, 'relations', 'relations').forEach((n, i) => {
    const path = `relations[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, REL_KEYS, path, ATTRS_HINT, RETIRED.relation);
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
      direction: relationDirection(r, c, m, rpath),
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

  const index: ModelIndex = {
    groups: groupMap,
    devices: deviceMap,
    interfaces,
    links: linkMap,
    networks: networkMap,
    relations: relationMap,
    ifaceLink,
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
    layout,
    index,
  };
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
  return model;
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

/** A relation's direction: bidirectional unless "direction: unidirectional" is written. Anything else is an error. */
function relationDirection(r: Reader, c: Ctx, m: YMap, rpath: string): Direction {
  const d = r.field(m, 'direction', rpath, 40);
  if (d === undefined) return 'bidirectional';
  if ((DIRECTIONS as readonly string[]).indexOf(d) >= 0) return d as Direction;
  c.error(get(m, 'direction') as YNode, rpath + '.direction', `unknown direction "${d}": use "bidirectional" (the default) or "unidirectional" (from the first endpoint to the last)${suggest(d, DIRECTIONS)}`);
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
