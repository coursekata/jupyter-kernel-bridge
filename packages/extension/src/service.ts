import type { Kernel, KernelMessage, ServiceManager } from '@jupyterlab/services';
import { releaseProxy } from 'comlink';
import type { Remote } from 'comlink';
import { VERSION } from '@coursekata/jupyter-kernel-client/protocol';
import type {
  ExecuteReply,
  ExecuteRequest,
  KernelAPI,
  KernelIdentity,
  KernelOutput,
  KernelSelection,
  KernelSpec
} from '@coursekata/jupyter-kernel-client/protocol';

type ExecuteFuture = Kernel.IShellFuture<
  KernelMessage.IExecuteRequestMsg,
  KernelMessage.IExecuteReplyMsg
>;

interface OwnedKernel {
  kernel: Kernel.IKernelConnection;
  identity: KernelIdentity;
  future?: ExecuteFuture;
  busy: boolean;
}

/** Kernel ownership and native Jupyter calls; no exercise or UI policy. */
export class KernelService implements KernelAPI {
  private readonly kernels = new Map<string, OwnedKernel>();
  private readonly starting = new Set<Promise<KernelIdentity>>();
  private disposed = false;
  private readonly closed: Promise<never>;
  private rejectClosed!: (reason: Error) => void;

  constructor(
    private readonly manager: ServiceManager.IManager,
    private readonly started: Promise<unknown> = Promise.resolve(),
    private readonly startup: Readonly<Record<string, string>> = {}
  ) {
    this.closed = new Promise((_, reject) => {
      this.rejectClosed = reject;
    });
    void this.closed.catch(() => undefined);
  }

  async ready() {
    await Promise.race([Promise.all([this.started, this.manager.ready]), this.closed]);
    this.assertOpen();
    return { version: VERSION };
  }

  async listKernels(): Promise<KernelSpec[]> {
    await this.ready();
    await this.manager.kernelspecs.refreshSpecs();
    return Object.values(this.manager.kernelspecs.specs?.kernelspecs ?? {})
      .filter((spec) => !!spec)
      .map((spec) => ({
        name: spec!.name,
        language: spec!.language,
        displayName: spec!.display_name
      }));
  }

  start(selection: KernelSelection): Promise<KernelIdentity> {
    const pending = this.create(selection);
    this.starting.add(pending);
    void pending.then(
      () => this.starting.delete(pending),
      () => this.starting.delete(pending)
    );
    return pending;
  }

  private async create(selection: KernelSelection): Promise<KernelIdentity> {
    if (!selection || (!selection.name && !selection.language))
      throw new Error('Select a kernel by name or language.');
    const specs = await this.listKernels();
    const spec = specs.find(
      (spec) =>
        (!selection.name || spec.name === selection.name) &&
        (!selection.language || spec.language.toLowerCase() === selection.language.toLowerCase())
    );
    if (!spec) throw new Error('No installed kernel matches the requested name or language.');
    this.assertOpen();
    const kernel = await this.manager.kernels.startNew({ name: spec.name });
    try {
      this.assertOpen();
      await this.initialize(kernel, spec.language);
      this.assertOpen();
      const identity = { ...spec, id: kernel.id };
      this.kernels.set(kernel.id, { kernel, identity, busy: false });
      return identity;
    } catch (error) {
      await this.retire(kernel);
      throw error;
    }
  }

  private async initialize(kernel: Kernel.IKernelConnection, language: string) {
    const info = await Promise.race([kernel.info, this.closed]);
    if (info?.status !== 'ok' || info.language_info.name.toLowerCase() !== language.toLowerCase()) {
      throw new Error('The kernel did not report the requested language.');
    }
    const code = this.startup[kernel.name] ?? this.startup[language.toLowerCase()];
    if (!code?.trim()) return;
    const future = kernel.requestExecute({
      code,
      silent: false,
      store_history: false,
      allow_stdin: false
    });
    try {
      const reply = await Promise.race([future.done, this.closed]);
      if (reply.content.status !== 'ok') throw new Error('Kernel startup code failed.');
    } finally {
      future.dispose();
    }
  }

  async execute(
    id: string,
    request: ExecuteRequest,
    onOutput: (message: KernelOutput) => Promise<void>
  ): Promise<ExecuteReply> {
    let owned: OwnedKernel | undefined;
    let future: ExecuteFuture | undefined;
    let acquired = false;
    let disconnectOutput = () => {};
    try {
      owned = this.get(id);
      if (owned.busy) throw new Error('A kernel operation is already in progress.');
      if (!request || typeof request.code !== 'string') throw new Error('Execution requires code.');
      owned.busy = true;
      acquired = true;
      future = owned.kernel.requestExecute({
        code: request.code,
        silent: request.silent ?? false,
        store_history: request.storeHistory ?? false,
        allow_stdin: false,
        stop_on_error: request.stopOnError ?? true
      });
      owned.future = future;
      let outputFailure: { reason: unknown } | undefined;
      let delivery = Promise.resolve();
      const requestId = future.msg.header.msg_id;
      // Native futures reroute display updates to the original display's future,
      // which may already be disposed. Observe the execution's messages before
      // that routing, and serialize callbacks to preserve output order.
      const receive = (_: Kernel.IKernelConnection, { msg, direction }: Kernel.IAnyMessageArgs) => {
        if (direction !== 'recv' || msg.channel !== 'iopub' || msg.parent_header.msg_id !== requestId) return;
        delivery = delivery.then(async () => {
          try {
            await onOutput(msg as KernelOutput);
          } catch (error) {
            outputFailure ??= { reason: error };
          }
        });
      };
      owned.kernel.anyMessage.connect(receive);
      disconnectOutput = () => owned!.kernel.anyMessage.disconnect(receive);
      future.onIOPub = () => delivery;
      const reply = await future.done;
      await delivery;
      if (outputFailure) throw outputFailure.reason;
      return reply.content;
    } finally {
      disconnectOutput();
      future?.dispose();
      if (owned && acquired && owned.future === future) {
        owned.future = undefined;
        owned.busy = false;
      }
      // The RPC endpoint and service use the same Comlink instance. Local
      // consumers may provide an ordinary callback without a proxy.
      const remote = onOutput as Remote<typeof onOutput>;
      if (remote?.[releaseProxy]) remote[releaseProxy]();
    }
  }

  async interrupt(id: string) {
    await this.get(id).kernel.interrupt();
  }

  async restart(id: string): Promise<KernelIdentity> {
    const owned = this.get(id);
    // Disposing the old future settles its caller before native restart.
    if (owned.busy && !owned.future) throw new Error('The kernel is already restarting.');
    owned.future?.dispose();
    owned.future = undefined;
    owned.busy = true;
    try {
      await owned.kernel.restart();
      await this.initialize(owned.kernel, owned.identity.language);
      if (this.get(id) !== owned) throw new Error('Kernel was closed during restart.');
      return owned.identity;
    } catch (error) {
      this.kernels.delete(id);
      await this.retire(owned.kernel);
      throw error;
    } finally {
      owned.busy = false;
    }
  }

  async shutdown(id: string) {
    const owned = this.get(id);
    this.kernels.delete(id);
    owned.future?.dispose();
    try {
      await owned.kernel.shutdown();
    } finally {
      owned.kernel.dispose();
    }
  }

  async status(id: string) {
    return this.get(id).kernel.status;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectClosed(new Error('Kernel connection is closed.'));
    const kernels = [...this.kernels.values()];
    this.kernels.clear();
    await Promise.allSettled(
      kernels.map(async (owned) => {
        owned.future?.dispose();
        await this.retire(owned.kernel);
      })
    );
    await Promise.allSettled([...this.starting]);
  }

  private assertOpen() {
    if (this.disposed) throw new Error('Kernel connection is closed.');
  }
  private get(id: string) {
    this.assertOpen();
    const owned = this.kernels.get(id);
    if (!owned || owned.kernel.isDisposed) throw new Error('Unknown or closed kernel.');
    return owned;
  }
  private async retire(kernel: Kernel.IKernelConnection) {
    try {
      await kernel.shutdown();
    } catch {
      /* Always release the owned connection. */
    } finally {
      kernel.dispose();
    }
  }
}
