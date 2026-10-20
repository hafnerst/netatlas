// The session profiles keep their protocol's consequential order and
// timers (analysis/sim/proto-other.ts): HTTPS's TLS 1.3 flights — the
// client's Finished before its first request, no request taken before
// it; WireGuard's handshake sent again every 5 s, a new one after 120 s,
// keys rejected after 180 s (keepalives renew nothing). Asserted by the
// messages in order on each end and the sessions' states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const PAIR = (protocol, x = '') => `netatlas: 1
title: ${protocol}
devices:
  - {id: c, type: endpoint, interfaces: [{id: eth0, ip: 192.0.2.1/30}]}
  - {id: s, type: server, interfaces: [{id: eth0, ip: 192.0.2.2/30}]}
links:
  - {id: l, a: "c:eth0", b: "s:eth0"}
relations:
  - {id: r, protocol: ${protocol}, endpoints: [c, s]${x}}
`;
const ev = (s, f) => s.events().filter(f);

test('HTTPS: TLS 1.3 flights — ClientHello; ServerHello with the server’s Finished; the client’s Finished, then its request; the server answers after the Finished', () => {
  const s = new S.Simulation(model(PAIR('https')));
  s.runTo(30000);
  const app = (dev) => ev(s, (e) => e.kind === 'message' && e.device === dev && e.protocol === 'https' && /^TLS/.test(e.what)).map((e) => e.what);
  assert.deepEqual(app('c').slice(0, 3), ['TLS ClientHello', 'TLS Finished', 'TLS Application Data (request)']);
  assert.deepEqual(app('s').slice(0, 2), ['TLS ServerHello', 'TLS Application Data (response)']);
  // every one of them a TCP segment of the connection, with its flags
  const segs = ev(s, (e) => e.kind === 'message' && e.protocol === 'https' && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'tcp');
  assert.ok(segs.some((e) => e.hdr.label === 'HTTPS TLS Finished [P,A]'));
  assert.ok(segs.some((e) => e.hdr.label === 'HTTPS TCP [S]') && segs.some((e) => e.hdr.label === 'HTTPS TCP [S,A]'));
  // the server's answer comes after the client's Finished arrived
  const fin = ev(s, (e) => e.kind === 'message' && e.device === 'c' && e.what === 'TLS Finished')[0];
  const resp = ev(s, (e) => e.kind === 'message' && e.device === 's' && e.what === 'TLS Application Data (response)')[0];
  assert.ok(resp.t > fin.t);
  // a request before the Finished (a server that has not seen it) is not taken
  const P = s.protocols;
  const srv = Array.from(P.sessions.values()).find((x) => x.dev === 's' && x.protocol === 'https');
  srv.x.tls = 'server-flight';
  const n = s.events().length;
  P.behaviours.get('service').rx(P, srv, { protocol: 'https', type: 'TLS Application Data (request)', label: '', detail: '', data: {} }, null, null);
  assert.ok(s.events().slice(n).some((e) => e.kind === 'drop' && /takes no request before the client's Finished/.test(e.detail)));
});

test('WireGuard: an unanswered Handshake Initiation is sent again every 5 s; a new handshake after 120 s; keys rejected 180 s after the last one (keepalives renew nothing)', () => {
  const s = new S.Simulation(model(PAIR('wireguard')));
  // the first two Handshake Responses are lost
  let lost = 0;
  s.engine.impair = (link, f) => (f.msg.protocol === 'wireguard' && f.msg.type === 'Handshake Response' && lost++ < 2 ? { lose: true } : null);
  s.runTo(30000);
  const inits = ev(s, (e) => e.kind === 'message' && e.device === 'c' && e.what === 'Handshake Initiation');
  assert.ok(inits.length >= 3);
  assert.ok(Math.abs(inits[1].t - inits[0].t - 5000) < 50 && Math.abs(inits[2].t - inits[1].t - 5000) < 50, inits.map((e) => e.t).join());
  const st = (dev) => s.sessions(dev, 'wireguard')[0].state;
  assert.deepEqual([st('c'), st('s')], ['Session', 'Session']);
  const keyed = s.now;
  // a new handshake after REKEY_AFTER_TIME
  s.runTo(keyed + 125000);
  assert.ok(ev(s, (e) => e.kind === 'message' && e.device === 'c' && e.what === 'Handshake Initiation' && e.t > keyed + 100000).length >= 1);
  // from now on every handshake is lost; keepalives pass: the keys are rejected at 180 s after the last handshake, on each end
  s.engine.impair = (link, f) => (f.msg.protocol === 'wireguard' && /^Handshake/.test(f.msg.type) ? { lose: true } : null);
  const last = ev(s, (e) => e.kind === 'message' && e.device === 's' && e.what === 'Handshake Response').slice(-1)[0].t;
  s.runTo(last + 185000);
  assert.ok(ev(s, (e) => e.kind === 'message' && e.what === 'Keepalive' && e.t > last + 60000).length > 0, 'keepalives went on');
  assert.deepEqual([st('c'), st('s')], ['No session', 'No session']);
  assert.ok(ev(s, (e) => e.kind === 'state' && e.device === 's' && /REJECT_AFTER_TIME/.test(e.detail)).length === 1);
});
