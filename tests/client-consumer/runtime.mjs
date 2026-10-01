import { KernelClient, kernelFrameURL } from '@coursekata/jupyter-kernel-client';
import { CHANNEL, VERSION } from '@coursekata/jupyter-kernel-client/protocol';

if (typeof KernelClient !== 'function' || typeof kernelFrameURL !== 'function') {
  throw new Error('The client package does not expose its public runtime API.');
}
if (typeof CHANNEL !== 'string' || CHANNEL.length === 0 || !Number.isInteger(VERSION)) {
  throw new Error('The client package does not expose a valid protocol identity.');
}
