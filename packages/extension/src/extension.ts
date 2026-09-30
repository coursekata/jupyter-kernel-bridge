import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { installKernelEndpoint, validOrigin } from './endpoint.js';
import { PARENT_ORIGIN_PARAM } from '@coursekata/jupyter-kernel-client/protocol';
import { KernelService } from './service.js';

const plugin: JupyterFrontEndPlugin<void> = {
  id: '@coursekata/jupyter-kernel-bridge:plugin',
  autoStart: true,
  activate(app) {
    const parentOrigin = new URL(location.href).searchParams.get(PARENT_ORIGIN_PARAM);
    if (window.parent === window || !validOrigin(parentOrigin)) return;
    const startup = JSON.parse(PageConfig.getOption('kernelBridgeStartup') || '{}');
    if (
      !startup ||
      typeof startup !== 'object' ||
      Array.isArray(startup) ||
      Object.values(startup).some((code) => typeof code !== 'string')
    ) {
      throw new Error('kernelBridgeStartup must map kernel names or languages to startup code.');
    }
    installKernelEndpoint(
      window,
      parentOrigin,
      () => new KernelService(app.serviceManager, app.started, startup)
    );
  }
};
export default plugin;
