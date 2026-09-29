import { addrKey, parseAddress, parsePrefix, prefixContains, prefixProblem } from '../model/ip';
import {
  Attrs,
  CATEGORIES,
  Category,
  Device,
  Endpoint,
  Group,
  Interface,
  LINE_STYLES,
  LOGICAL_IFACE_TYPES,
  LineStyle,
  Link,
  Model,
  ModelIndex,
  ModelLayout,
  Network,
  RelEndpoint,
  Relation,
  ifaceKey,
  relationDevices,
} from '../model/types';
import { DEVICE_TYPE_IDS, NO_DEVICE_TYPE, isDeviceType } from '../model/device-types';
import { COLOR_RE, DEFAULT_STYLE, builtinProtocols, lookupProtocol, normalizeProtocol } from '../model/protocols';
import { YMap, YNode, YamlError, YamlLimits, parseYaml } from '../yaml/parse';
import { FORMAT_VERSION, SCHEMA } from '../yaml/schema';
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
const IFACE_KEYS = SCHEMA.interface;
const LINK_KEYS = SCHEMA.link;
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
    c.error(dummy, '', 'the document is empty — expected a mapping starting with "netatlas: 1"');
    return null;
  }
  const top = r.map(root, '(document)');
  if (!top) return null;
  r.keys(top, TOP_KEYS, '', '');

  const verNode = get(top, 'netatlas');
  if (isNull(verNode)) {
    c.error(top, 'netatlas', `missing format version — add "netatlas: ${FORMAT_VERSION}" as the first line`, { key: 'netatlas', line: 1 });
  } else if (!(verNode!.kind === 'scalar' && verNode!.value === FORMAT_VERSION)) {
    c.error(verNode!, 'netatlas', `unsupported format version; this build understands "netatlas: ${FORMAT_VERSION}"`);
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
    groups.push({
      id,
      label: r.field(m, 'label', gpath, L.maxLabel) || id,
      kind: (r.field(m, 'kind', gpath, 40) || '').toLowerCase(),
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
  const ifaceNodes = new Map<string, YMap>();
  /** canonical address -> first "device:iface" using it */
  const addrOwner = new Map<string, { where: string; node: YNode }>();
  capped(r.list(get(top, 'devices'), 'devices'), L.maxDevices, 'devices', 'devices').forEach((n, i) => {
    const path = `devices[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, DEVICE_KEYS, path, ATTRS_HINT);
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
      vendor: r.field(m, 'vendor', dpath, L.maxLabel),
      model: r.field(m, 'model', dpath, L.maxLabel),
      role: r.field(m, 'role', dpath, L.maxLabel),
      mgmt: r.field(m, 'mgmt', dpath, L.maxLabel),
      tier,
      description: r.field(m, 'description', dpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), dpath + '.attrs'),
      interfaces: [],
      line: m.line,
    };
    const ifItems = capped(r.list(get(m, 'interfaces'), dpath + '.interfaces'), L.maxInterfacesPerDevice, dpath + '.interfaces', 'interfaces on one device');
    ifItems.forEach((inode, k) => {
      const ipath = `${dpath}.interfaces[${k}]`;
      let im: YMap | null;
      if (inode.kind === 'scalar') {
        // shorthand: "- eth0"
        im = { kind: 'map', entries: new Map([['id', { key: 'id', keyLine: inode.line, value: inode }]]), line: inode.line, col: inode.col };
      } else im = r.map(inode, ipath);
      if (!im) return;
      r.keys(im, IFACE_KEYS, ipath, ATTRS_HINT);
      const iid = r.id(im, ipath, IFACE_RE, 'interface id');
      if (!iid) return;
      const key = ifaceKey(id, iid);
      if (interfaces.has(key)) {
        c.error(get(im, 'id') as YNode, ipath + '.id', `duplicate interface "${iid}" on device "${id}"`);
        return;
      }
      if (interfaces.size >= L.maxInterfaces) {
        c.error(im, ipath, `too many interfaces in total (limit ${L.maxInterfaces})`);
        return;
      }
      const ipNode = get(im, 'ip');
      const addrNodes = r.list(ipNode, ipath + '.ip', true);
      const addrs: string[] = [];
      const type = (r.field(im, 'type', ipath, 40) || 'physical').toLowerCase();
      const isLoop = type === 'loopback';
      const kind = isLoop ? 'loopback' : 'interface';
      const seenHere = new Set<string>();
      addrNodes.forEach((an, j) => {
        const a = r.str(an, `${ipath}.ip[${j}]`, 64);
        if (a === undefined) {
          if (isLoop) c.error(an, `${ipath}.ip[${j}]`, 'empty address');
          return;
        }
        addrs.push(a);
        const p = parsePrefix(a, !isLoop ? false : true);
        if (!p) {
          const why = prefixProblem(a) || `"${a}" is not a valid address`;
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
        const owner = addrOwner.get(k2);
        if (owner) c.warn(an, `${ipath}.ip[${j}]`, `address ${a.split('/')[0]} is also assigned to ${owner.where}`);
        else addrOwner.set(k2, { where: key, node: an });
      });
      if (isLoop && !addrs.length) {
        c.error(ipNode && !isNull(ipNode) ? ipNode : im, ipath + '.ip', `loopback "${iid}" needs at least one IPv4 or IPv6 address with prefix length (e.g. 10.255.0.1/32 or 2001:db8::1/128)`, ipNode && !isNull(ipNode) ? {} : { key: 'ip' });
      }
      const iface: Interface = {
        id: iid,
        device: id,
        label: r.field(im, 'label', ipath, L.maxLabel),
        type,
        speed: r.field(im, 'speed', ipath, 40),
        media: r.field(im, 'media', ipath, 40),
        addresses: addrs,
        vlan: r.field(im, 'vlan', ipath, 100),
        mac: r.field(im, 'mac', ipath, 40),
        description: r.field(im, 'description', ipath, L.maxDescription),
        attrs: r.attrs(get(im, 'attrs'), ipath + '.attrs'),
        line: im.line,
      };
      interfaces.set(key, iface);
      ifaceNodes.set(key, im);
      dev.interfaces.push(iface);
    });
    // router_id: a loopback of this device
    const ridNode = get(m, 'router_id');
    const rid = r.str(ridNode, dpath + '.router_id', 100);
    if (rid !== undefined) {
      const inf = interfaces.get(ifaceKey(id, rid));
      const loops = dev.interfaces.filter((x) => x.type === 'loopback').map((x) => x.id);
      if (!inf) {
        c.error(ridNode as YNode, dpath + '.router_id', `device "${id}" has no loopback "${rid}"` + (loops.length ? suggest(rid, loops) : ' (add a loopback interface first)'));
      } else if (inf.type !== 'loopback') {
        c.error(ridNode as YNode, dpath + '.router_id', `router_id must name a loopback interface; "${rid}" has type "${inf.type}"`);
      } else {
        dev.routerId = rid;
        if (!inf.addresses.some((a) => a.indexOf(':') < 0 && !!parseAddress(a.split('/')[0]))) {
          c.warn(ridNode as YNode, dpath + '.router_id', `loopback "${rid}" has no IPv4 address; router IDs are 32-bit (dotted-quad) values`);
        }
      }
    }
    devices.push(dev);
  });
  const deviceMap = new Map(devices.map((d) => [d.id, d] as [string, Device]));

  /** Parse "dev" / "dev:iface" / {device, interface, role, address, attrs}. */
  const endpoint = (n: YNode, path: string, extended: boolean): RelEndpoint | null => {
    let device: string | undefined;
    let iface: string | undefined;
    let role: string | undefined;
    let address: string | undefined;
    let attrs: Attrs = [];
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
      r.keys(n, extended ? EP_KEYS : ['device', 'interface'], path);
      device = r.reqStr(n, 'device', path, 200);
      iface = r.field(n, 'interface', path, 200);
      if (extended) {
        role = r.field(n, 'role', path, 60);
        address = r.field(n, 'address', path, 100);
        attrs = r.attrs(get(n, 'attrs'), path + '.attrs');
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
      const names = dev.interfaces.map((x) => x.id);
      c.error(
        n.kind === 'map' ? (get(n, 'interface') as YNode) : n,
        path,
        `device "${device}" has no interface "${iface}"` + (names.length ? suggest(iface, names) : ' (the device declares no interfaces)'),
      );
      return null;
    }
    return { device, iface, role, address, attrs };
  };

  // -------------------------------------------------------------- links
  const links: Link[] = [];
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
    const ends: Array<Endpoint | null> = ['a', 'b'].map((side) => {
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
        if (LOGICAL_IFACE_TYPES.indexOf(inf.type) >= 0) {
          c.error(
            en as YNode,
            `${lpath}.${side}`,
            `interface "${key}" has type "${inf.type}", which is logical — a physical link must end on a physical port. ` +
              'Model tunnels, loopbacks, SVIs and bundles as relations instead.',
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
      return { device: ep.device, iface: ep.iface };
    });
    const [a, b] = ends;
    if (!a || !b) return;
    if (a.device === b.device && a.iface === b.iface) {
      c.error(m, lpath, 'a link cannot connect an endpoint to itself');
      return;
    }
    const ia = a.iface ? interfaces.get(ifaceKey(a.device, a.iface)) : undefined;
    const ib = b.iface ? interfaces.get(ifaceKey(b.device, b.iface)) : undefined;
    if (ia && ib && ia.speed && ib.speed && ia.speed.toLowerCase() !== ib.speed.toLowerCase()) {
      c.warn(m, lpath, `speed mismatch: ${a.device}:${a.iface} is ${ia.speed}, ${b.device}:${b.iface} is ${ib.speed}`);
    }
    links.push({
      id,
      a,
      b,
      medium: (r.field(m, 'medium', lpath, 40) || (ia && ia.media) || (ib && ib.media) || 'unspecified').toLowerCase(),
      speed: r.field(m, 'speed', lpath, 40) || (ia && ia.speed) || (ib && ib.speed),
      label: r.field(m, 'label', lpath, L.maxLabel),
      cable: r.field(m, 'cable', lpath, L.maxLabel),
      description: r.field(m, 'description', lpath, L.maxDescription),
      attrs: r.attrs(get(m, 'attrs'), lpath + '.attrs'),
      line: m.line,
    });
  });

  // ----------------------------------------------------------- networks
  const networks: Network[] = [];
  capped(r.list(get(top, 'networks'), 'networks'), L.maxNetworks, 'networks', 'networks').forEach((n, i) => {
    const path = `networks[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, NET_KEYS, path, ATTRS_HINT);
    const id = r.id(m, path);
    if (!id) return;
    const npath = `networks.${id}`;
    if (!claim(id, 'network', m, path)) return;
    const memberNodes = r.list(get(m, 'members'), npath + '.members');
    if (memberNodes.length > L.maxMembers) c.error(m, npath + '.members', `too many members (limit ${L.maxMembers})`, { key: 'members' });
    const cidrNodes = r.list(get(m, 'cidr'), npath + '.cidr', true);
    const cidr: string[] = [];
    const prefixes = cidrNodes
      .map((x, k) => {
        const s = r.str(x, `${npath}.cidr[${k}]`, 64);
        if (s === undefined) return null;
        cidr.push(s);
        const p = parsePrefix(s);
        if (!p) c.warn(x, `${npath}.cidr[${k}]`, `${prefixProblem(s)}; it is shown as written`);
        return p;
      })
      .filter((p): p is NonNullable<typeof p> => !!p);
    const members: RelEndpoint[] = [];
    memberNodes.slice(0, L.maxMembers).forEach((x, k) => {
      const ep = endpoint(x, `${npath}.members[${k}]`, true);
      if (!ep) return;
      members.push(ep);
      // relevant relationship check: member addresses inside the network's prefixes
      const inf = ep.iface ? interfaces.get(ifaceKey(ep.device, ep.iface)) : undefined;
      const addrs = ep.address ? [ep.address] : inf ? inf.addresses : [];
      for (const a of addrs) {
        const pa = parsePrefix(a, false);
        if (!pa) continue;
        const sameFamily = prefixes.filter((p) => p.version === pa.version);
        if (sameFamily.length && !sameFamily.some((p) => prefixContains(p, pa))) {
          c.warn(x, `${npath}.members[${k}]`, `address ${a} of ${ep.device}${ep.iface ? ':' + ep.iface : ''} is outside ${cidr.join(', ')}`);
        }
      }
    });
    networks.push({
      id,
      label: r.field(m, 'label', npath, L.maxLabel) || id,
      kind: (r.field(m, 'kind', npath, 40) || '').toLowerCase(),
      cidr,
      vlan: r.field(m, 'vlan', npath, 100),
      vrf: r.field(m, 'vrf', npath, 100),
      members,
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
      .map((x, k) => endpoint(x, `${rpath}.endpoints[${k}]`, true))
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
    const network = r.field(m, 'network', rpath, 200);
    if (network !== undefined && !networkMap.has(network)) {
      c.error(get(m, 'network') as YNode, rpath + '.network', `unknown network "${network}"${suggest(network, networkMap.keys())}`);
    }
    const rel: Relation = {
      id,
      protocol: proto,
      category: category || def.category,
      label: r.field(m, 'label', rpath, L.maxLabel),
      endpoints,
      over,
      network: network !== undefined && networkMap.has(network) ? network : undefined,
      directed: r.bool(get(m, 'directed'), rpath + '.directed') || false,
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
  return {
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
}

/** A device's type: one of the format's device types, or none. Anything else is an error. */
function deviceType(r: Reader, m: YMap, dpath: string, c: Ctx): string {
  const t = r.field(m, 'type', dpath, 40);
  if (t === undefined) return NO_DEVICE_TYPE;
  if (isDeviceType(t)) return t;
  c.error(get(m, 'type') as YNode, dpath + '.type', `unknown device type "${t}"${suggest(t, DEVICE_TYPE_IDS, 20)}`);
  return NO_DEVICE_TYPE;
}
