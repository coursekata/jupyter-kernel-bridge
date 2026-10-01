# @coursekata/jupyter-kernel-client

Start and control Jupyter kernels from a page embedding JupyterLab or JupyterLite.
This host client uses Comlink for remote calls to the companion
[`@coursekata/jupyter-kernel-bridge`](../extension/README.md) extension,
which owns the native Jupyter kernel operations.

There is no dependency on `jupyter-iframe-commands`, console widgets, CKCode, or
another command provider. The npm package has ordinary dependencies and no peer
dependencies. The hosting Jupyter application supplies its shared APIs and
installed language kernels; this package does not ship R, Python or their packages.

## Install

Install the npm package in the embedding application:

Configure the consumer's `.npmrc` with the GitHub Packages scope and authenticate
with an account or CI token that has read access:

```ini
@coursekata:registry=https://npm.pkg.github.com
```

Keep credentials in the user/CI npm configuration, outside source control.

```sh
npm install @coursekata/jupyter-kernel-client
```

Install the matching extension in the environment that builds JupyterLite
or runs JupyterLab:

```sh
uv add git+https://github.com/coursekata/jupyter-kernel-bridge --tag v0.1.1
jupyter lite build
```

The source install builds a wheel containing the JavaScript extension. It does not run Python on
the server for kernel execution. JupyterLite still serves static assets and runs
its kernels in the browser. Normal top-level notebooks do not activate the bridge.

## Use

```js
import { KernelClient, kernelFrameURL } from '@coursekata/jupyter-kernel-client';

const frame = document.createElement('iframe');
frame.hidden = true;
frame.src = kernelFrameURL('https://your-jupyterlite-site.example/lab/index.html');
const client = new KernelClient(frame, { startupTimeoutMs: 90_000 });
document.body.append(frame);

const kernel = await client.start({ language: 'r' });
const reply = await client.execute(kernel.id, { code: '1 + 1' }, message => {
  // Native Jupyter IOPub messages: stream, display_data, error, clear_output, ...
  console.log(message);
});
console.log(reply.status); // ok, error, or abort

await client.restart(kernel.id);
await client.shutdown(kernel.id);
client.dispose();
frame.remove();
```

`start()` waits for readiness automatically. `client.ready` is also available.
Supply `name` instead of, or alongside, `language` to choose a specific installed
kernelspec. Kernel IDs belong to the connection that created them. The API cannot
attach to or stop someone else's notebook kernel.

| Method | Behavior |
|---|---|
| `listKernels()` | Return installed kernel names, languages and display names. |
| `start({name?, language?})` | Create an owned kernel and validate its reported language. |
| `execute(id, {code, silent?, storeHistory?, stopOnError?}, onOutput)` | Stream native messages and resolve with the native execution reply after output delivery. |
| `status(id)` | Read the kernel's current status. |
| `interrupt(id)` | Call the kernel's native interrupt operation. Support depends on the kernel and browser environment. |
| `restart(id)` | Cancel the old execution, restart the kernel and rerun configured startup code. |
| `shutdown(id)` | Shut down and release the owned kernel. |
| `dispose(reason?)` | Close the client and immediately reject pending calls; tell the endpoint to release its owned kernels. |

Each kernel accepts one execution or restart at a time. Interrupt and shutdown
remain available while it is executing. Different kernels can run concurrently.
Execution defaults to normal output, no history and stop-on-error. Interactive
stdin is disabled. Empty code and literal `clear` go to the kernel unchanged.
Learner errors resolve as an error reply; connection, lifecycle and output-consumer
errors reject the call.

The application owns the iframe. Call `dispose()` when removing or replacing it.
Native interrupt can be unsupported or ineffective for busy WASM kernels. To stop
such work reliably in JupyterLite, dispose the client and remove its iframe, then
create a replacement. The old client's pending calls reject immediately. This does
not promise to kill a remote server process if the server itself is unreachable.

## Connection and state

`kernelFrameURL()` adds the expected parent origin. The extension activates only
inside an iframe with that explicit parameter. Both sides check the other window
and exact origin during connection setup, then transfer a private `MessagePort`.
Comlink calls and callbacks use that port rather than a global command listener.
Each execution releases its output callback proxy; disposal closes the connection.

Consecutive executions share kernel state. This package does not reset variables,
install exercise packages, grade code or render output. Those are client policies.

A hosting site can set `kernelBridgeStartup` in `jupyter-config-data` to a mapping
from kernel names or lowercase languages to trusted startup code. It runs after start and
restart and must succeed before the operation resolves. Kernel-name entries take
precedence over language entries.

## Build and package

See the [repository instructions](../../README.md#development).
