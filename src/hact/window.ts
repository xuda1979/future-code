/**
 * Deterministic priced-window selector. No adversarial regret claim.
 *
 * A TypeScript runtime implementation of the frozen v3/v4 64-event baseline.
 * choose() must precede observe(); every observation is an exogenous,
 * full-information cost vector (all catalogue layouts must be priced for the
 * observed completion event). Checkpoint only at event boundaries. Compilation
 * is NEVER performed by this policy — the trusted caller applies any migration
 * through the protected generation-fenced kernel and accounts for canonical
 * manifest bytes and cold rebuilding separately.
 *
 * Ported from ichact/window.py (Adaptive HACT v4.0.0).
 */

/** A single event record returned by observe(). */
export interface PricedEventRecord {
  readonly round: number;
  readonly chosen: number;
  readonly serviceBytes: number;
  readonly switchBytes: number;
}

/** Serializable checkpoint state, valid only at an event boundary. */
export interface PricedWindowState {
  readonly schema: 'priced-window-1';
  readonly migration: number[][];
  readonly active: number;
  readonly window: number;
  readonly history: number[][];
  readonly round: number;
  readonly service: number;
  readonly switchCost: number;
  readonly switches: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateMigration(input: readonly (readonly number[])[]): number[][] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('finite nonnegative square migration matrix with zero diagonal required');
  }
  const n = input.length;
  return input.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) {
      throw new Error('finite nonnegative square migration matrix with zero diagonal required');
    }
    return row.map((value, j) => {
      if (!isFiniteNumber(value) || value < 0) {
        throw new Error('finite nonnegative square migration matrix with zero diagonal required');
      }
      if (i === j && value !== 0) {
        throw new Error('finite nonnegative square migration matrix with zero diagonal required');
      }
      return value;
    });
  });
}

function validateCostVector(costs: readonly number[], n: number): void {
  if (!Array.isArray(costs) || costs.length !== n) {
    throw new Error('finite nonnegative full-information costs required');
  }
  for (const v of costs) {
    if (!isFiniteNumber(v) || v < 0) {
      throw new Error('finite nonnegative full-information costs required');
    }
  }
}

function meanRows(history: readonly (readonly number[])[], n: number): number[] {
  const means = new Array<number>(n).fill(0);
  for (const row of history) {
    for (let j = 0; j < n; j++) means[j] += row[j];
  }
  for (let j = 0; j < n; j++) means[j] /= history.length;
  return means;
}

/**
 * Deterministic priced-window selector.
 *
 * On each choose() call, before observing the current completion event, the
 * selector proposes the layout with the lowest mean cost over the last up to
 * `window` exogenous events. A proposal replaces the incumbent only if
 * `window * (mean_incumbent - mean_proposal)` exceeds the transition price.
 * Equality retains the incumbent, matching the archived comparator. During
 * warmup the available shorter history is used with the same forecast horizon.
 */
export class PricedWindow {
  private readonly migration: number[][];
  private active: number;
  private readonly window: number;
  private readonly history: number[][] = [];
  private round = 0;
  private pending: number | null = null;
  private service = 0;
  private switchCost = 0;
  private switches = 0;

  constructor(
    migrationInput: readonly (readonly number[])[],
    opts: { readonly initial?: number; readonly window?: number } = {},
  ) {
    const initial = opts.initial ?? 0;
    const window = opts.window ?? 64;
    const m = validateMigration(migrationInput);
    if (!Number.isInteger(initial) || initial < 0 || initial >= m.length) {
      throw new Error('invalid initial layout');
    }
    if (!Number.isInteger(window) || window < 1) {
      throw new Error('invalid window');
    }
    this.migration = m;
    this.active = initial;
    this.window = window;
  }

  /** Select the layout for the current event. Must precede observe(). */
  choose(): number {
    if (this.pending !== null) {
      throw new Error('observe the current event first');
    }
    let chosen = this.active;
    if (this.history.length > 0) {
      const means = meanRows(this.history, this.migration.length);
      let proposal = 0;
      let best = means[0];
      for (let i = 1; i < means.length; i++) {
        if (means[i] < best) {
          best = means[i];
          proposal = i;
        }
      }
      const gain = this.window * (means[this.active] - means[proposal]);
      if (gain > this.migration[this.active][proposal]) {
        chosen = proposal;
      }
    }
    this.pending = chosen;
    return chosen;
  }

  /** Observe the full-information cost vector for the current event. */
  observe(costs: readonly number[]): PricedEventRecord {
    if (this.pending === null) {
      throw new Error('choose before observe');
    }
    validateCostVector(costs, this.migration.length);
    const chosen = this.pending;
    const price = this.migration[this.active][chosen];
    const rec: PricedEventRecord = {
      round: this.round,
      chosen,
      serviceBytes: costs[chosen],
      switchBytes: price,
    };
    this.service += costs[chosen];
    this.switchCost += price;
    this.switches += chosen !== this.active ? 1 : 0;
    this.active = chosen;
    this.pending = null;
    this.round += 1;
    this.history.push(costs.slice());
    if (this.history.length > this.window) {
      this.history.shift();
    }
    return rec;
  }

  /** Serialize checkpoint state; valid only between events. */
  state(): PricedWindowState {
    if (this.pending !== null) {
      throw new Error('checkpoint only between events');
    }
    return {
      schema: 'priced-window-1' as const,
      migration: this.migration.map((row) => row.slice()),
      active: this.active,
      window: this.window,
      history: this.history.map((row) => row.slice()),
      round: this.round,
      service: this.service,
      switchCost: this.switchCost,
      switches: this.switches,
    };
  }

  /** Restore a checkpoint at an event boundary. */
  static resume(s: PricedWindowState): PricedWindow {
    if (typeof s !== 'object' || s === null || (s as { schema?: unknown }).schema !== 'priced-window-1') {
      throw new Error('invalid schema');
    }
    const o = new PricedWindow(s.migration, { initial: s.active, window: s.window });
    if (!Number.isInteger(s.round) || s.round < 0
      || !Number.isInteger(s.switches) || s.switches < 0 || s.switches > s.round) {
      throw new Error('invalid counters');
    }
    if (!Array.isArray(s.history) || s.history.length !== Math.min(s.round, s.window)) {
      throw new Error('inconsistent history');
    }
    for (const v of s.history) {
      validateCostVector(v, o.migration.length);
      o.history.push(v.slice());
    }
    for (const k of ['service', 'switchCost'] as const) {
      if (typeof s[k] === 'boolean' || !isFiniteNumber(s[k]) || s[k] < 0) {
        throw new Error('invalid ledger');
      }
    }
    o.round = s.round;
    o.service = s.service;
    o.switchCost = s.switchCost;
    o.switches = s.switches;
    return o;
  }

  /** Number of completed events so far. */
  get rounds(): number {
    return this.round;
  }

  /** Cumulative service bytes charged in the chosen layout each event. */
  get serviceBytes(): number {
    return this.service;
  }

  /** Cumulative switch bytes charged for accepted migrations. */
  get switchBytes(): number {
    return this.switchCost;
  }

  /** Cumulative number of accepted layout switches. */
  get switchCount(): number {
    return this.switches;
  }

  /** Currently active layout index. */
  get activeIndex(): number {
    return this.active;
  }
}
