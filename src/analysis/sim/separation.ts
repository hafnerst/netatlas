/**
 * Domain separation in the simulation: a Separation gateway's decisions on
 * what it would bridge (a filtering bridge) or route (a filtering router).
 * The policy is analysis/separation.ts; this keeps the transfers it
 * permitted, so that their replies go back (and nothing else comes the
 * other way), and applies the gateway's transfer delay and loss.
 *
 * A protocol break forwards nothing: its legs are the transport's
 * (sim/transport.ts), which asks `breakDecision` here.
 */
import { Device } from '../../model/types';
import { formatAddr } from '../ipmath';
import { decide, decideBreak, ruleText, SepDecision } from '../separation';
import { Pkt } from './types';
import { Resolved, resolvedText } from './params';

/** How long a permitted transfer's replies are expected without traffic: TCP five minutes, UDP and ICMP a minute (demonstration values). */
export const SEP_IDLE_TCP = 300000;
export const SEP_IDLE_OTHER = 60000;

/** What the gateway needs of the engine. */
export interface SepHost {
  readonly now: number;
  note(kind: 'drop' | 'table' | 'route', protocol: string, device: string, peer: string, what: string, state: string, detail: string): void;
  param(key: string, dev: string): Resolved;
  /** a draw for the transfer loss (deterministic per model) */
  loss(): number;
}

interface Flow {
  /** the reply's key (it is let back) */
  reply: string;
  rule: string;
  last: number;
  idle: number;
}

export class SeparationSim {
  /** device -> reply key -> the permitted transfer */
  private flows = new Map<string, Map<string, Flow>>();
  /** what was noted already (a denial is reported once per flow) */
  private noted = new Set<string>();

  constructor(private h: SepHost) {}

  /**
   * May a packet cross from one interface of a gateway to another? A reply
   * of a permitted transfer may; anything else as the policy decides. Its
   * transfer delay when it may (0: none), null when it is denied or lost.
   */
  pass(dev: Device, pkt: Pkt, inIface: string, outIface: string): number | null {
    const tab = this.table(dev.id);
    const l4 = pkt.l4;
    const proto: 'tcp' | 'udp' | 'icmp' | 'other' = l4 && (l4.proto === 'tcp' || l4.proto === 'udp' || l4.proto === 'icmp') ? l4.proto : 'other';
    const key = flowKey(pkt);
    const now = this.h.now;
    // a reply of a permitted transfer (or an ICMP error about one)
    const back = tab.get(key) || (l4 && l4.quote ? tab.get(quoteKey(l4.quote)) : undefined);
    if (back && now - back.last <= back.idle) {
      back.last = now;
      return this.delay(dev, pkt, `the reply of a transfer permitted by rule ${back.rule}`);
    }
    // an ongoing permitted transfer
    const fwd = tab.get('>' + key);
    if (fwd && now - fwd.last <= fwd.idle) {
      fwd.last = now;
      const r = tab.get(fwd.reply);
      if (r) r.last = now;
      return this.delay(dev, pkt, `rule ${fwd.rule}`);
    }
    // a reply that is not one (a TCP segment that opens nothing, an echo reply nobody asked for) is not a transfer either
    const opening = proto !== 'tcp' || ((l4 as NonNullable<typeof l4>).flags || []).indexOf('SYN') >= 0;
    const d: SepDecision = opening ? decide(dev, { inIface, outIface, src: pkt.src, dst: pkt.dst, proto, dport: l4 ? l4.dport : undefined }) : { ok: false, text: `${dev.id} denies it: it belongs to no permitted transfer` };
    if (!d.ok) {
      const nk = `${dev.id}|${key}`;
      if (!this.noted.has(nk)) {
        this.noted.add(nk);
        this.h.note('drop', pkt.msg.protocol, dev.id, '', 'denied', '', `${d.text} (${pkt.msg.label}: ${what(pkt)}, in ${inIface})`);
      }
      return null;
    }
    const idle = proto === 'tcp' ? SEP_IDLE_TCP : SEP_IDLE_OTHER;
    const reply = replyKey(pkt);
    tab.set(reply, { reply, rule: d.rule.id, last: now, idle });
    tab.set('>' + key, { reply, rule: d.rule.id, last: now, idle });
    this.h.note('table', pkt.msg.protocol, dev.id, '', 'permitted', '', `${d.text}: ${what(pkt)} (${pkt.msg.label}), ${d.from} → ${d.to}; its replies may come back`);
    return this.delay(dev, pkt, ruleText(d.rule));
  }

  /** A protocol break: may a transfer that reached a listening port become a new one (see decideBreak)? Reported either way. */
  breakDecision(dev: Device, inIface: string, pkt: Pkt, profileId: string): ReturnType<typeof decideBreak> | null {
    const sep = dev.separation;
    const prof = sep ? sep.profiles.find((p) => p.id === profileId) : undefined;
    if (!prof) return null;
    const d = decideBreak(dev, inIface, pkt.src, prof);
    if (!d.ok) this.h.note('drop', pkt.msg.protocol, dev.id, '', 'denied', '', `${d.text} (${pkt.msg.label} from ${formatAddr(pkt.src)} at ${inIface}): leg 1 ends here, no leg 2 is started`);
    return d;
  }

  /** The transfer delay (and the loss) of a permitted packet. */
  delay(dev: Device, pkt: Pkt, why: string): number | null {
    const loss = this.h.param('transfer-loss', dev.id);
    if (Number(loss.value) > 0 && this.h.loss() * 100 < Number(loss.value)) {
      this.h.note('drop', pkt.msg.protocol, dev.id, '', 'lost', '', `${dev.id} loses ${pkt.msg.label} (${why}): transfer loss ${resolvedText(loss)}`);
      return null;
    }
    return Number(this.h.param('transfer-delay', dev.id).value) || 0;
  }

  /** The permitted transfers a gateway knows (for its status). */
  rows(dev: string): Array<{ flow: string; rule: string; age: number }> {
    const out: Array<{ flow: string; rule: string; age: number }> = [];
    for (const [k, f] of this.table(dev)) if (k.startsWith('>')) out.push({ flow: k.slice(1), rule: f.rule, age: this.h.now - f.last });
    return out.sort((a, b) => (a.flow < b.flow ? -1 : a.flow > b.flow ? 1 : 0));
  }

  private table(dev: string): Map<string, Flow> {
    let t = this.flows.get(dev);
    if (!t) {
      t = new Map();
      this.flows.set(dev, t);
    }
    return t;
  }
}

/** A packet's flow: protocol, source and destination with their ports (an echo's identifier). */
function flowKey(p: Pkt): string {
  const l4 = p.l4;
  const proto = l4 ? l4.proto : 'ip';
  const sp = l4 ? (l4.proto === 'icmp' ? l4.echoId || 0 : l4.sport || 0) : 0;
  const dp = l4 ? (l4.proto === 'icmp' ? l4.echoId || 0 : l4.dport || 0) : 0;
  return `${proto}|${formatAddr(p.src)}:${sp}>${formatAddr(p.dst)}:${dp}`;
}

/** The flow of a packet's reply. */
function replyKey(p: Pkt): string {
  const l4 = p.l4;
  const proto = l4 ? l4.proto : 'ip';
  const sp = l4 ? (l4.proto === 'icmp' ? l4.echoId || 0 : l4.sport || 0) : 0;
  const dp = l4 ? (l4.proto === 'icmp' ? l4.echoId || 0 : l4.dport || 0) : 0;
  return `${proto}|${formatAddr(p.dst)}:${dp}>${formatAddr(p.src)}:${sp}`;
}

/** The reply key of the packet an ICMP error quotes (the error goes back along it). */
function quoteKey(q: { proto: string; src: string; dst: string; sport?: number; dport?: number }): string {
  return `${q.proto}|${q.dst}:${q.dport || 0}>${q.src}:${q.sport || 0}`;
}

function what(p: Pkt): string {
  const l4 = p.l4;
  if (!l4 || l4.proto === 'other' || l4.proto === 'igmp') return `${formatAddr(p.src)} → ${formatAddr(p.dst)}`;
  if (l4.proto === 'icmp') return `ICMP ${l4.icmpName || ''} ${formatAddr(p.src)} → ${formatAddr(p.dst)}`.replace(/\s+/g, ' ');
  return `${l4.proto.toUpperCase()} ${formatAddr(p.src)}:${l4.sport} → ${formatAddr(p.dst)}:${l4.dport}`;
}
