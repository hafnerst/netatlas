/**
 * The `demands:` section: traffic demands, each a source, a destination and
 * a bandwidth (and optionally a label, a traffic class and a description).
 * Their form is checked like the rest of the model (unknown keys, a missing
 * or unreadable bandwidth); an end that names nothing of the model is a
 * warning, never an error: demands are analysis data (they are traced, see
 * analysis/traffic.ts) and don't make the model invalid.
 */
import { parseTraceEnd } from '../analysis/trace';
import { parseSpeed } from '../model/speed';
import { Demand, Model } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, ID_RE, Reader, get } from './reader';

const MAX_DEMANDS = 2000;

/** Read the demands of the document (after the model is built: the ends are resolved against it). */
export function readDemands(r: Reader, c: Ctx, top: YMap, model: Model): Demand[] {
  const out: Demand[] = [];
  const seen = new Map<string, number>();
  const items = r.list(get(top, 'demands'), 'demands');
  if (items.length > MAX_DEMANDS) c.error(items[MAX_DEMANDS], 'demands', `too many demands: ${items.length} (limit ${MAX_DEMANDS})`);
  items.slice(0, MAX_DEMANDS).forEach((n, i) => {
    const path = `demands[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, SCHEMA.demand, path);
    const id = r.id(m, path, ID_RE, 'demand id');
    if (!id) return;
    const dpath = 'demands.' + id;
    if (seen.has(id)) {
      c.error(get(m, 'id') as YNode, dpath + '.id', `duplicate demand id "${id}" (already used on line ${seen.get(id)})`);
      return;
    }
    seen.set(id, m.line);
    const ends: string[] = [];
    for (const key of ['source', 'destination']) {
      const v = r.field(m, key, dpath, 200);
      if (v === undefined || v === '') {
        c.error(m, dpath + '.' + key, `a demand needs its ${key}: a device, an interface (device:interface) or an IP address`, v === undefined ? { key } : {});
        return;
      }
      const e = parseTraceEnd(model, v);
      if (typeof e === 'string') c.warn(get(m, key) as YNode, dpath + '.' + key, `this demand can't be traced: ${e}`);
      ends.push(v);
    }
    const bw = r.field(m, 'bandwidth', dpath, 40);
    const bps = bw === undefined ? null : parseSpeed(bw);
    if (bw === undefined || !bps || bps <= 0) {
      c.error(bw === undefined ? m : (get(m, 'bandwidth') as YNode), dpath + '.bandwidth', bw === undefined ? 'a demand needs its bandwidth, e.g. bandwidth: 200M' : `"${bw}" is no bandwidth: write a number with k, M, G or T, e.g. 200M or 1.5G`, bw === undefined ? { key: 'bandwidth' } : {});
      return;
    }
    if (ends.length < 2) return;
    out.push({
      id,
      label: r.field(m, 'label', dpath, 200) || id,
      source: ends[0],
      destination: ends[1],
      bandwidth: bw,
      bps,
      class: r.field(m, 'class', dpath, 60),
      description: r.field(m, 'description', dpath, 2000),
      line: m.line,
    });
  });
  return out;
}
