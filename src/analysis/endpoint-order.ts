/**
 * The order in which a device's interfaces stand for the device — one
 * definition for every consumer that turns a device into an address:
 * communication.ts (appAddress, egressSource), the simulation's
 * applications (apps.ts), Send test's targets and sources (transport.ts),
 * an MQTT client's broker (mqtt.ts) and a load balancer's health checks.
 * Each consumer keeps its own adapter for what an interface is (the
 * model's type statically, the simulation's runtime interface) and for
 * whether an address is usable now (configured, a lease, up, not
 * tentative): those differ between a snapshot, the configured model and
 * the running simulation, and stay explicit there.
 *
 *   reach    the address a device is reached at: an ordinary interface
 *            first, a loopback next, a container bridge's interface last
 *            (its address is not reached from outside its host); never a
 *            tunnel's;
 *   source   the stand-in address of an unnumbered egress: a loopback
 *            first, then the others; never a tunnel's.
 *
 * Ties go by interface id. Pure.
 */

export type IfaceKind = 'ordinary' | 'loopback' | 'bridge' | 'tunnel';

/** Where an interface ranks as the address a device is reached at (null: never). */
export function reachRank(k: IfaceKind): number | null {
  return k === 'tunnel' ? null : k === 'loopback' ? 1 : k === 'bridge' ? 2 : 0;
}

/** Where an interface ranks as an unnumbered egress's stand-in source (null: never). */
export function sourceRank(k: IfaceKind): number | null {
  return k === 'tunnel' ? null : k === 'loopback' ? 0 : 1;
}

/** The items in a rank's order, those it leaves out (null) dropped, ties by id. */
export function ordered<T>(xs: T[], rank: (x: T) => number | null, id: (x: T) => string): T[] {
  return xs
    .map((x) => ({ x, r: rank(x), id: id(x) }))
    .filter((e) => e.r !== null)
    .sort((a, b) => (a.r as number) - (b.r as number) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => e.x);
}

/** A model interface's kind (its type). */
export function modelKind(i: { type?: string } | undefined): IfaceKind {
  const t = i ? i.type : undefined;
  return t === 'loopback' ? 'loopback' : t === 'bridge' ? 'bridge' : t === 'tunnel' ? 'tunnel' : 'ordinary';
}

/** A simulation interface's kind: its runtime kind (loopback, tunnel), else its model type (a container bridge). */
export function runtimeKind(l: { kind: string }, modelIface: { type?: string } | undefined): IfaceKind {
  return l.kind === 'loopback' ? 'loopback' : l.kind === 'tunnel' ? 'tunnel' : modelKind(modelIface) === 'bridge' ? 'bridge' : 'ordinary';
}
