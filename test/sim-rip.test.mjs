// RIP as a distance vector (analysis/sim/rip.ts): each router's table comes
// from its neighbours' Responses only — prefixes with metrics, poisoned
// reverse, a timeout per route, withdrawal with metric 16 and triggered
// updates — and the routes the router installs are that table's.
// Asserted by the Responses' entries as sent, the routes installed and
// their metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

/** lan1 — r1 — r2 — r3 — lan3, RIP on both links; r3's lan3 interface faces a host. */
const CHAIN = (x = {}) => `netatlas: 1
title: rip
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: r1, type: router, interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: g1, ip: 10.0.12.1/30}], protocols: {rip: {}}}
  - {id: r2, type: router, interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.0.23.1/30}], protocols: {rip: {}}}
  - {id: r3, type: router, interfaces: [{id: g0, ip: 10.0.23.2/30}, {id: lan, ip: 10.3.0.1/24}], protocols: {rip: {${x.r3 || ''}}}${x.r3sim || ''}}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.3.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.3.0.1}]}
links:
  - {id: a, a: "h1:eth0", b: "r1:lan"}
  - {id: b, a: "r1:g1", b: "r2:g0"}
  - {id: c, a: "r2:g1", b: "r3:g0"}
  - {id: d, a: "r3:lan", b: "h3:eth0"}
relations:
  - {id: rip12, protocol: rip, endpoints: ["r1:g1", "r2:g0"]}
  - {id: rip23, protocol: rip, endpoints: ["r2:g1", "r3:g0"]${x.rel23 || ''}}
`;

const sim = (text) => new S.Simulation(model(text));
/** the RIP entries a device sent (each Response as sent: its prefix → metric) */
const responses = (s, dev, t0 = 0) =>
  s.events()
    .filter((e) => e.kind === 'message' && e.protocol === 'rip' && e.device === dev && e.what === 'Response' && e.t >= t0)
    .map((e) => ({ t: e.t, peer: e.peer, detail: e.detail }));
const route = (s, dev, ip) => s.routeLookup(dev, ip);
const prefixOf = (r) => `${[...r.net.bytes].join('.')}/${r.net.prefix}`;

test('RIP: the routes come from the Responses, hop by hop — a router advertises its own networks with metric 1: 2 one router away, 3 two away; installed with them', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const r1 = s.protocols.rip.routes('r1', '');
  const lan3 = r1.find((r) => prefixOf(r) === '10.3.0.0/24');
  assert.ok(lan3, JSON.stringify(r1.map(prefixOf)));
  assert.deepEqual([lan3.metric, lan3.peer, lan3.relation], [3, 'r2', 'rip12']);
  assert.equal(r1.find((r) => prefixOf(r) === '10.0.23.0/30').metric, 2);
  // on the wire: r3 advertises its own lan with metric 1 (never 0: RFC 2453 metrics are 1 to 16)
  const own = responses(s, 'r3').find((x) => /periodic update/.test(x.detail));
  assert.match(own.detail, /10\.3\.0\.0\/24 metric 1(,|$)/, own.detail);
  assert.ok(s.events().filter((e) => e.kind === 'message' && e.protocol === 'rip' && e.what === 'Response').every((e) => !/ metric 0\b/.test(e.detail)));
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'forward');
  assert.match(route(s, 'r1', '10.3.0.10').text, /via 10\.0\.12\.2 out g1/);
  // end to end
  const t = s.sendTest({ from: 'h1', to: 'h3', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
});

test('RIP: split horizon with poisoned reverse — what came in by an interface goes back out of it with metric 16', () => {
  const s = sim(CHAIN());
  s.runTo(70000);
  // r2's periodic Response towards r1 (out of g0): r1's own lan with 16; r3's lan with its metric
  const toR1 = responses(s, 'r2', 30000).find((x) => x.peer === 'r1' && /periodic update/.test(x.detail));
  assert.ok(toR1, 'a periodic Response out of g0');
  assert.match(toR1.detail, /10\.1\.0\.0\/24 metric 16/, toR1.detail);
  assert.match(toR1.detail, /10\.3\.0\.0\/24 metric 2/);
  const toR3 = responses(s, 'r2', 30000).find((x) => x.peer === 'r3' && /periodic update/.test(x.detail));
  assert.match(toR3.detail, /10\.3\.0\.0\/24 metric 16/);
  assert.match(toR3.detail, /10\.1\.0\.0\/24 metric 2/);
});

test('RIP: a network that goes away is withdrawn with metric 16 by a triggered update, hop by hop, long before any timeout', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const t0 = s.now;
  s.shut('r3', 'lan');
  s.runTo(t0 + 15000);
  const trig = responses(s, 'r3', t0).find((x) => /triggered update/.test(x.detail));
  assert.ok(trig && /10\.3\.0\.0\/24 metric 16/.test(trig.detail), JSON.stringify(responses(s, 'r3', t0)));
  assert.ok(trig.t - t0 >= 1000 && trig.t - t0 <= 5100, `after 1 to 5 s (${trig.t - t0} ms)`);
  // r2 passes the withdrawal on; r1 no longer has a route
  assert.ok(responses(s, 'r2', t0).some((x) => /triggered update/.test(x.detail) && /10\.3\.0\.0\/24 metric 16/.test(x.detail)));
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'none', route(s, 'r1', '10.3.0.10').text);
  assert.ok(s.now - t0 < 180000);
});

test('RIP: a router that goes silent — its routes time out after 180 s (no withdrawal ever arrives), then withdrawn on', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const t0 = s.now;
  // r3's Responses are lost on the cable (its link stays up): nothing tells r2; r2's route to lan3 stays until its timeout
  s.engine.impair = (link, f) => (link === 'c' && f.msg.protocol === 'rip' && f.msg.data && f.msg.data.from === 'r3' ? { lose: true } : null);
  s.runTo(t0 + 150000);
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'forward', 'still there before the timeout (stale)');
  s.runTo(t0 + 200000);
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'none');
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'none');
  const to = s.events().find((e) => e.kind === 'route' && e.device === 'r2' && e.what === 'timed out' && /10\.3\.0\.0\/24/.test(e.detail));
  assert.ok(to, 'timed out');
  assert.ok(to.t - t0 >= 150000 && to.t - t0 <= 181000, String(to.t - t0));
  // (meanwhile r2 advertised it with 16 to r1, which withdrew it too)
  assert.ok(responses(s, 'r2', to.t).some((x) => x.peer === 'r1' && /10\.3\.0\.0\/24 metric 16/.test(x.detail)));
  // garbage collection: advertised with 16, then gone from the table
  s.runTo(t0 + 200000 + 130000);
  assert.ok(!s.protocols.rip.routes('r2', '').some((r) => prefixOf(r) === '10.3.0.0/24'));
});

test('RIP: an export filter keeps a prefix out of the Responses; the neighbour never learns it (no topology flooding behind it)', () => {
  const s = sim(CHAIN({ r3: 'export: [{prefix: 10.3.0.0/24, action: deny}, {action: permit}]' }));
  s.runTo(60000);
  assert.ok(!responses(s, 'r3').some((x) => /10\.3\.0\.0\/24/.test(x.detail)));
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'none');
  assert.equal(route(s, 'r2', '10.0.23.1').kind, 'local');
});

test('RIP: an interface going down invalidates what was learned through it at once (metric 16), and the withdrawal goes on', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const t0 = s.now;
  s.powerOff('r3');
  s.runTo(t0 + 8000);
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'none', 'its cable is down: no waiting for the timeout');
  assert.ok(responses(s, 'r2', t0).some((x) => x.peer === 'r1' && /triggered update/.test(x.detail) && /10\.3\.0\.0\/24 metric 16/.test(x.detail)));
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'none');
});

/** a chain of n routers r1 … rn, RIP between neighbours; rn has a lan */
const LONG = (n) => {
  const devs = [];
  const links = [];
  const rels = [];
  for (let i = 1; i <= n; i++) {
    const ifs = [];
    if (i > 1) ifs.push(`{id: a, ip: 10.${i - 1}.0.2/30}`);
    if (i < n) ifs.push(`{id: b, ip: 10.${i}.0.1/30}`);
    if (i === n) ifs.push('{id: lan, ip: 172.16.0.1/24}');
    devs.push(`  - {id: r${i}, type: router, interfaces: [${ifs.join(', ')}], protocols: {rip: {}}}`);
    if (i < n) {
      links.push(`  - {id: l${i}, a: "r${i}:b", b: "r${i + 1}:a"}`);
      rels.push(`  - {id: rip${i}, protocol: rip, endpoints: ["r${i}:b", "r${i + 1}:a"]}`);
    }
  }
  return `netatlas: 1\ntitle: long rip chain\ndevices:\n${devs.join('\n')}\nlinks:\n${links.join('\n')}\nrelations:\n${rels.join('\n')}\n`;
};

test('RIP: the farthest reachable network is 15 — a lan 14 routers away has metric 15, one 15 routers away is unreachable (16)', () => {
  const s = sim(LONG(16));
  s.runTo(400000);
  const at = (dev) => s.protocols.rip.routes(dev, '').find((r) => prefixOf(r) === '172.16.0.0/24');
  // r2 is 14 routers from r16: 1 (r16's own) + 14 = 15
  assert.equal(at('r2') && at('r2').metric, 15);
  assert.equal(route(s, 'r2', '172.16.0.1').kind, 'forward');
  // r1, one more: 16 — not a route
  assert.equal(at('r1'), undefined);
  assert.equal(route(s, 'r1', '172.16.0.1').kind, 'none');
});

test('RIP: entries with a malformed metric (0, 17, not a whole number) are ignored and said so; the valid ones in the same Response are taken', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const P = s.protocols;
  const sess = Array.from(P.sessions.values()).find((x) => x.dev === 'r1' && x.protocol === 'rip');
  const n = s.events().length;
  const origin = { device: 'r2', how: 'connected', history: [] };
  P.rip.response(sess, [
    { prefix: '192.0.2.0/24', metric: 0, origin },
    { prefix: '198.51.100.0/24', metric: 17, origin },
    { prefix: '203.0.113.0/24', metric: 1.5, origin },
    { prefix: '10.99.0.0/16', metric: 3, origin },
  ]);
  const got = P.rip.routes('r1', '').map(prefixOf);
  assert.ok(got.indexOf('10.99.0.0/16') >= 0);
  for (const bad of ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24']) assert.ok(got.indexOf(bad) < 0, bad);
  const note = s.events().slice(n).find((e) => e.kind === 'drop' && e.protocol === 'rip');
  assert.match(note.detail, /ignores 3 entries of r2's RIP Response: 192\.0\.2\.0\/24 metric 0, 198\.51\.100\.0\/24 metric 17, 203\.0\.113\.0\/24 metric 1\.5 \(a metric must be 1 to 16\)/);
  assert.equal(P.rip.routes('r1', '').find((r) => prefixOf(r) === '10.99.0.0/16').metric, 4);
});

test('RIP: power-off and a quick reboot — the old table’s timers (timeouts, garbage collection, triggered updates) never touch the new one', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  assert.ok(s.protocols.rip.routes('r2', '').length > 0);
  const t0 = s.now;
  assert.ok(s.powerOff('r2'));
  s.runTo(t0 + 1000);
  assert.ok(s.powerOn('r2'));
  // past every timeout and garbage collection the old table had scheduled
  s.runTo(t0 + 400000);
  const late = s.events().filter((e) => e.t > t0 && e.device === 'r2' && e.protocol === 'rip' && e.kind === 'route' && /timed out/.test(e.detail));
  assert.deepEqual(late.map((e) => e.detail), [], 'r2 relearned everything; its neighbours never went silent');
  // the new table is whole: r2 still routes both lans, learned anew after the reboot
  assert.equal(route(s, 'r2', '10.1.0.10').kind, 'forward');
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'forward');
});

test('RIP: a router asks for its neighbours’ tables when it comes up — at its first boot, after a power cycle (once its interface is up, not while it is still down), and when an interface comes up again (RFC 2453 §3.9.1)', () => {
  const s = sim(CHAIN());
  const requests = (dev, t0) => s.events().filter((e) => e.kind === 'message' && e.protocol === 'rip' && e.device === dev && e.what === 'Request' && e.t >= t0);
  s.runTo(30000);
  assert.ok(requests('r2', 0).length >= 1, 'at its first boot');
  s.powerOff('r2');
  s.runTo(31000);
  const t0 = s.now;
  s.powerOn('r2');
  s.runTo(t0 + 120000);
  const after = requests('r2', t0);
  assert.equal(after.length, 2, `once per interface after the reboot: ${after.map((e) => Math.round(e.t)).join()}`);
  assert.ok(!s.events().some((e) => e.t >= t0 && e.kind === 'drop' && e.device === 'r2' && e.what === 'Request'), 'never into an interface still down');
  // the neighbours answer it
  assert.ok(s.events().some((e) => e.t >= after[0].t && e.kind === 'message' && e.protocol === 'rip' && e.device === 'r1' && e.what === 'Response' && /answer to the request/.test(e.detail)));
  // an interface shut and brought up again: one more Request from that interface
  const t1 = s.now;
  s.shut('r2', 'g1');
  s.runTo(t1 + 1000);
  s.noShut('r2', 'g1');
  s.runTo(t1 + 10000);
  const again = requests('r2', t1);
  assert.equal(again.length, 1);
  assert.match(again[0].detail, /on g1/);
});

// ------------------------------------------------------------------ RIPng: its own port, link-local sources, hop count 255

/** The chain over IPv6 only: lan1 — r1 — r2 — r3 — lan3, RIPng on both links. */
const CHAIN6 = `netatlas: 1
title: ripng
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: "2001:db8:1::10/64"}], routes: [{prefix: "::/0", via: "2001:db8:1::1"}]}
  - {id: r1, type: router, interfaces: [{id: lan, ip: "2001:db8:1::1/64"}, {id: g1, ip: "2001:db8:12::1/64"}], protocols: {rip: {}}}
  - {id: r2, type: router, interfaces: [{id: g0, ip: "2001:db8:12::2/64"}, {id: g1, ip: "2001:db8:23::1/64"}], protocols: {rip: {}}}
  - {id: r3, type: router, interfaces: [{id: g0, ip: "2001:db8:23::2/64"}, {id: lan, ip: "2001:db8:3::1/64"}], protocols: {rip: {}}}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: "2001:db8:3::10/64"}], routes: [{prefix: "::/0", via: "2001:db8:3::1"}]}
links:
  - {id: a, a: "h1:eth0", b: "r1:lan"}
  - {id: b, a: "r1:g1", b: "r2:g0"}
  - {id: c, a: "r2:g1", b: "r3:g0"}
  - {id: d, a: "r3:lan", b: "h3:eth0"}
relations:
  - {id: rip12, protocol: rip, endpoints: ["r1:g1", "r2:g0"]}
  - {id: rip23, protocol: rip, endpoints: ["r2:g1", "r3:g0"]}
`;
/** the RIP messages sent, with their headers as sent */
const ripSent = (s, t0 = 0) => s.events().filter((e) => e.kind === 'message' && e.protocol === 'rip' && e.t >= t0 && e.hdr && e.hdr.l4);
const isLL = (a) => /^fe[89ab][0-9a-f]:/i.test(a);
const hdrText = (e) => `${e.device} ${e.what} ${e.hdr.l3[0].src} → ${e.hdr.l3[0].dst} UDP ${e.hdr.l4.sport}>${e.hdr.l4.dport} hop ${e.hdr.l3[0].ttl}`;

test('RIPng (RFC 2080) on an IPv6-only chain — each message class as sent: Requests from and to UDP 521, to ff02::9; periodic and triggered Responses to ff02::9 from the link-local address with hop count 255; the answer to a Request unicast from the link-local address to the requester; the routes learned and used end to end', () => {
  const s = sim(CHAIN6);
  s.runTo(70000);
  const all = ripSent(s);
  assert.ok(all.length > 6);
  assert.ok(all.every((e) => e.hdr.l4.proto === 'udp' && e.hdr.l4.sport === 521 && e.hdr.l4.dport === 521), all.filter((e) => e.hdr.l4.sport !== 521 || e.hdr.l4.dport !== 521).map(hdrText).join(' | '));
  const req = all.filter((e) => e.what === 'Request');
  assert.ok(req.length >= 4 && req.every((e) => e.hdr.l3[0].dst === 'ff02::9'), req.map(hdrText).join(' | '));
  const periodic = all.filter((e) => e.what === 'Response' && /periodic update/.test(e.detail));
  assert.ok(periodic.length >= 4, `${periodic.length} periodic Responses`);
  assert.ok(periodic.every((e) => e.hdr.l3[0].dst === 'ff02::9' && isLL(e.hdr.l3[0].src) && e.hdr.l3[0].ttl === 255), periodic.map(hdrText).join(' | '));
  // routes, and traffic over them
  const r1 = s.routeLookup('r1', '2001:db8:3::10');
  assert.equal(r1.kind, 'forward', r1.text);
  const t = s.sendTest({ from: 'h1', to: 'h3', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
  // a triggered Response: r3's lan goes down
  const t0 = s.now;
  s.fail('link:d');
  s.runTo(t0 + 8000);
  const trig = ripSent(s, t0).filter((e) => e.what === 'Response' && /triggered update/.test(e.detail));
  assert.ok(trig.length >= 1, 'a triggered Response');
  assert.ok(trig.every((e) => e.hdr.l3[0].dst === 'ff02::9' && isLL(e.hdr.l3[0].src) && e.hdr.l3[0].ttl === 255 && e.hdr.l4.sport === 521), trig.map(hdrText).join(' | '));
  // the answer to a Request: r2's g1 comes back up and asks; r3 answers it unicast, from its link-local address, to r2's request source
  s.restore('link:d');
  const t1 = s.now;
  s.fail('link:c');
  s.runTo(t1 + 2000);
  s.restore('link:c');
  s.runTo(t1 + 6000);
  const ask = ripSent(s, t1).find((e) => e.what === 'Request' && e.device === 'r2' && /g1/.test(e.detail));
  assert.ok(ask, 'r2 asks again on g1');
  const answer = ripSent(s, t1).find((e) => e.what === 'Response' && e.device === 'r3' && /answer to the request/.test(e.detail));
  assert.ok(answer, 'r3 answers');
  assert.deepEqual([answer.hdr.l3[0].dst, isLL(answer.hdr.l3[0].src), answer.hdr.l4.sport, answer.hdr.l4.dport], [ask.hdr.l3[0].src, true, 521, 521], hdrText(answer));
  assert.ok(!s.events().some((e) => e.kind === 'drop' && e.protocol === 'rip' && /ignores/.test(e.detail)), 'every Response taken');
});

test('RIPng input checks (RFC 2080 §2.4.2): a Response to the group with a hop count other than 255, or not from a link-local address, is ignored — the neighbour’s routes are not learned from it', () => {
  for (const bad of ['hop', 'src']) {
    const s = sim(CHAIN6);
    // r2's Responses as an off-link sender would send them: a hop count of 254, or a global source
    s.engine.impair = (link, f) => {
      if (f.msg.protocol !== 'rip' || f.msg.type !== 'Response' || (f.msg.data || {}).from !== 'r2' || !f.ip) return null;
      if (bad === 'hop') f.ip.ttl = 254;
      else f.ip.src = s.engine.net.devices.get('r2').l3.get('g0').addrs.find((x) => x.addr.version === 6).addr;
      return null;
    };
    s.runTo(70000);
    const why = bad === 'hop' ? /hop count 254, not 255/ : /is not link-local/;
    assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'r1' && why.test(e.detail)), bad);
    assert.equal(s.routeLookup('r1', '2001:db8:3::10').kind, 'none', `${bad}: nothing learned from r2`);
  }
});
