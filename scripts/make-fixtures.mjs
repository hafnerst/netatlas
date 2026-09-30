// Produces the generated test fixtures in test/fixtures/ by driving the same
// editing core the web page uses (build/js/editor/document.js — ModelDoc), so
// they are reproducible:
//
//   test/fixtures/editor-new-network.yaml   a model created from "New" and built up
//   test/fixtures/minimal-edited.yaml       examples/minimal.yaml imported and edited
//   test/fixtures/metro-ring-arranged.yaml  examples/metro-ring.yaml after Auto-arrange
//
//   node scripts/make-fixtures.mjs          write the files
//   node scripts/make-fixtures.mjs --check  exit 1 if they are out of date
//
// They are test data, not examples: the web app does not offer them. The
// tests compare them with what these functions produce, and the in-browser
// self-test uses them through the embedded FIXTURES list.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { ModelDoc, KEY_ORDER } = require(join(root, 'build/js/editor/document.js'));
const Y = require(join(root, 'build/js/yaml/parse.js'));

const s = Y.strNode;
const flowList = (...xs) => Y.seqNode(xs.map(s), true);

/** "New" → two routers, loopbacks, ports, a VLAN interface and a tunnel interface, a cable, iBGP between loopbacks and a GRE tunnel. */
export function buildNewNetwork() {
  const d = ModelDoc.create();
  d.change('Edit title', () => d.setAt(['title'], s('Lab: two edge routers'), KEY_ORDER.top));
  d.change('Edit description', () => d.setAt(['description'], s('Created in the netatlas editor: loopbacks, ports, a VLAN interface and a tunnel interface per router, one cable, IP networks, iBGP and a GRE tunnel between loopbacks.'), KEY_ORDER.top));
  // New starts empty: add both routers, choosing their type explicitly
  const a = d.addEntity('device', [['id', s('edge-a')], ['type', s('router')]]);
  d.addLoopback(a, ['10.255.0.1/32'], 'Router ID', 'lo0');
  const b = d.addEntity('device', [['id', s('edge-b')], ['type', s('router')]]);
  d.change('Edit label', () => d.setAt(['devices', b, 'label'], s('Edge B'), KEY_ORDER.device));
  // loopbacks: edge-a gets a second (IPv6) loopback, edge-b gets two with v4+v6
  d.addLoopback(0, ['2001:db8:ffff::a/128'], 'BGP source (IPv6)', 'lo1');
  d.addLoopback(b, ['10.255.0.2/32', '2001:db8:ffff::2/128'], 'Router ID', 'lo0');
  d.addLoopback(b, ['2001:db8:ffff::b/128'], 'BGP source (IPv6)', 'lo1');
  // physical ports and a cable
  // (speed and medium belong to the cable, not to the ports)
  d.addInterface(0, [['id', s('ge-0/0/0')], ['ip', flowList('192.0.2.1/31')]]);
  d.addInterface(b, [['id', s('ge-0/0/0')], ['ip', flowList('192.0.2.0/31')]]);
  // logical interfaces: a VLAN interface (its VLAN comes from the network of its address; the port carrying it is
  // derived from the cable) and a tunnel interface sourced from the loopback, towards the other router's loopback
  for (const [dev, n, peer] of [[0, 1, 2], [b, 2, 1]]) {
    d.addLogical(dev, 'virtual', [['id', s('irb.100')], ['label', s('Management')], ['ip', flowList(`10.100.0.${n}/24`)]]);
    d.addLogical(dev, 'tunnel', [['id', s('gr-0/0/0.1')], ['ip', flowList(`172.16.0.${n}/30`)], ['source', s('lo0')], ['destination', s(`10.255.0.${peer}`)]]);
  }
  d.addEntity('link', [['id', s('cable-1')], ['a', s('edge-a:ge-0/0/0')], ['b', s('edge-b:ge-0/0/0')], ['medium', s('fiber')], ['speed', s('10G')], ['cable', s('LC-LC OM4 3m')]]);
  // the cable carries VLAN 100 at both ends
  d.addEndVlans(['links', 0, 'a'], [100]);
  d.addEndVlans(['links', 0, 'b'], [100]);
  // an IP network: both routers become members through their port addresses
  d.addEntity('network', [['id', s('net-core')], ['label', s('Core link')], ['cidr', s('192.0.2.0/31')]]);
  d.addEntity('network', [['id', s('net-mgmt')], ['label', s('Management')], ['cidr', s('10.100.0.0/24')], ['vlan', Y.numNode(100)]]);
  // a network that only loopbacks are in: part of the logical view, not of the physical one
  d.addEntity('network', [['id', s('net-loopbacks')], ['label', s('Router loopbacks')], ['cidr', s('10.255.0.0/24')]]);
  // logical relations sourced from loopbacks
  d.addEntity('relation', [
    ['id', s('ibgp-v6')],
    ['protocol', s('ibgp')],
    ['endpoints', flowList('edge-a:lo1', 'edge-b:lo1')],
    ['over', s('cable-1')],
    ['attrs', Y.mapNode([['asn', Y.numNode(65000)], ['address-family', flowList('ipv6-unicast', 'evpn')]])],
  ]);
  d.addEntity('relation', [
    ['id', s('gre-lab')],
    ['protocol', s('gre')],
    ['endpoints', flowList('edge-a:lo0', 'edge-b:lo0')],
    ['over', s('cable-1')],
    ['attrs', Y.mapNode([['key', Y.numNode(100)], ['keepalive', Y.mapNode([['interval', s('10s')], ['retries', Y.numNode(3)]])]])],
  ]);
  // finally: Auto-arrange both views (while editing, new objects are only placed next to their neighbors)
  d.arrange(['physical', 'logical']);
  return d;
}

/** minimal.yaml imported → loopbacks, BGP between loopbacks, attrs, rename. */
export function buildMinimalEdited() {
  const text = readFileSync(join(root, 'examples', 'minimal.yaml'), 'utf8');
  const d = ModelDoc.fromText(text, 'minimal.yaml', 'file').doc;
  d.change('Edit title', () => d.setAt(['title'], s('Minimal example (edited in netatlas)'), KEY_ORDER.top));
  for (const [i, n] of [[0, 1], [1, 2]]) {
    d.addLoopback(i, [`10.255.0.${n}/32`, `2001:db8:ffff::${n}/128`], 'Router ID', 'lo0');
  }
  // rename r1 -> edge-1: every reference (link, relations) follows
  d.renameEntity('device', 0, 'edge-1');
  d.change('Add attrs', () => d.setAt(['links', 0, 'attrs'], Y.mapNode([['patch-panel', s('PP-3 port 14')], ['length', s('2m')]]), KEY_ORDER.link));
  d.addEntity('relation', [
    ['id', s('bgp-1')],
    ['protocol', s('ibgp')],
    ['endpoints', flowList('edge-1:lo0', 'r2:lo0')],
    ['over', s('ospf-1')],
    ['attrs', Y.mapNode([['asn', Y.numNode(65001)], ['update-source', s('lo0')]])],
  ]);
  d.arrange(['physical', 'logical']);
  return d;
}

/** metro-ring.yaml loaded -> Auto-arrange (both views) -> exported. */
export function buildMetroArranged() {
  const text = readFileSync(join(root, 'examples', 'metro-ring.yaml'), 'utf8');
  const d = ModelDoc.fromText(text, 'metro-ring.yaml', 'file').doc;
  d.arrange(['physical', 'logical']);
  return d;
}

const outputs = [
  ['editor-new-network.yaml', buildNewNetwork],
  ['minimal-edited.yaml', buildMinimalEdited],
  ['metro-ring-arranged.yaml', buildMetroArranged],
];

const header = {
  'metro-ring-arranged.yaml':
    '# netatlas test fixture: examples/metro-ring.yaml after Auto-arrange (both views) and export\n' +
    '# (generated by scripts/make-fixtures.mjs). The positions are in the\n' +
    '# "layout" section at the end; the network itself is unchanged.\n',
  'editor-new-network.yaml': '# netatlas test fixture: a model created with "New" in the editor and built up\n# with the editor operations (generated by scripts/make-fixtures.mjs).\n',
  'minimal-edited.yaml': '# netatlas test fixture: examples/minimal.yaml after being imported and edited\n# (generated by scripts/make-fixtures.mjs): loopbacks with IPv4 + IPv6,\n# r1 renamed to edge-1 (references updated), cable attributes and an iBGP\n# session between the loopbacks. Original comments are preserved.\n',
};

export function render(name) {
  const build = outputs.find(([n]) => n === name)[1];
  const d = build();
  if (!d.valid) throw new Error(name + ' is not valid: ' + d.errors.map((e) => e.message).join('; '));
  return (header[name] || '') + d.exportText();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [name] of outputs) {
    const text = render(name);
    const file = join(root, 'test', 'fixtures', name);
    if (check) {
      let cur = '';
      try {
        cur = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      } catch {
        /* missing */
      }
      if (cur !== text) {
        console.log('out of date: test/fixtures/' + name);
        stale = true;
      }
    } else {
      writeFileSync(file, text);
      console.log('wrote test/fixtures/' + name);
    }
  }
  process.exit(stale ? 1 : 0);
}
