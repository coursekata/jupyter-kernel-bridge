import type { KernelMessage } from '@jupyterlab/services';

export const CHANNEL = 'coursekata-jupyter-kernel';
export const VERSION = 1;
export const PARENT_ORIGIN_PARAM = 'kernelBridgeParentOrigin';

export interface KernelSpec {
  name: string;
  language: string;
  displayName: string;
}
export interface KernelIdentity extends KernelSpec {
  id: string;
}
export interface KernelSelection {
  name?: string;
  language?: string;
}
export interface ExecuteRequest {
  code: string;
  silent?: boolean;
  storeHistory?: boolean;
  stopOnError?: boolean;
}
export type KernelOutput = KernelMessage.IIOPubMessage;
export type ExecuteReply = KernelMessage.IExecuteReplyMsg['content'];

/** Each connection can control only the kernels it creates. */
export interface KernelAPI {
  ready(): Promise<{ version: number }>;
  listKernels(): Promise<KernelSpec[]>;
  start(selection: KernelSelection): Promise<KernelIdentity>;
  execute(
    id: string,
    request: ExecuteRequest,
    onOutput: (message: KernelOutput) => Promise<void>
  ): Promise<ExecuteReply>;
  interrupt(id: string): Promise<void>;
  restart(id: string): Promise<KernelIdentity>;
  shutdown(id: string): Promise<void>;
  status(id: string): Promise<KernelMessage.Status>;
  dispose(): Promise<void>;
}
