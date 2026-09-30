import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KernelConnection } from '@jupyterlab/services/lib/kernel/default.js';
import { createMessage } from '@jupyterlab/services/lib/kernel/messages.js';
import { ServerConnection } from '@jupyterlab/services/lib/serverconnection.js';
import { KernelService } from '../lib/service.js';

// Replace only the wire. Keep native message validation, display routing and futures.
class Socket {
  protocol = '';
  send() {}
  close() {}
}

test('native display updates survive the originating execution and await delivery', async () => {
  const kernel = new KernelConnection({
    model: { id: 'owned', name: 'python' },
    serverSettings: ServerConnection.makeSettings({ WebSocket: Socket }),
    kernelAPIClient: { shutdown: async () => {} }
  });
  kernel._kernelSession = 'native-session';
  kernel._info.resolve({ status: 'ok', language_info: { name: 'python' } });
  const manager = {
    ready: Promise.resolve(),
    kernelspecs: {
      refreshSpecs: async () => {},
      specs: { kernelspecs: { python: { name: 'python', language: 'python', display_name: 'Python' } } }
    },
    kernels: { startNew: async () => kernel }
  };
  const service = new KernelService(manager);
  try {
    const { id } = await service.start({ name: 'python' });
    for (const type of ['display_data', 'update_display_data']) {
      const received = [];
      const execution = service.execute(id, { code: type }, async message => {
        await new Promise(resolve => setImmediate(resolve));
        received.push(message.header.msg_type);
      });
      const future = [...kernel._futures.values()].at(-1);
      const send = async (msgType, channel, content) => {
        const message = createMessage({ msgType, channel, content,
          session: 'native-session', parentHeader: future.msg.header });
        kernel._onWSMessage({ data: JSON.stringify(message) });
        await kernel._msgChain;
      };
      await send(type, 'iopub', {
        data: { 'text/plain': type }, metadata: {}, transient: { display_id: 'same-display' }
      });
      await send('execute_reply', 'shell', { status: 'ok', execution_count: 1, payload: [], user_expressions: {} });
      await send('status', 'iopub', { execution_state: 'idle' });
      await execution;
      assert.deepEqual(received, [type, 'status']);
      assert.equal(kernel._futures.size, 0, 'completed execution callbacks are released');
    }
  } finally {
    await service.dispose();
  }
});
