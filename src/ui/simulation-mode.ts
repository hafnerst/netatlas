/**
 * What simulation mode needs from a simulation (Simulate → Protocol
 * simulation): the texts of the banner, the status-bar marker and the
 * export note, what is failed in the simulated state (the diagram marks it,
 * focus mode and the path tracer use it), a key that changes whenever that
 * state does, and a way to stop it. While one is on, the model is locked
 * for editing (see App.startSimulation).
 */
import { FailureResult } from '../analysis/failure';

export interface SimulationMode {
  /** the banner's and the export note's text, e.g. "Protocol simulation, t = 12.4 s" */
  note(): string;
  /** the status-bar marker's text, e.g. "Simulation · t = 12.4 s" */
  marker(): string;
  /** changes whenever failure() does (a trace is computed again then) */
  key(): string;
  /** what is failed in the simulated state (null: nothing) */
  failure(): FailureResult | null;
  /** called once when simulation mode ends (Exit simulation, Esc, another model) */
  stop(): void;
}
