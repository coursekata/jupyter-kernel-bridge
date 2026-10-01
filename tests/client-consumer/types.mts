import { KernelClient, kernelFrameURL } from '@coursekata/jupyter-kernel-client';
import type {
  ExecuteRequest,
  KernelIdentity,
  KernelOutput,
  KernelSelection,
  KernelSpec
} from '@coursekata/jupyter-kernel-client';

const request: ExecuteRequest = { code: '1' };
const selection: KernelSelection = { language: 'python' };
const publicApi = {
  KernelClient,
  kernelFrameURL,
  request,
  selection
} satisfies Record<string, unknown>;

type PublicTypes = KernelIdentity | KernelOutput | KernelSpec;
void publicApi;
void (undefined as PublicTypes | undefined);
