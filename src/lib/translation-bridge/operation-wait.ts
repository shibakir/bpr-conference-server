import { TranslationControlError } from "../translation-control";

/** Every operation wait is bounded by the same abort signal, including native SDK promises. */
export function withOperationSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new TranslationControlError("stopped"));
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

export async function waitUntil(check: () => boolean, signal: AbortSignal): Promise<void> {
    while (!check()) {
        await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            const timer = setTimeout(done, 20);
            function done() {
                signal.removeEventListener("abort", abort);
                resolve();
            }
            function abort() {
                clearTimeout(timer);
                reject(signal.reason);
            }
            signal.addEventListener("abort", abort, { once: true });
        });
    }
    if (signal.aborted) throw signal.reason;
}
