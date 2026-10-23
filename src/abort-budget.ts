/**
 * Cancellation and time limits for a conversion (`signal` / `timeoutMs`).
 *
 * Replay is synchronous CPU work, so a timer or an `abort()` from another
 * task can only be observed if the work stops to let the event loop run.
 * Two mechanisms cover that:
 *
 * - {@link checkBudget} runs at every record (and in a few long inner loops)
 *   and throws once the signal is aborted or the `timeoutMs` deadline has
 *   passed. A deadline needs no event loop: it is compared with the clock.
 * - The record loops are generators; when the caller supplied a `signal`
 *   they yield to the event loop about every {@link SLICE_MS} ms
 *   ({@link yieldDue}), which is what lets `AbortSignal.timeout()` timers
 *   and `controller.abort()` calls from other tasks fire mid-replay. Without
 *   a `signal` nothing ever yields, so replay stays one uninterrupted run.
 *
 * Once a budget trips it stays tripped, and {@link runSliced} rethrows the
 * reason after the slice even if a `catch` inside the replay swallowed the
 * first throw, so an abort can never be mistaken for a "not a valid
 * metafile" `null`.
 *
 * @module abort-budget
 */

/** How long replay runs before it yields to the event loop (with a `signal`). */
const SLICE_MS = 16;

/** The cancellation options of a conversion. */
export interface BudgetOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** One conversion's limits; shared by the nested conversions it starts. */
export class Budget {
	readonly signal: AbortSignal | undefined;
	private readonly deadline: number;
	private readonly timeoutMs: number | undefined;
	/** True when the record loops should yield to the event loop. */
	readonly yields: boolean;
	sliceStart = 0;
	/** The rejection reason once the budget has run out. */
	private reason: { value: unknown } | null = null;

	constructor(options: BudgetOptions) {
		this.signal = options.signal;
		this.timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs >= 0 ? options.timeoutMs : undefined;
		this.deadline = this.timeoutMs === undefined ? Infinity : performance.now() + this.timeoutMs;
		this.yields = !!this.signal;
	}

	/** Throws the rejection reason when the signal is aborted or the time is up. */
	check(): void {
		if (this.reason) {
			throw this.reason.value;
		}
		if (this.signal?.aborted) {
			this.reason = { value: this.signal.reason };
		} else if (performance.now() > this.deadline) {
			this.reason = { value: timeoutError() };
		} else {
			return;
		}
		throw this.reason.value;
	}

	/** Rethrows the reason if the budget has tripped (also when the throw was swallowed). */
	throwIfTripped(): void {
		if (this.reason) {
			throw this.reason.value;
		}
	}

	get tripped(): boolean {
		return this.reason !== null;
	}

	/** Options for a nested conversion that must share this budget. */
	remaining(): BudgetOptions {
		return {
			signal: this.signal,
			timeoutMs: this.timeoutMs === undefined ? undefined : Math.max(0, this.deadline - performance.now()),
		};
	}
}

function timeoutError(): unknown {
	return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/** Internal option key carrying the shared budget into nested entry points. */
export const BUDGET = Symbol('emf-converter.budget');

/**
 * The budget of a call: the one an outer call already made (nested
 * conversions), else a new one when `options` ask for a limit, else `null`.
 */
export function budgetFor(options: (BudgetOptions & { [BUDGET]?: Budget }) | undefined): Budget | null {
	if (!options) {
		return null;
	}
	if (options[BUDGET]) {
		return options[BUDGET];
	}
	if (options.signal === undefined && options.timeoutMs === undefined) {
		return null;
	}
	return new Budget(options);
}

let active: Budget | null = null;

/** Stops the work if the running conversion's budget is spent; free without one. */
export function checkBudget(): void {
	if (active) {
		active.check();
	}
}

/** True when the record loop should hand the thread back to the event loop now. */
export function yieldDue(): boolean {
	return active !== null && active.yields && performance.now() - active.sliceStart > SLICE_MS;
}

/** Runs one synchronous slice of work with `budget` as the running conversion's. */
function runSlice<T>(budget: Budget, work: () => T): T {
	const outer = active;
	active = budget;
	budget.sliceStart = performance.now();
	try {
		budget.check();
		const result = work();
		budget.throwIfTripped();
		return result;
	} finally {
		active = outer;
	}
}

/** Runs a synchronous section under `budget` (or plainly without one). */
export function runSync<T>(budget: Budget | null, work: () => T): T {
	return budget ? runSlice(budget, work) : work();
}

/** Lets timers and other tasks run (macrotask, so an `AbortSignal.timeout` can fire). */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drives a replay generator to its result. Without a budget (or a signal)
 * the generator never yields and this is one synchronous run; otherwise each
 * `yield` gives the event loop a turn, after which the signal is re-read.
 */
export async function runSliced<T>(budget: Budget | null, generator: Generator<void, T>): Promise<T> {
	for (;;) {
		const step = runSync(budget, () => generator.next());
		if (step.done) {
			return step.value;
		}
		await yieldToEventLoop();
		budget?.check();
	}
}

/** Drives a replay generator to completion synchronously (yields ignored). */
export function runToEnd<T>(generator: Generator<void, T>): T {
	for (;;) {
		const step = generator.next();
		if (step.done) {
			return step.value;
		}
	}
}
