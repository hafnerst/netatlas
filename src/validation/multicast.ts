/**
 * An interface's `multicast:` block: the groups the device joins there and
 * the streams it sends from there (the protocol simulation). Every group
 * is checked: a multicast address (224.0.0.0/4, ff00::/8), not link-local
 * (224.0.0.0/24, ff02::/16: those are never joined or routed); a
 * source-specific group (232.0.0.0/8, ff3x::/32) needs its sources, and a
 * device whose IGMP version is v2 (MLDv1) cannot join one. A stream's port,
 * interval and size are checked for their ranges.
 */
import { paramDef, parseValue } from '../analysis/sim/params';
import { isLinkLocalGroup, isMulticastIp, isSsmGroup } from '../analysis/sim/mac';
import { IpAddr, parseAddress } from '../model/ip';
import { McJoin, McStream, MulticastConfig } from '../model/types';
import { SCHEMA } from '../yaml/schema';
import { YNode } from '../yaml/parse';
import { Ctx, Reader, get, isNull } from './reader';

/** The default stream: RTP's port, a datagram a second, seven MPEG-TS packets (7 × 188 bytes). */
export const STREAM_DEFAULTS = { port: 5004, interval: 1000, size: 1316 };

function groupProblem(a: IpAddr | null, text: string): string | null {
  if (!a) return `"${text}" is not an IP address`;
  if (!isMulticastIp(a)) return `${text} is not a multicast group (224.0.0.0/4, ff00::/8)`;
  if (isLinkLocalGroup(a)) return `${text} is a link-local group (${a.version === 4 ? '224.0.0.0/24' : 'ff02::/16'}): it is never joined or routed`;
  return null;
}

/** An interface's `multicast:` block (undefined: none). `igmpV2`: the device runs IGMPv2 / MLDv1 (no source lists). */
export function readMulticast(r: Reader, c: Ctx, n: YNode | undefined, path: string, iid: string, hasAddress: boolean, igmpV2: boolean): MulticastConfig | undefined {
  if (isNull(n)) return undefined;
  const m = r.map(n, path);
  if (!m) return undefined;
  r.keys(m, SCHEMA.multicast, path);
  const out: MulticastConfig = { joins: [], streams: [] };
  if (!hasAddress) c.error(m, path, `interface "${iid}" has no address: it can neither join a group nor send a stream (write its address under "ip:")`);
  const seen = new Set<string>();
  r.list(get(m, 'join'), path + '.join', true).forEach((jn, i) => {
    const jp = `${path}.join[${i}]`;
    let groupText: string | undefined;
    let srcNode: YNode | undefined;
    let gNode: YNode = jn;
    if (jn.kind === 'map') {
      r.keys(jn, SCHEMA.mcJoin, jp);
      groupText = r.reqStr(jn, 'group', jp, 64);
      srcNode = get(jn, 'sources');
      gNode = (get(jn, 'group') as YNode) || jn;
    } else groupText = r.str(jn, jp, 64);
    if (groupText === undefined) return;
    const g = parseAddress(groupText.trim());
    const why = groupProblem(g, groupText);
    if (why) {
      c.error(gNode, jp, why);
      return;
    }
    const group = g as IpAddr;
    const sources: string[] = [];
    r.list(srcNode, jp + '.sources', true).forEach((sn, k) => {
      const t = r.str(sn, `${jp}.sources[${k}]`, 64);
      if (t === undefined) return;
      const s = parseAddress(t.trim());
      if (!s || isMulticastIp(s) || s.version !== group.version) c.error(sn, `${jp}.sources[${k}]`, `"${t}" is not a source address for ${groupText} (a unicast IPv${group.version} address)`);
      else if (sources.indexOf(t.trim()) < 0) sources.push(t.trim());
    });
    if (isSsmGroup(group) && !sources.length) {
      c.error(gNode, jp, `${groupText} is a source-specific group (${group.version === 4 ? '232.0.0.0/8' : 'ff3x::/32'}): write its sources, e.g. {group: ${groupText}, sources: [${group.version === 4 ? '10.0.0.10' : '2001:db8::10'}]}`);
      return;
    }
    if (sources.length && igmpV2) {
      c.error(gNode, jp, `joining ${groupText} with a source list needs IGMPv3 (MLDv2): the interface's (or its device's) simulation sets igmp_version: v2`);
      return;
    }
    if (seen.has(groupText.trim())) {
      c.error(gNode, jp, `${groupText} is joined twice on "${iid}"`);
      return;
    }
    seen.add(groupText.trim());
    out.joins.push({ group: groupText.trim(), sources, line: jn.line } as McJoin);
  });
  r.list(get(m, 'streams'), path + '.streams').forEach((sn, i) => {
    const sp = `${path}.streams[${i}]`;
    const sm = r.map(sn, sp);
    if (!sm) return;
    r.keys(sm, SCHEMA.mcStream, sp);
    const groupText = r.reqStr(sm, 'group', sp, 64);
    if (groupText === undefined) return;
    const g = parseAddress(groupText.trim());
    const why = groupProblem(g, groupText);
    if (why) {
      c.error(get(sm, 'group') as YNode, sp + '.group', why);
      return;
    }
    const port = isNull(get(sm, 'port')) ? STREAM_DEFAULTS.port : r.int(get(sm, 'port'), sp + '.port', 1, 65535, 'UDP port');
    const size = isNull(get(sm, 'size')) ? STREAM_DEFAULTS.size : r.int(get(sm, 'size'), sp + '.size', 1, 65000, 'datagram size');
    let interval: number | undefined = STREAM_DEFAULTS.interval;
    const ivn = get(sm, 'interval');
    if (!isNull(ivn)) {
      const p = parseValue(paramDef('test-interval'), (ivn as YNode).kind === 'scalar' ? (ivn as { value: unknown }).value : undefined);
      if ('error' in p) {
        c.error(ivn as YNode, sp + '.interval', `the interval ${p.error} (a bare number is in seconds)`);
        interval = undefined;
      } else interval = Number(p.value);
    }
    if (port === undefined || size === undefined || interval === undefined) return;
    out.streams.push({ group: groupText.trim(), port, interval, size, line: sm.line } as McStream);
  });
  return out;
}
