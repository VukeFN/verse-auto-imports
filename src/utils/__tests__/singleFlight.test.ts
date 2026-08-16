import { singleFlight } from "../singleFlight";

describe("singleFlight", () => {
    it("shares one run among overlapping calls", async () => {
        let runs = 0;
        let release: (value: string) => void = () => {};
        const wrapped = singleFlight(() => {
            runs++;
            return new Promise<string>((resolve) => {
                release = resolve;
            });
        });

        const first = wrapped();
        const second = wrapped();
        release("done");

        expect(await first).toBe("done");
        expect(await second).toBe("done");
        expect(runs).toBe(1);
    });

    it("starts a fresh run after the shared one settles", async () => {
        let runs = 0;
        const wrapped = singleFlight(async () => ++runs);

        expect(await wrapped()).toBe(1);
        expect(await wrapped()).toBe(2);
    });

    it("starts a fresh run after a reset instead of joining the dropped one", async () => {
        let runs = 0;
        const releases: Array<() => void> = [];
        const wrapped = singleFlight(() => {
            const run = ++runs;
            return new Promise<number>((resolve) => {
                releases.push(() => resolve(run));
            });
        });

        const dropped = wrapped();
        wrapped.reset();
        const fresh = wrapped();
        expect(wrapped()).toBe(fresh);

        // The dropped run settles first; that must not clear the fresh
        // run's memo.
        releases[0]();
        expect(await dropped).toBe(1);
        expect(wrapped()).toBe(fresh);

        releases[1]();
        expect(await fresh).toBe(2);
        expect(runs).toBe(2);
    });

    it("propagates rejection to every sharer and stays retryable", async () => {
        let attempts = 0;
        const wrapped = singleFlight(async () => {
            attempts++;
            if (attempts === 1) {
                throw new Error("first run fails");
            }
            return attempts;
        });

        const first = wrapped();
        const second = wrapped();

        await expect(first).rejects.toThrow("first run fails");
        await expect(second).rejects.toThrow("first run fails");
        expect(await wrapped()).toBe(2);
    });
});
