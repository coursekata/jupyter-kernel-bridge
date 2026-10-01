# @coursekata/jupyter-kernel-bridge

A JupyterLab/JupyterLite frontend extension that exposes kernel execution and
lifecycle to an embedding page over Comlink. The companion
[`@coursekata/jupyter-kernel-client`](../client/README.md) npm package
runs in the parent application. Both packages live in this repository and use the
same protocol and release version.

The extension includes kernel discovery, start, execute, status, interrupt,
restart and shutdown. It uses Jupyter's native service manager and kernel APIs;
it needs no console widgets, external command provider or peer dependencies.
The host application supplies Jupyter's shared APIs and installed language kernels.
R, Python and their libraries are not bundled in the bridge.

## Install

Install the matching tagged source in the environment that builds JupyterLite or
runs JupyterLab:

```sh
uv add git+https://github.com/coursekata/jupyter-kernel-bridge --tag v0.1.1
jupyter lite build
```

The source build creates a wheel carrying the compiled JavaScript extension; installing it does not
require rebuilding JupyterLab. CKCode imports the client package, not this extension.

The bridge activates only inside an iframe whose URL explicitly supplies
`kernelBridgeParentOrigin`. Both sides validate source and origin before
transferring a private MessagePort. Each connection owns its kernels and can
control only those it started. Normal top-level notebooks are unaffected.

The hosting site may set `kernelBridgeStartup` in `jupyter-config-data` to trusted
startup code keyed by kernel name or lowercase language. Kernel-name entries take
precedence. Startup runs after both creation and restart. Exercise preparation,
grading, between-attempt cleanup and output rendering belong to the client app.

See the [client API and lifecycle documentation](../client/README.md)
for embedding, execution callbacks and interruption limits.

## Build and package

See the [repository instructions](../../README.md#development).
