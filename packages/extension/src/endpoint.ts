import { expose, finalizer } from 'comlink';
import { CHANNEL, VERSION } from '@coursekata/jupyter-kernel-client/protocol';
import type { KernelAPI } from '@coursekata/jupyter-kernel-client/protocol';

export function validOrigin(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

/** Bind one private RPC port to the embedding parent, never the global bus. */
export function installKernelEndpoint(
  host: Window,
  parentOrigin: string,
  createService: () => KernelAPI
): () => void {
  if (!validOrigin(parentOrigin)) throw new Error('An HTTP(S) parent origin is required.');
  let active: { service: KernelAPI; port: MessagePort } | undefined;
  let closed = false;
  const receive = (event: MessageEvent) => {
    if (closed || active || event.source !== host.parent || event.origin !== parentOrigin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || typeof data.connection !== 'string') return;
    if (data.type === 'hello') {
      host.parent.postMessage(
        { channel: CHANNEL, version: VERSION, type: 'ready', connection: data.connection },
        parentOrigin
      );
    } else if (data.type === 'connect' && data.version === VERSION && event.ports.length === 1) {
      const service = createService();
      const port = event.ports[0];
      active = { service, port };
      // A plain facade exposes only our supported kernel API, not class internals.
      expose(
        {
          ready: () => service.ready(),
          listKernels: () => service.listKernels(),
          start: service.start.bind(service),
          execute: service.execute.bind(service),
          interrupt: service.interrupt.bind(service),
          restart: service.restart.bind(service),
          shutdown: service.shutdown.bind(service),
          status: service.status.bind(service),
          dispose: () => service.dispose(),
          [finalizer]: () => {
            void service.dispose();
            active = undefined;
          }
        },
        port
      );
    }
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    host.removeEventListener('message', receive);
    host.removeEventListener('pagehide', dispose);
    if (active) {
      void active.service.dispose();
      active.port.close();
      active = undefined;
    }
  };
  host.addEventListener('message', receive);
  host.addEventListener('pagehide', dispose);
  return dispose;
}
