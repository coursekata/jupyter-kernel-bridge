import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KernelClient, kernelFrameURL } from '@coursekata/jupyter-kernel-client';
import { installKernelEndpoint } from '../lib/endpoint.js';
import { CHANNEL, VERSION } from '@coursekata/jupyter-kernel-client/protocol';
import { releaseProxy } from 'comlink';

class Target {
  events = new Map();
  addEventListener(name, fn) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(fn);
  }
  removeEventListener(name, fn) {
    this.events.get(name)?.delete(fn);
  }
  emit(name, event) {
    for (const fn of [...(this.events.get(name) ?? [])]) fn(event);
  }
}
function fixture({ delay = false } = {}) {
  const parent = new Target();
  const child = new Target();
  const frame = new Target();
  frame.src = 'https://runtime.example/lab/index.html';
  const received = [];
  const hanging = [];
  let disposed = 0;
  let started = 0;
  let endpoint;
  const childWindow = {
    postMessage(data, origin, ports = []) {
      assert.equal(origin, 'https://runtime.example');
      child.emit('message', { data, origin: 'https://host.example', source: child.parent, ports });
    }
  };
  child.parent = {
    postMessage(data, origin) {
      assert.equal(origin, 'https://host.example');
      received.push(data);
      parent.emit('message', { data, origin: 'https://runtime.example', source: childWindow });
    }
  };
  frame.contentWindow = childWindow;
  const service = {
    ready: async () => ({ version: VERSION }),
    listKernels: async () => [{ name: 'python', language: 'python', displayName: 'Python' }],
    start: async () => {
      started++;
      return { id: 'owned', name: 'python', language: 'python', displayName: 'Python' };
    },
    execute: async (_id, { code }, onOutput) => {
      if (code === 'hang') {
        hanging.push(onOutput);
        return new Promise(() => {});
      }
      try {
        await onOutput({ header: { msg_type: 'stream' }, content: { text: code } });
        return { status: 'ok', execution_count: 1 };
      } finally {
        onOutput[releaseProxy]();
      }
    },
    status: async () => 'idle',
    interrupt: async () => {},
    restart: async () => ({ id: 'owned' }),
    shutdown: async () => {},
    dispose: async () => {
      disposed++;
      for (const callback of hanging.splice(0)) callback[releaseProxy]();
    }
  };
  const saved = new Map(
    ['window', 'document', 'location'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key)
    ])
  );
  for (const [key, value] of Object.entries({
    window: parent,
    document: { baseURI: 'https://host.example/' },
    location: { origin: 'https://host.example' }
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const install = () => {
    endpoint = installKernelEndpoint(child, 'https://host.example', () => service);
  };
  if (!delay) install();
  return {
    parent,
    child,
    frame,
    received,
    install,
    get started() {
      return started;
    },
    get disposed() {
      return disposed;
    },
    restore() {
      endpoint?.();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

test('private RPC connection carries commands, streamed callbacks and cleanup', async () => {
  const f = fixture();
  const client = new KernelClient(f.frame, { startupTimeoutMs: 1000 });
  try {
    assert.match(kernelFrameURL('/lab'), /kernelBridgeParentOrigin=/);
    assert.throws(() => kernelFrameURL('file:///tmp/test'), /HTTP/);
    await client.ready;
    assert.equal((await client.listKernels())[0].language, 'python');
    const kernel = await client.start({ language: 'python' });
    const events = [];
    const reply = await client.execute(kernel.id, { code: 'first' }, async (m) => {
      await new Promise((r) => setTimeout(r, 5));
      events.push(m);
    });
    assert.equal(reply.status, 'ok');
    assert.equal(events[0].content.text, 'first');
    await client.interrupt(kernel.id);
    await client.restart(kernel.id);
    await client.shutdown(kernel.id);
    client.dispose();
    await assert.rejects(client.status(kernel.id), /closed/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.disposed, 1);
  } finally {
    client.dispose();
    f.restore();
  }
});

test('wrong-window readiness cannot resolve a delayed iframe connection', async () => {
  const f = fixture({ delay: true });
  const client = new KernelClient(f.frame, { startupTimeoutMs: 1000 });
  let ready = false;
  void client.ready.then(() => {
    ready = true;
  });
  try {
    f.parent.emit('message', {
      source: {},
      origin: 'https://runtime.example',
      data: { channel: CHANNEL, version: VERSION, type: 'ready', connection: client.connection }
    });
    f.parent.emit('message', {
      source: f.frame.contentWindow,
      origin: 'https://other.example',
      data: { channel: CHANNEL, version: VERSION, type: 'ready', connection: client.connection }
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ready, false);
    f.install();
    f.frame.emit('load', {});
    await client.ready;
    assert.equal(ready, true);
  } finally {
    client.dispose();
    f.restore();
  }
});

test('runtime rejects unrelated sources and origins before exposing any command', async () => {
  const f = fixture();
  try {
    for (const event of [
      { source: {}, origin: 'https://host.example' },
      { source: f.child.parent, origin: 'https://other.example' }
    ]) {
      f.child.emit('message', {
        ...event,
        data: { channel: CHANNEL, version: VERSION, type: 'hello', connection: 'outsider' },
        ports: []
      });
      const channel = new MessageChannel();
      f.child.emit('message', {
        ...event,
        data: { channel: CHANNEL, version: VERSION, type: 'connect', connection: 'outsider' },
        ports: [channel.port2]
      });
      channel.port1.close();
      channel.port2.close();
    }
    assert.equal(f.received.length, 0);
    assert.equal(f.started, 0);
    const client = new KernelClient(f.frame);
    await client.start({ language: 'python' });
    assert.equal(f.started, 1);
    client.dispose();
  } finally {
    f.restore();
  }
});

test('disposal immediately settles a pending RPC call', async () => {
  const f = fixture();
  const client = new KernelClient(f.frame);
  try {
    await client.ready;
    const work = client.execute('owned', { code: 'hang' }, () => {});
    const rejected = assert.rejects(work, /cancelled/);
    await new Promise((r) => setTimeout(r, 10));
    client.dispose(new Error('cancelled'));
    await rejected;
  } finally {
    client.dispose();
    f.restore();
  }
});

test('startup timeout releases listeners and rejects calls waiting for readiness', async () => {
  const f = fixture({ delay: true });
  const client = new KernelClient(f.frame, { startupTimeoutMs: 20 });
  try {
    const ready = assert.rejects(client.ready, /timed out/);
    const start = assert.rejects(client.start({ language: 'r' }), /timed out/);
    await Promise.all([ready, start]);
    assert.equal(f.parent.events.get('message').size, 0);
    assert.equal(f.frame.events.get('load').size, 0);
  } finally {
    client.dispose();
    f.restore();
  }
});

test('an incompatible protocol rejects readiness without issuing commands', async () => {
  const f = fixture({ delay: true });
  const client = new KernelClient(f.frame);
  try {
    const ready = assert.rejects(client.ready, /Incompatible/);
    const start = assert.rejects(client.start({ language: 'r' }), /Incompatible/);
    await Promise.resolve();
    f.parent.emit('message', {
      source: f.frame.contentWindow,
      origin: 'https://runtime.example',
      data: { channel: CHANNEL, version: VERSION + 1, type: 'ready', connection: client.connection }
    });
    await Promise.all([ready, start]);
    assert.equal(f.started, 0);
    assert.equal(f.parent.events.get('message').size, 0);
  } finally {
    client.dispose();
    f.restore();
  }
});

test('immediate disposal never installs listeners or starts a kernel', async () => {
  const f = fixture();
  const client = new KernelClient(f.frame);
  try {
    const start = client.start({ language: 'python' });
    client.dispose(new Error('removed before startup'));
    await assert.rejects(start, /removed before startup/);
    await assert.rejects(client.ready, /removed before startup/);
    assert.equal(f.started, 0);
    assert.equal(f.parent.events.get('message')?.size ?? 0, 0);
  } finally {
    client.dispose();
    f.restore();
  }
});
