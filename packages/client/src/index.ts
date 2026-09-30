import { proxy, releaseProxy, wrap } from 'comlink';
import type { Remote } from 'comlink';
import { CHANNEL, PARENT_ORIGIN_PARAM, VERSION } from './protocol.js';
import type {
  ExecuteReply,
  ExecuteRequest,
  KernelAPI,
  KernelOutput,
  KernelSelection
} from './protocol.js';
export type {
  ExecuteReply,
  ExecuteRequest,
  KernelIdentity,
  KernelOutput,
  KernelSelection,
  KernelSpec
} from './protocol.js';

/** Configure the iframe before navigating it. The endpoint activates only here. */
export function kernelFrameURL(url: string | URL, parentOrigin = location.origin): string {
  const target = new URL(url, document.baseURI);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !['http:', 'https:'].includes(new URL(parentOrigin).protocol) ||
    new URL(parentOrigin).origin !== parentOrigin
  )
    throw new Error('Kernel frames require HTTP(S) origins.');
  target.searchParams.set(PARENT_ORIGIN_PARAM, parentOrigin);
  return target.href;
}

/** Owns an RPC connection; the embedding application owns the iframe element. */
export class KernelClient {
  readonly ready: Promise<void>;
  private remote?: Remote<KernelAPI>;
  private port?: MessagePort;
  private closed = false;
  private closeReason = new Error('Kernel connection was closed.');
  private readonly pending = new Set<(reason: Error) => void>();
  private readonly connection = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  private readonly origin: string;
  private cleanupHandshake = () => {};

  constructor(frame: HTMLIFrameElement, options: { startupTimeoutMs?: number } = {}) {
    this.origin = new URL(frame.src, document.baseURI).origin;
    const timeout = options.startupTimeoutMs ?? 90000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('Invalid kernel startup timeout.');
    this.ready = this.track(
      () =>
        new Promise<void>((resolve, reject) => {
          let connected = false;
          const hello = () => {
            const target = frame.contentWindow;
            // WebKit can attribute an optional-chained postMessage call to the
            // target iframe, causing its parent-window identity check to fail.
            if (target)
              target.postMessage(
                { channel: CHANNEL, type: 'hello', version: VERSION, connection: this.connection },
                this.origin
              );
          };
          const receive = (event: MessageEvent) => {
            if (
              connected ||
              event.source !== frame.contentWindow ||
              event.origin !== this.origin ||
              event.data?.channel !== CHANNEL ||
              event.data.connection !== this.connection ||
              event.data.type !== 'ready'
            )
              return;
            if (event.data.version !== VERSION) {
              this.dispose(new Error('Incompatible kernel bridge version.'));
              return;
            }
            connected = true;
            const channel = new MessageChannel();
            this.port = channel.port1;
            this.remote = wrap<KernelAPI>(channel.port1);
            frame.contentWindow!.postMessage(
              { channel: CHANNEL, type: 'connect', version: VERSION, connection: this.connection },
              this.origin,
              [channel.port2]
            );
            void this.remote
              .ready()
              .then((result) => {
                if (result.version !== VERSION)
                  throw new Error('Incompatible kernel bridge version.');
                this.cleanupHandshake();
                resolve();
              })
              .catch((error) => {
                reject(error);
                this.dispose(error);
              });
          };
          const interval = setInterval(hello, 200);
          const timer = setTimeout(
            () =>
              this.dispose(
                new Error('JupyterLite startup timed out. Check the runtime URL and assets.')
              ),
            timeout
          );
          this.cleanupHandshake = () => {
            clearInterval(interval);
            clearTimeout(timer);
            window.removeEventListener('message', receive);
            frame.removeEventListener('load', hello);
          };
          window.addEventListener('message', receive);
          frame.addEventListener('load', hello);
          hello();
        })
    );
    // Consumers may call start() directly or dispose before awaiting readiness.
    void this.ready.catch(() => undefined);
  }

  listKernels() {
    return this.call((remote) => remote.listKernels());
  }
  start(selection: KernelSelection) {
    return this.call((remote) => remote.start(selection));
  }
  execute(
    id: string,
    request: ExecuteRequest,
    onOutput: (message: KernelOutput) => void | Promise<void>
  ) {
    return this.call<ExecuteReply>((remote) =>
      remote.execute(
        id,
        request,
        proxy(async (message) => {
          if (!this.closed) await onOutput(message);
        })
      )
    );
  }
  interrupt(id: string) {
    return this.call((remote) => remote.interrupt(id));
  }
  restart(id: string) {
    return this.call((remote) => remote.restart(id));
  }
  shutdown(id: string) {
    return this.call((remote) => remote.shutdown(id));
  }
  status(id: string) {
    return this.call((remote) => remote.status(id));
  }

  /** Reject callers immediately, even when a WASM worker cannot cooperate. */
  dispose(reason = new Error('Kernel connection was closed.')): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.cleanupHandshake();
    for (const reject of this.pending) reject(reason);
    this.pending.clear();
    if (this.remote) this.remote[releaseProxy]();
    this.port?.close();
  }

  private call<T>(operation: (remote: Remote<KernelAPI>) => Promise<T>): Promise<T> {
    return this.track(async () => {
      await this.ready;
      this.assertOpen();
      return operation(this.remote!);
    });
  }
  private assertOpen() {
    if (this.closed) throw this.closeReason;
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason);
        return;
      }
      this.pending.add(reject);
      void Promise.resolve()
        .then(() => {
          this.assertOpen();
          return operation();
        })
        .then(resolve, reject)
        .finally(() => this.pending.delete(reject));
    });
  }
}
