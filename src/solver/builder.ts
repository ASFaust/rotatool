/**
 * builder.ts — a small typed model builder that emits CPLEX LP format for HiGHS.
 *
 * Formulation code (formulation.ts) adds variables and linear constraints
 * through this builder; `toLP()` serializes to the LP text that highs-js solves.
 * Variables get short generated names (`v0`, `v1`, …) so arbitrary entity ids
 * never have to be LP-safe; callers keep the returned name to read the solution
 * back via `valueOf`.
 */

export type Op = "<=" | ">=" | "=";
export type Sense = "max" | "min";

/** A linear expression as (variable name, coefficient) pairs. */
export type Term = [name: string, coef: number];

interface Constraint {
  name: string;
  terms: Term[];
  op: Op;
  rhs: number;
  /** What part of the formulation produced it (for the stats census). */
  kind: string;
}

/** Model size counters, for logging/difficulty diagnostics. */
export interface LpStats {
  binaries: number;
  integers: number;
  continuous: number;
  constraints: number;
  /** Total constraint-matrix nonzeros (sum of terms over all constraints). */
  nonzeros: number;
  /** Census per constraint kind, sorted by count descending. */
  constraintKinds: Record<string, { count: number; nonzeros: number }>;
}

export class LpBuilder {
  private counter = 0;
  private binaries: string[] = [];
  private integers: string[] = [];
  private bounds = new Map<string, { lb: number; ub: number }>();
  private constraints: Constraint[] = [];
  private objective: Term[] = [];
  private sense: Sense = "max";
  private conCounter = 0;

  /** A new binary (0/1) variable. */
  addBinary(): string {
    const name = `v${this.counter++}`;
    this.binaries.push(name);
    return name;
  }

  /** A new integer variable with bounds. */
  addInteger(lb: number, ub: number): string {
    const name = `v${this.counter++}`;
    this.integers.push(name);
    this.bounds.set(name, { lb, ub });
    return name;
  }

  /**
   * A new continuous variable with bounds.
   *
   * WARNING: HiGHS 1.14.2 presolve mis-pins continuous auxiliary variables
   * that appear in one constraint + the objective (column singletons),
   * silently returning sub-optimal solutions as "Optimal" — repro in
   * scripts/presolve-bug.mts. Rule: a continuous aux var is safe iff it
   * appears in ≥2 constraints or has no objective coefficient; potential
   * singletons (e.g. workload `over`, required `short`) must use addInteger
   * (scaling units if needed, e.g. hours → minutes). Don't blanket-integerize:
   * hundreds of integer aux vars stall MIP incumbent finding (the day-subtotal
   * layer at month ranges went from "no roster in 30s" to near-optimal by
   * going continuous).
   */
  addContinuous(lb: number, ub: number): string {
    const name = `v${this.counter++}`;
    this.bounds.set(name, { lb, ub });
    return name;
  }

  /** Add a linear constraint `sum(terms) op rhs`, tagged with its origin. */
  addConstraint(terms: Term[], op: Op, rhs: number, kind = "other"): void {
    if (terms.length === 0) return;
    this.constraints.push({ name: `c${this.conCounter++}`, terms, op, rhs, kind });
  }

  /** Set the objective; later calls replace earlier ones. */
  setObjective(sense: Sense, terms: Term[]): void {
    this.sense = sense;
    this.objective = terms;
  }

  /** Add terms onto the objective (accumulates across calls). */
  addObjectiveTerms(terms: Term[]): void {
    this.objective.push(...terms);
  }

  setSense(sense: Sense): void {
    this.sense = sense;
  }

  /** Current model size (integers also carry bounds, hence the subtraction). */
  stats(): LpStats {
    const byKind = new Map<string, { count: number; nonzeros: number }>();
    for (const c of this.constraints) {
      const e = byKind.get(c.kind) ?? byKind.set(c.kind, { count: 0, nonzeros: 0 }).get(c.kind)!;
      e.count++;
      e.nonzeros += c.terms.length;
    }
    return {
      binaries: this.binaries.length,
      integers: this.integers.length,
      continuous: this.bounds.size - this.integers.length,
      constraints: this.constraints.length,
      nonzeros: this.constraints.reduce((s, c) => s + c.terms.length, 0),
      constraintKinds: Object.fromEntries([...byKind].sort((a, b) => b[1].count - a[1].count)),
    };
  }

  /** Read a variable's value from a HiGHS solution (rounded for integrality). */
  static valueOf(solution: HighsLikeSolution, name: string): number {
    const col = solution.Columns?.[name];
    if (!col) return 0;
    return Math.round(col.Primal);
  }

  /** Serialize to CPLEX LP format. */
  toLP(): string {
    const lines: string[] = [];
    lines.push(this.sense === "max" ? "Maximize" : "Minimize");
    lines.push(` obj: ${fmtExpr(this.objective)}`);

    lines.push("Subject To");
    for (const c of this.constraints) {
      lines.push(` ${c.name}: ${fmtExpr(c.terms)} ${c.op} ${num(c.rhs)}`);
    }

    // Bounds for non-binary vars (binaries are implicitly 0..1).
    const boundLines: string[] = [];
    for (const [name, b] of this.bounds) {
      boundLines.push(` ${num(b.lb)} <= ${name} <= ${num(b.ub)}`);
    }
    if (boundLines.length > 0) {
      lines.push("Bounds");
      lines.push(...boundLines);
    }

    if (this.integers.length > 0) {
      lines.push("General");
      lines.push(` ${this.integers.join(" ")}`);
    }
    if (this.binaries.length > 0) {
      lines.push("Binary");
      lines.push(` ${this.binaries.join(" ")}`);
    }

    lines.push("End");
    return lines.join("\n");
  }
}

/** Minimal shape of a HiGHS solution we read from. */
export interface HighsLikeSolution {
  Status: string;
  ObjectiveValue?: number;
  Columns?: Record<string, { Primal: number }>;
}

function num(n: number): string {
  // Avoid scientific notation; LP readers want plain decimals.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Format a linear expression into LP text, e.g. "3 v0 - v1 + 2 v2".
 *
 * Duplicate variables are summed here: the HiGHS LP reader does *not* add up
 * repeated entries ("v0 + 0.5 v0" parses as 0.5·v0, not 1.5·v0), and callers
 * legitimately push the same variable from several objective terms (coverage +
 * preferences + breaks).
 */
function fmtExpr(terms: Term[]): string {
  if (terms.length > 1) {
    const sums = new Map<string, number>();
    for (const [name, coef] of terms) sums.set(name, (sums.get(name) ?? 0) + coef);
    if (sums.size < terms.length) terms = [...sums];
  }
  const parts: string[] = [];
  for (const [name, coef] of terms) {
    if (coef === 0) continue;
    const a = Math.abs(coef);
    const body = a === 1 ? name : `${num(a)} ${name}`;
    parts.push(`${coef < 0 ? "-" : "+"} ${body}`);
  }
  if (parts.length === 0) return "0";
  const s = parts.join(" ");
  return s.startsWith("+ ") ? s.slice(2) : s;
}
