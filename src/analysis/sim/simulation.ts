/**
 * The protocol simulation of a model (Simulate → Start simulation): the
 * engine (engine.ts) with every protocol's behaviour, started like a
 * freshly booted network. The window and the animation use this facade
 * only. Deterministic: the same model, the same actions at the same
 * simulated times, the same timeline. It never changes the model.
 */
import { SIM_GROUPS, SimGroup, simProfile } from '../../model/sim-profiles';
import { Model } from '../../model/types';
import { failableRef } from '../failure';
import { Engine, EngineOptions } from './engine';
import { OTHER_BEHAVIOURS, installBootGarp, installCustomL2, installDemands, installFhrp, installL2Adverts, installLacp, installPimRegister } from './proto-other';
import { ROUTING_BEHAVIOURS } from './proto-routing';
import { ProtocolSim } from './protocols';
import { ArpRow, Flight, MacRow, SessionStatus, SimEvent, TableTimer } from './types';

/** A protocol of the simulation as the window lists it (a checkbox). */
export interface SimProtocolEntry {
  id: string;
  label: string;
  group: SimGroup | 'Traffic';
}

export class Simulation {
  readonly engine: Engine;
  readonly protocols: ProtocolSim;
  readonly model: Model;

  constructor(model: Model, opts: EngineOptions = {}) {
    this.model = model;
    this.engine = new Engine(model, opts);
    this.protocols = new ProtocolSim(this.engine, { ...ROUTING_BEHAVIOURS, ...OTHER_BEHAVIOURS });
    installBootGarp(this.protocols);
    installFhrp(this.protocols);
    installLacp(this.protocols);
    installL2Adverts(this.protocols);
    installDemands(this.protocols);
    installPimRegister(this.protocols);
    installCustomL2(this.protocols);
    this.protocols.start();
  }

  /** The simulated time (ms). */
  get now(): number {
    return this.engine.now;
  }

  /** Run to simulated time t (ms). */
  runTo(t: number): void {
    this.engine.run(t);
  }

  /** Step: to the next moment something happens (at most `max` ms ahead); returns the new time. */
  step(max = 5000): number {
    const n = this.engine.nextTime();
    const t = n === null ? this.engine.now + max : Math.min(Math.max(n, this.engine.now), this.engine.now + max);
    this.engine.run(t);
    return this.engine.now;
  }

  /** Fail a cable or relation (one at a time: another failed one is restored first). */
  fail(ref: string): boolean {
    if (!failableRef(this.model, ref) || (ref.indexOf('link:') !== 0 && ref.indexOf('relation:') !== 0)) return false;
    this.engine.fail(ref);
    return true;
  }

  restore(): boolean {
    if (!this.engine.failed) return false;
    this.engine.restore();
    return true;
  }

  failed(): string | null {
    return this.engine.failed;
  }

  events(): SimEvent[] {
    return this.engine.log;
  }

  flights(t: number, view: 'physical' | 'logical'): Flight[] {
    return this.engine.flightsAt(t, view);
  }

  status(): SessionStatus[] {
    return this.protocols.status();
  }

  arpTable(dev: string): ArpRow[] {
    return this.engine.arpRows(dev, 4);
  }

  ndTable(dev: string): ArpRow[] {
    return this.engine.arpRows(dev, 6);
  }

  macTable(dev: string): MacRow[] {
    return this.engine.macRows(dev);
  }

  arpTimers(dev: string): TableTimer[] {
    return this.engine.arpTimers(dev);
  }

  macTimers(): TableTimer[] {
    return this.engine.macTimers();
  }

  setTimerScale(n: number): void {
    this.engine.setTimerScale(n);
  }

  get timerScale(): number {
    return this.engine.timerScale;
  }

  /** The devices with an IP stack (an ARP table) and the switches (a MAC table), by id. */
  tableDevices(): Array<{ id: string; arp: boolean; mac: boolean }> {
    return Array.from(this.engine.net.devices.values())
      .filter((d) => d.l3.size > 0 || d.bridge)
      .map((d) => ({ id: d.id, arp: Array.from(d.l3.values()).some((l) => l.addrs.length > 0 && l.kind !== 'loopback'), mac: d.bridge && d.dev.type === 'switch' }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The protocols this model's simulation runs, grouped (Layer 2 first), for the window's checkboxes. */
  protocolEntries(): SimProtocolEntry[] {
    const seen = new Map<string, SimProtocolEntry>();
    const add = (id: string, label: string, group: SimProtocolEntry['group']): void => {
      if (!seen.has(id)) seen.set(id, { id, label, group });
    };
    add('arp', 'ARP', 'Layer 2');
    if (this.model.devices.some((d) => d.interfaces.concat(d.logical).some((i) => i.addresses.some((a) => a.indexOf(':') >= 0)))) add('ndp', 'NDP', 'Layer 2');
    add('garp', 'Gratuitous ARP', 'Layer 2');
    for (const r of this.model.relations) {
      const p = this.protocols.profileOf(r);
      add(p.id, p.label, p.group);
    }
    for (const d of this.model.devices) {
      if (d.logical.some((i) => i.type === 'virtual' && i.members.length)) add('lacp', 'LACP', 'Layer 2');
      for (const i of d.interfaces.concat(d.logical)) for (const s of i.services) {
        const p = simProfile(s.id);
        if (p) add(p.id, p.label, p.group);
      }
    }
    if (this.model.demands.length) add('demand', 'Demands (data)', 'Traffic');
    const order = (g: SimProtocolEntry['group']): number => (g === 'Traffic' ? SIM_GROUPS.length : SIM_GROUPS.indexOf(g as SimGroup));
    return Array.from(seen.values()).sort((a, b) => order(a.group) - order(b.group) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }
}
