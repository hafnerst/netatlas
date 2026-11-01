/**
 * Encapsulation sizes: the one definition of what each tunnel or overlay
 * protocol adds to the packet it carries. The static path MTU (mtu.ts), the
 * tunnel-MTU check and the MTU suggestions (checks-more.ts tunnelBudget),
 * the simulation's packet lengths (engine.ts ipLen: the packet inspector,
 * a frame's time on the wire), its tunnel MTU and the PMTUD it relays into
 * a tunnel (engine.ts intoTunnel) all read it, so the same packet has the
 * same size statically and at run time. The outer header's protocol and
 * ports are trace.ts tunnelOuter's, never stated here.
 *
 * Size boundaries (bytes), from the inside out:
 *
 *   payload     what an application sends
 *   L4          transport header + payload (a packet's `len`)
 *   IP packet   IP header (20 / 40; IPv4 Router Alert 4, IPv6 Hop-by-Hop 8,
 *               an IPv6 fragment header 8) + L4: what an MTU limits
 *   inner       what a tunnel carries: an IP packet, or for an Ethernet
 *               overlay (VXLAN, Geneve) an Ethernet frame without FCS and
 *               without a tag (14 + the IP packet)
 *   outer       outer IP header + outer UDP 8 (a UDP tunnel) + the tunnel's
 *               header + the inner, padded where the protocol pads, + its
 *               trailer: an IP packet again, limited by the underlay's MTU
 *   frame       the Ethernet header and FCS (18) + the IP packet, at least
 *               64 bytes (engine.ts frameBytes); a tag is not counted
 *
 * Exact under the stated abstraction: each protocol is one fixed format
 * (GRE without key or sequence number, ESP tunnel mode with AES-CBC and
 * HMAC-SHA1-96, WireGuard's transport data message, OpenVPN's P_DATA_V2
 * with an AEAD cipher …); its `assumes` says which, and every result that
 * uses it repeats that. A device with other options (a GRE key, AES-GCM,
 * Geneve options) adds or saves a few bytes the model does not know. A
 * tunnel whose protocol has no definition here is taken as GRE (the
 * simulation's long-standing default), said so as an assumption: the static
 * path MTU is then an estimate (indeterminate), never established.
 */

/** One encapsulation format: the bytes it adds around its inner packet. */
export interface EncapDef {
  /** the protocol's base id ("gre", "ipsec") */
  protocol: string;
  /** "GRE", "IPsec ESP" */
  name: string;
  /** an outer UDP header (8 bytes) between the outer IP header and the tunnel's own */
  udp: boolean;
  /** the tunnel's header before the inner packet (GRE 4, VXLAN 8, ESP's SPI, sequence number and IV 24 …) */
  header: number;
  /** an inner Ethernet header (14) before the inner IP packet: an Ethernet overlay */
  innerL2: number;
  /** bytes padded with the inner before the block alignment (ESP's pad length and next header: 2) */
  padExtra: number;
  /** the inner (with padExtra) is padded to a multiple of this (0: not padded) */
  block: number;
  /** after the padded inner (ESP's ICV 12, WireGuard's tag 16) */
  trailer: number;
  /** the format assumed, for the explanation ("ESP tunnel mode, AES-CBC (16-byte IV and blocks), HMAC-SHA1-96 (12-byte ICV)") */
  assumes: string;
}

const D = (protocol: string, name: string, udp: boolean, header: number, assumes: string, o: Partial<Pick<EncapDef, 'innerL2' | 'padExtra' | 'block' | 'trailer'>> = {}): EncapDef => ({ protocol, name, udp, header, innerL2: o.innerL2 || 0, padExtra: o.padExtra || 0, block: o.block || 0, trailer: o.trailer || 0, assumes });

/** The formats, by base protocol (protocols.ts ids). */
export const ENCAPS: { [protocol: string]: EncapDef } = {
  gre: D('gre', 'GRE', false, 4, 'GRE without key, checksum or sequence number (RFC 2784): 4 bytes'),
  dmvpn: D('dmvpn', 'mGRE', false, 4, 'mGRE without key, checksum or sequence number (RFC 2784): 4 bytes'),
  ipip: D('ipip', 'IP-in-IP', false, 0, 'IP in IP (RFC 2003, RFC 2473): the outer IP header only'),
  ipsec: D('ipsec', 'IPsec ESP', false, 24, 'ESP tunnel mode (RFC 4303) with AES-CBC and HMAC-SHA1-96: 8 SPI and sequence number + 16 IV, the inner padded with its 2 trailer bytes to 16, 12 ICV; no NAT traversal', { padExtra: 2, block: 16, trailer: 12 }),
  wireguard: D('wireguard', 'WireGuard', true, 16, 'a WireGuard transport data message: 16 header bytes and a 16-byte tag; its padding (to 16 bytes, never beyond the interface MTU) is not counted, so a packet of the tunnel MTU is exact and a smaller one up to 15 bytes short', { trailer: 16 }),
  openvpn: D('openvpn', 'OpenVPN', true, 24, 'OpenVPN over UDP, tun mode, P_DATA_V2 with an AEAD cipher: 4 opcode and peer id + 4 packet id + 16 tag'),
  l2tp: D('l2tp', 'L2TPv3', true, 12, 'L2TPv3 over UDP (RFC 3931): 8 header and session id, no cookie, 4 L2-specific sublayer; the inner counted as an IP packet'),
  gtp: D('gtp', 'GTP-U', true, 8, 'GTP-U without extension headers (3GPP TS 29.281): 8 bytes'),
  vxlan: D('vxlan', 'VXLAN', true, 8, 'VXLAN (RFC 7348): 8 bytes, carrying the inner Ethernet frame (14, untagged, no FCS)', { innerL2: 14 }),
  geneve: D('geneve', 'Geneve', true, 8, 'Geneve without options (RFC 8926): 8 bytes, carrying the inner Ethernet frame (14, untagged, no FCS)', { innerL2: 14 }),
};

/** The format of a protocol (its base id), or null when the model has none. */
export function encapDef(protocol: string): EncapDef | null {
  return Object.prototype.hasOwnProperty.call(ENCAPS, protocol) ? ENCAPS[protocol] : null;
}

/** What a tunnel without a known format is taken as. */
export const ASSUMED_ENCAP = ENCAPS.gre;

/** An IP header without options (bytes). */
export const ipHeaderBytes = (v: 4 | 6): number => (v === 4 ? 20 : 40);

const pad = (n: number, block: number): number => (block ? Math.ceil(n / block) * block : n);

/** The outer IP packet's length for an inner of `inner` bytes (an IP packet), with an IPv4 or IPv6 outer header. */
export function outerLength(d: EncapDef, inner: number, outer: 4 | 6): number {
  return ipHeaderBytes(outer) + (d.udp ? 8 : 0) + d.header + pad(d.innerL2 + inner + d.padExtra, d.block) + d.trailer;
}

/** The largest inner IP packet whose outer packet fits `limit` bytes (null: none fits). */
export function maxInner(d: EncapDef, limit: number, outer: 4 | 6): number | null {
  let room = limit - ipHeaderBytes(outer) - (d.udp ? 8 : 0) - d.header - d.trailer;
  if (d.block) room = Math.floor(room / d.block) * d.block;
  const n = room - d.padExtra - d.innerL2;
  return n > 0 ? n : null;
}

/** The largest inner packet through nested layers (innermost first: each carried in the next), null when none fits. */
export function maxInnerStack(layers: Array<{ def: EncapDef; outer: 4 | 6 }>, limit: number): number | null {
  let lim: number | null = limit;
  for (let k = layers.length - 1; k >= 0 && lim !== null; k--) lim = maxInner(layers[k].def, lim, layers[k].outer);
  return lim;
}

/** The bytes a layer adds to an inner of `inner` bytes. */
export function overheadBytes(d: EncapDef, inner: number, outer: 4 | 6): number {
  return outerLength(d, inner, outer) - inner;
}

/** How a layer's bytes add up, in words: "20 IPv4 + 4 GRE", "40 IPv6 + 8 UDP + 8 VXLAN + 14 inner Ethernet". */
export function overheadText(d: EncapDef, outer: 4 | 6): string {
  const parts = [`${ipHeaderBytes(outer)} IPv${outer}`];
  if (d.udp) parts.push('8 UDP');
  if (d.header) parts.push(`${d.header} ${d.name}`);
  if (d.innerL2) parts.push(`${d.innerL2} inner Ethernet`);
  if (d.block) parts.push(`padding to ${d.block}${d.padExtra ? ` with ${d.padExtra} trailer bytes` : ''}`);
  if (d.trailer) parts.push(`${d.trailer} ${d.protocol === 'ipsec' ? 'ICV' : 'tag'}`);
  return parts.join(' + ');
}

/** The outermost packet's length through nested layers (innermost first). */
export function outerLengthStack(layers: Array<{ def: EncapDef; outer: 4 | 6 }>, inner: number): number {
  let n = inner;
  for (const l of layers) n = outerLength(l.def, n, l.outer);
  return n;
}

/** A layer as the explanations name it: "GRE: 20 IPv4 + 4 GRE (GRE without key …)". */
export function layerText(d: EncapDef, outer: 4 | 6): string {
  return `${d.name}: ${overheadText(d, outer)}`;
}
