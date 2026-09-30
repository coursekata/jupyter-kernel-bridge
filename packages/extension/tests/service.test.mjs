import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KernelService } from '../lib/service.js';
import { Signal } from '@lumino/signaling';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function harness(startup = {}) {
  const created = [];
  const manager = {
    ready: Promise.resolve(),
    kernelspecs: {
      refreshSpecs: async () => {},
      specs: {
        kernelspecs: {
          r: { name: 'xr', language: 'R', display_name: 'R' },
          python: { name: 'python', language: 'python', display_name: 'Python' }
        }
      }
    },
    kernels: {
      startNew: async ({ name }) => {
        const kernel = {
          id: 'kernel-' + created.length,
          name,
          status: 'idle',
          info: Promise.resolve({
            status: 'ok',
            language_info: { name: name === 'xr' ? 'R' : 'python' }
          }),
          isDisposed: false,
          anyMessage: undefined,
          requests: [],
          restarts: 0,
          interrupts: 0,
          shutdowns: 0,
          restart: async () => {
            kernel.restarts++;
          },
          interrupt: async () => {
            kernel.interrupts++;
          },
          shutdown: async () => {
            kernel.shutdowns++;
          },
          dispose: () => {
            kernel.isDisposed = true;
          },
          requestExecute: (content) => {
            const done = deferred();
            done.promise.catch(() => {});
            const future = {
              msg: { header: { msg_id: `execution-${kernel.requests.length}` } },
              done: done.promise,
              onIOPub: undefined,
              disposed: false,
              emit: async (message) => {
                const msg = { channel: "iopub", parent_header: { msg_id: future.msg.header.msg_id }, ...message };
                kernel.anyMessage.emit({ msg, direction: "recv" });
                await future.onIOPub?.(msg);
              },
              finish: (status = 'ok') => done.resolve({ content: { status, execution_count: 1 } }),
              dispose: () => {
                future.disposed = true;
                done.reject(new Error('Cancelled execution'));
              }
            };
            kernel.requests.push({ content, future });
            if (content.code === 'startup()') queueMicrotask(() => future.finish());
            return future;
          }
        };
        kernel.anyMessage = new Signal(kernel);
        created.push(kernel);
        return kernel;
      }
    }
  };
  return { created, manager, service: new KernelService(manager, Promise.resolve(), startup) };
}

test('kernel selection, identity and ownership use installed specs', async () => {
  const h = harness();
  assert.equal((await h.service.listKernels()).length, 2);
  const r = await h.service.start({ language: 'r' });
  assert.equal(r.name, 'xr');
  const p = await h.service.start({ name: 'python' });
  assert.equal(p.language, 'python');
  await assert.rejects(h.service.start({ language: 'julia' }), /No installed/);
  await assert.rejects(h.service.start({ name: 'python', language: 'r' }), /No installed/);
  await assert.rejects(h.service.shutdown('somebody-elses-kernel'), /Unknown/);
  await h.service.dispose();
  assert.ok(h.created.every((k) => k.isDisposed && k.shutdowns === 1));
});

test('stream delivery is awaited and native execution options preserve literal code', async () => {
  const h = harness();
  const { id } = await h.service.start({ language: 'python' });
  const received = [];
  const output = deferred();
  const running = h.service.execute(id, { code: 'clear' }, async (message) => {
    await output.promise;
    received.push(message);
  });
  const { content, future } = h.created[0].requests[0];
  assert.deepEqual(content, {
    code: 'clear',
    silent: false,
    store_history: false,
    allow_stdin: false,
    stop_on_error: true
  });
  const delivering = future.emit({ header: { msg_type: 'stream' }, content: { text: 'first' } });
  assert.equal(received.length, 0);
  output.resolve();
  await delivering;
  future.finish();
  assert.equal((await running).status, 'ok');
  assert.equal(received.length, 1);
  assert.equal(future.disposed, true);
  await h.service.dispose();
});

test('overlapping execution is rejected without releasing the first operation', async () => {
  const h = harness();
  const { id } = await h.service.start({ language: 'r' });
  const first = h.service.execute(id, { code: 'long()' }, async () => {});
  await assert.rejects(
    h.service.execute(id, { code: 'second()' }, async () => {}),
    /in progress/
  );
  await assert.rejects(
    h.service.execute(id, { code: 'third()' }, async () => {}),
    /in progress/
  );
  h.created[0].requests[0].future.finish('error');
  assert.equal((await first).status, 'error');
  const next = h.service.execute(id, { code: 'next()' }, async () => {});
  h.created[0].requests[1].future.finish();
  await next;
  await h.service.dispose();
});

test('callback rejection fails the operation and leaves the kernel reusable', async () => {
  for (const reason of [new Error('consumer failed'), undefined]) {
    const h = harness();
    const { id } = await h.service.start({ language: 'r' });
    const execution = h.service.execute(id, { code: '42' }, async () => {
      throw reason;
    });
    await h.created[0].requests[0].future.emit({
      header: { msg_type: 'stream' },
      content: { text: 'x' }
    });
    h.created[0].requests[0].future.finish();
    await assert.rejects(execution, (error) => error === reason);
    const next = h.service.execute(id, { code: '43' }, async () => {});
    h.created[0].requests[1].future.finish();
    assert.equal((await next).status, 'ok');
    await h.service.dispose();
  }
});

test('synchronous native request failure releases the operation lock', async () => {
  const h = harness();
  const { id } = await h.service.start({ language: 'r' });
  const kernel = h.created[0];
  const original = kernel.requestExecute;
  kernel.requestExecute = () => {
    throw new Error('native failure');
  };
  await assert.rejects(
    h.service.execute(id, { code: '1' }, async () => {}),
    /native failure/
  );
  kernel.requestExecute = original;
  const next = h.service.execute(id, { code: '2' }, async () => {});
  kernel.requests[0].future.finish();
  await next;
  await h.service.dispose();
});

test('interrupt delegates, restart cancels old work and reapplies startup', async () => {
  const h = harness({ r: 'startup()' });
  const { id } = await h.service.start({ language: 'r' });
  const kernel = h.created[0];
  const running = h.service.execute(id, { code: 'long()' }, async () => {});
  const cancelled = assert.rejects(running, /Cancelled/);
  await h.service.interrupt(id);
  assert.equal(kernel.interrupts, 1);
  await h.service.restart(id);
  await cancelled;
  assert.equal(kernel.restarts, 1);
  assert.equal(kernel.requests.filter((r) => r.content.code === 'startup()').length, 2);
  assert.equal(await h.service.status(id), 'idle');
  await h.service.shutdown(id);
  await assert.rejects(h.service.status(id), /Unknown/);
});

test('failed restart retires the kernel', async () => {
  const h = harness();
  const { id } = await h.service.start({ language: 'r' });
  const kernel = h.created[0];
  kernel.restart = async () => {
    throw new Error('restart failed');
  };
  await assert.rejects(h.service.restart(id), /restart failed/);
  assert.equal(kernel.isDisposed, true);
  await assert.rejects(h.service.status(id), /Unknown/);
});

test('dispose during startup retires late-created kernels', async () => {
  const h = harness();
  const gate = deferred();
  const start = h.manager.kernels.startNew;
  h.manager.kernels.startNew = async (options) => {
    const kernel = await start(options);
    await gate.promise;
    return kernel;
  };
  const starting = h.service.start({ language: 'r' });
  const rejected = assert.rejects(starting, /closed/);
  while (!h.created.length) await new Promise((r) => setImmediate(r));
  const disposal = h.service.dispose();
  gate.resolve();
  await disposal;
  await rejected;
  assert.equal(h.created[0].isDisposed, true);
  assert.equal(h.created[0].shutdowns, 1);
});

test(
  'dispose retires kernels whose info or startup code never completes',
  { timeout: 1000 },
  async () => {
    for (const stage of ['info', 'startup']) {
      const h = harness(stage === 'startup' ? { r: 'stalled-startup()' } : {});
      const start = h.manager.kernels.startNew;
      h.manager.kernels.startNew = async (options) => {
        const kernel = await start(options);
        if (stage === 'info') kernel.info = new Promise(() => {});
        return kernel;
      };
      const starting = h.service.start({ language: 'r' });
      const rejected = assert.rejects(starting, /closed/);
      while (!h.created.length || (stage === 'startup' && !h.created[0].requests.length)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
      await h.service.dispose();
      await rejected;
      assert.equal(h.created[0].shutdowns, 1);
      assert.equal(h.created[0].isDisposed, true);
      if (stage === 'startup') assert.equal(h.created[0].requests[0].future.disposed, true);
    }
  }
);

test('failed startup and wrong reported language retire their kernels', async () => {
  for (const failure of ['startup', 'language']) {
    const h = harness(failure === 'startup' ? { r: 'bad-startup()' } : {});
    const start = h.manager.kernels.startNew;
    h.manager.kernels.startNew = async (options) => {
      const k = await start(options);
      if (failure === 'language')
        k.info = Promise.resolve({ status: 'ok', language_info: { name: 'python' } });
      return k;
    };
    const starting = h.service.start({ language: 'r' });
    const rejected = assert.rejects(starting, failure === 'startup' ? /startup/ : /language/);
    if (failure === 'startup') {
      while (!h.created[0]?.requests.length) await new Promise((r) => setImmediate(r));
      h.created[0].requests[0].future.finish('error');
    }
    await rejected;
    assert.equal(h.created[0].isDisposed, true);
  }
});
