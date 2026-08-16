/**
 * Wraps an async operation so overlapping calls share one run.
 *
 * The first call starts `run()`; every call that arrives while it is pending
 * gets the same promise, rejection included. Once the run settles, the memo is
 * cleared, so the next call starts a fresh run - which is what keeps a failed
 * run retryable.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
    let inFlight: Promise<T> | null = null;

    return () => {
        if (!inFlight) {
            const flight = run().finally(() => {
                // Identity-checked so a wrapper reset while this run was
                // pending does not clobber the run that replaced it.
                if (inFlight === flight) {
                    inFlight = null;
                }
            });
            inFlight = flight;
        }

        return inFlight;
    };
}
