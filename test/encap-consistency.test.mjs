// One definition of encapsulation sizes (src/analysis/encap.ts): the static path MTU, the tunnel-MTU check and the
// simulation's packet lengths, fragmentation and PMTUD agree on it. Every expected size here is worked by hand from the
// protocol's specification, never computed with the helper under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const E = load('analysis/encap.js');
const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const MT = load('analysis/mtu.js');

// An inner IPv4 packet of 1000 bytes in each format, the outer header IPv4 (20) unless said:
//   GRE        20 + 4                                              = 1024   (RFC 2784, no key/checksum/sequence)
//   IP-in-IP   20                                                  = 1020   (RFC 2003)
//   ESP        20 + 4 SPI + 4 seq + 16 IV + 1008 (1000 + 2 → 16) + 12 ICV = 1064   (RFC 4303 §2, AES-CBC, HMAC-SHA1-96)
//   WireGuard  20 + 8 UDP + 16 header + 1000 + 16 tag              = 1060   (padding not counted, see encap.ts)
//   VXLAN      20 + 8 UDP + 8 VXLAN + 14 inner Ethernet + 1000     = 1050   (RFC 7348 §5)
//   Geneve     20 + 8 UDP + 8 Geneve + 14 inner Ethernet + 1000    = 1050   (RFC 8926 §3, no options)
//   L2TPv3     20 + 8 UDP + 12                                     = 1040   (RFC 3931 §4.1.2.2, sublayer, no cookie)
//   GTP-U      20 + 8 UDP + 8                                      = 1036
//   OpenVPN    20 + 8 UDP + 24                                     = 1052
//   GRE, IPv6 outer: 40 + 4                                        = 1044
const REF = { gre: 1024, ipip: 1020, ipsec: 1064, wireguard: 1060, vxlan: 1050, geneve: 1050, l2tp: 1040, gtp: 1036, openvpn: 1052 };

test('encapsulation: each format’s outer length matches the hand-worked reference; IPv6 outer headers add 20 more', () => {
  for (const [p, n] of Object.entries(REF)) assert.equal(E.outerLength(E.ENCAPS[p], 1000, 4), n, p);
  assert.equal(E.outerLength(E.ENCAPS.gre, 1000, 6), 1044);
  // ESP's padding: 1002 + 2 = 1004 → 1008 as well; 1006 + 2 = 1008 exactly; 1007 + 2 = 1009 → 1024
  assert.equal(E.outerLength(E.ENCAPS.ipsec, 1002, 4), 1064);
  assert.equal(E.outerLength(E.ENCAPS.ipsec, 1006, 4), 1064);
  assert.equal(E.outerLength(E.ENCAPS.ipsec, 1007, 4), 1080);
});

test('encapsulation: the largest inner packet is the exact inverse at every limit (no off-by-one at a padding boundary)', () => {
  for (const d of Object.values(E.ENCAPS)) {
    for (const v of [4, 6]) {
      for (let lim = 1280; lim <= 1600; lim++) {
        const n = E.maxInner(d, lim, v);
        assert.ok(E.outerLength(d, n, v) <= lim, `${d.protocol} v${v} ${lim}: ${n} fits`);
        assert.ok(E.outerLength(d, n + 1, v) > lim, `${d.protocol} v${v} ${lim}: ${n + 1} does not`);
      }
    }
  }
  // hand-worked: ESP within 1500 takes at most a 1438-byte inner packet (1438 + 2 = 1440 = 90 × 16; 20 + 24 + 1440 + 12 = 1496)
  assert.equal(E.maxInner(E.ENCAPS.ipsec, 1500, 4), 1438);
  // GRE over ESP within 1500: 1438 − 24 = 1414
  assert.equal(E.maxInnerStack([{ def: E.ENCAPS.gre, outer: 4 }, { def: E.ENCAPS.ipsec, outer: 4 }], 1500), 1414);
});

// ha — a ==(GRE tun0 over wan)== b — hb, the underlay through t; t's link to b has a smaller MTU when `narrow` is set
const GRE = ({ tunMtu = '', narrow = '' } = {}) => `netatlas: 1
title: GRE sizes
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 198.51.100.2${tunMtu}}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}, {prefix: 198.51.100.0/30, via: 192.0.2.2}]
  - id: t
    type: router
    interfaces: [{id: x, ip: 192.0.2.2/30, mtu: 1500}, {id: y, ip: 198.51.100.1/30, mtu: ${narrow || 1500}}]
  - id: b
    type: router
    interfaces: [{id: wan, ip: 198.51.100.2/30, mtu: ${narrow || 1500}}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1${tunMtu}}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}, {prefix: 192.0.2.0/30, via: 198.51.100.1}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: ha:eth0, b: a:lan}
  - {id: l2, a: a:wan, b: t:x}
  - {id: l3, a: t:y, b: b:wan}
  - {id: l4, a: b:lan, b: hb:eth0}
relations:
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"]}
`;

const ping = (s, size, df) => {
  const t = s.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp', size, df });
  s.runTo(s.now + 8000);
  return t;
};

test('GRE at run time: the outer packet is the inner + 24, the inspector says so, and the boundary is the static path MTU', () => {
  const m = model(GRE({ tunMtu: ', mtu: 1476' }));
  const st = MT.pathMtu(m, C.checkCommunication(m, { from: 'ha', to: 'hb' }));
  assert.equal(st.mtu, 1476, st.text);
  assert.equal(st.verdict, 'satisfied', st.text);
  const s = new S.Simulation(m);
  s.runTo(70000);
  // 1476 − 20 IP − 8 ICMP = 1448 bytes of data: fits with DF; one more does not
  const t0 = s.now;
  const fits = ping(s, 1448, true);
  assert.equal(fits.ok, true, fits.result);
  const hdr = s.flights(s.now, 'physical', t0).find((f) => f.test === fits.id && f.hdr && f.hdr.l3.length === 2);
  assert.ok(hdr, 'the encapsulated echo request is on the underlay with its headers (the packet inspector)');
  assert.deepEqual(hdr.hdr.l3.map((h) => h.len), [1500, 1476], 'outer 20 + 4 GRE + inner 1476');
  assert.equal(hdr.hdr.l2.bytes, 1518, 'the frame: 14 Ethernet + 4 FCS + 1500');
  assert.match(hdr.hdr.l3[0].encap, /GRE: 20 IPv4 \+ 4 GRE: 24 bytes around the inner 1476/);
  const big = ping(s, 1449, true);
  assert.equal(big.ok, false);
  assert.match(big.result, /path MTU 1476/);
});

test('GRE at run time: an IPv4 packet without DF is fragmented before encapsulation, each fragment once (no fragments of the whole again)', () => {
  const m = model(GRE({ tunMtu: ', mtu: 1476' }));
  const s = new S.Simulation(m);
  s.runTo(70000);
  // 1460 bytes of data: a 1488-byte packet, within ha's 1500 but not the tunnel's 1476
  const n0 = s.events().length;
  const t = ping(s, 1460, false);
  assert.equal(t.ok, true, t.result);
  const ev = s.events().slice(n0);
  const frag = ev.filter((e) => e.device === 'a' && e.what === 'fragmented');
  assert.equal(frag.length, 1, 'fragmented once, at the tunnel');
  // 1468 bytes after the header: 1456 in the first fragment (a multiple of 8 within 1476 − 20), 12 in the second
  assert.match(frag[0].detail, /into 2 for tunnel tun0, 1476 bytes .*: 1476 \+ 32 bytes/);
  assert.equal(ev.filter((e) => e.what === 'fragmented' && e.device !== 'a' && e.device !== 'b').length, 0, 'no router fragments the outer packets again');
  assert.equal(ev.filter((e) => e.device === 'hb' && e.what === 'reassembled').length, 1, 'the inner packet arrives once, reassembled');
});

test('PMTUD through a tunnel: a narrower underlay is learned by the tunnel head, which then tells the inner sender what fits', () => {
  // the underlay narrows to 1400 between t and b; the tunnel MTU is not written, so the head derives it (1476) at first
  const m = model(GRE({ narrow: '1400' }));
  const st = MT.pathMtu(m, C.checkCommunication(m, { from: 'ha', to: 'hb' }));
  // static: the underlay's 1400 less 24 = 1376, an upper bound (the tunnel interface has no MTU written)
  assert.equal(st.mtu, 1376, st.text);
  const s = new S.Simulation(m);
  s.runTo(70000);
  // 1st try: 1376 + 1 inner bytes with DF: the outer packet (1401) is too big for t:y; t tells a, which learns 1400
  const first = ping(s, 1349, true);
  assert.equal(first.ok, false);
  assert.ok(s.events().some((e) => e.device === 'a' && e.kind === 'table' && /path MTU to 198\.51\.100\.2 is 1400 bytes/.test(e.detail)), 'the head learned the underlay path MTU');
  // 2nd try: the head refuses it with Fragmentation Needed for 1376, and ha learns that
  const second = ping(s, 1349, true);
  assert.equal(second.ok, false);
  assert.match(second.result, /path MTU 1376/);
  // what fits the static limit is delivered
  const ok = ping(s, 1348, true);
  assert.equal(ok.ok, true, ok.result);
});

test('the tunnel-MTU check, the MTU suggestion and the static path MTU use the same figure', () => {
  const m = model(GRE({ tunMtu: ', mtu: 1480' }));
  const CH = load('analysis/checks.js');
  const f = CH.runChecks ? CH.runChecks(m).filter((x) => x.check === 'tunnel-mtu') : [];
  if (CH.runChecks) assert.ok(f.some((x) => /largest MTU that fits is 1476/.test(x.message)), JSON.stringify(f.map((x) => x.message)));
  const H = load('analysis/helpers.js');
  assert.equal(H.mtuSuggestions(m, m.index.interfaces.get('a:tun0'))[0].value, '1476');
});
