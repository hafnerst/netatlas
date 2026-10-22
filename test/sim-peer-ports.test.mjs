// The UDP ports and TTL of the protocols between peers (analysis/sim/protocols.ts l4Of, SimProfile.ports / ttl):
// IKEv2 from and to 500 both ways (RFC 7296 §2.11), LDP's Hellos and RIP's updates from and to their port (RFC 5036
// §2.4.1, RFC 2453 §3.9), BFD from an ephemeral port of each side to 3784 both ways with TTL 255 (RFC 5881 §4, §5);
// a protocol's Hellos to a group go to its port; a client and a server (DNS) keep the client's ephemeral port.
// Asserted by the headers as sent, and the sessions still up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const PEERS = `netatlas: 1
title: peers
devices:
  - {id: a, type: router, interfaces: [{id: wan, ip: 192.0.2.1/30}], protocols: {bgp: {asn: 1}}}
  - {id: b, type: router, interfaces: [{id: wan, ip: 192.0.2.2/30}], protocols: {bgp: {asn: 2}}}
links:
  - {id: l, a: "a:wan", b: "b:wan"}
relations:
  - {id: vpn, protocol: ipsec, endpoints: ["a:wan", "b:wan"]}
  - {id: eb, protocol: bgp, endpoints: ["a:wan", "b:wan"]}
  - {id: ld, protocol: ldp, endpoints: ["a:wan", "b:wan"]}
  - {id: bf, protocol: bfd, endpoints: ["a:wan", "b:wan"]}
`;

const sent = (s, protocol) => s.events().filter((e) => e.kind === 'message' && e.protocol === protocol && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'udp');

test('between peers: IKE 500 ↔ 500, LDP Hellos 646 ↔ 646 (to the group), BFD from each side’s own ephemeral port to 3784 with TTL 255 — the sessions up', () => {
  const s = new S.Simulation(model(PEERS));
  s.runTo(30000);
  const ike = sent(s, 'ipsec');
  assert.ok(ike.some((e) => e.device === 'a') && ike.some((e) => e.device === 'b'));
  assert.ok(ike.every((e) => e.hdr.l4.sport === 500 && e.hdr.l4.dport === 500), ike.map((e) => `${e.device} ${e.hdr.l4.sport}>${e.hdr.l4.dport}`).join(' '));
  const hello = sent(s, 'ldp').filter((e) => e.what === 'Hello');
  assert.ok(hello.length >= 4 && hello.every((e) => e.hdr.l4.sport === 646 && e.hdr.l4.dport === 646 && e.hdr.l3[0].dst === '224.0.0.2'));
  const bfd = sent(s, 'bfd');
  for (const d of ['a', 'b']) {
    const mine = bfd.filter((e) => e.device === d);
    assert.ok(mine.length >= 3, d);
    assert.ok(mine.every((e) => e.hdr.l4.dport === 3784 && e.hdr.l4.sport >= 49152 && e.hdr.l3[0].ttl === 255), `${d}: ${mine.map((e) => `${e.hdr.l4.sport}>${e.hdr.l4.dport} ttl ${e.hdr.l3[0].ttl}`).join(', ')}`);
    assert.equal(new Set(mine.map((e) => e.hdr.l4.sport)).size, 1, `${d}: one source port for the session`);
  }
  for (const p of ['ipsec', 'ldp', 'bfd']) for (const d of ['a', 'b']) assert.ok(s.sessions(d, p).every((x) => x.up), `${p} at ${d}: ${s.sessions(d, p).map((x) => x.state)}`);
});

test('RIP: Requests and Responses from 520 to 520 (RFC 2453 §3.9), the routes learned', () => {
  const R = (n, ifs) => `  - {id: r${n}, type: router, interfaces: [${ifs}], logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.${n}/32}], protocols: {rip: {}}}\n`;
  const t = `netatlas: 1
title: rip
devices:
${R(1, '{id: a, ip: 10.0.12.1/30}')}${R(2, '{id: a, ip: 10.0.12.2/30}, {id: c, ip: 10.0.23.1/30}')}${R(3, '{id: c, ip: 10.0.23.2/30}')}links:
  - {id: l1, a: "r1:a", b: "r2:a"}
  - {id: l2, a: "r2:c", b: "r3:c"}
relations:
  - {id: p12, protocol: rip, endpoints: ["r1:a", "r2:a"]}
  - {id: p23, protocol: rip, endpoints: ["r2:c", "r3:c"]}
`;
  const s = new S.Simulation(model(t));
  s.runTo(60000);
  const rip = sent(s, 'rip');
  assert.ok(rip.length > 4 && rip.every((e) => e.hdr.l4.sport === 520 && e.hdr.l4.dport === 520), rip.map((e) => `${e.device} ${e.what} ${e.hdr.l4.sport}>${e.hdr.l4.dport}`).join(' | '));
  assert.equal(s.routeLookup('r1', '10.255.0.3').kind, 'forward');
});
