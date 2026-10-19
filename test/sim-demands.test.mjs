// A demand in the simulation is representative traffic (proto-other.ts,
// multicast.ts): a packet every 1–4 s that shows the demand's way and
// whether it gets through — never its stated bandwidth, which capacity
// analysis uses. What the status, the log and the support say keeps the
// three apart: the stated demand, the representative packets, and the
// bytes those packets put on the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

test('a demand’s status: representative packets with their own rate on the wire, the stated 400 Mbit/s named as not carried', () => {
  const s = new S.Simulation(model(example('ospf-reroute.yaml')));
  s.runTo(30000);
  const st = s.status().find((x) => x.protocol === 'demand' && /^users-app:/.test(x.name));
  assert.ok(st);
  assert.match(st.detail, /^\d+ of \d+ representative packets delivered( \(\d+ lost or on their way\))?; representative packets: one of 1420 bytes every [\d.]+ s \(about [\d.]+ kbit\/s on the wire\); the demand states 400 Mbit\/s, which capacity analysis uses — the simulation does not carry that load$/);
  // the packets' own wire rate is far below the stated demand: nothing here loads a cable with it
  const kbps = Number(/about ([\d.]+) kbit\/s/.exec(st.detail)[1]);
  assert.ok(kbps < 20, String(kbps));
  // the log's packets say what they are
  assert.ok(s.events().some((e) => e.protocol === 'demand' && /representative data packet 1 .* it shows the demand's way, not its 400 Mbit\/s/.test(e.detail)));
  // and the support statement does not claim bandwidth
  const e = s.protocolEntries().find((x) => x.id === 'demand');
  assert.match(e.support.not, /no cable is loaded, queued or congested by it, and no throughput or latency under load is concluded/);
});
