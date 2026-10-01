# Jupyter kernel bridge

Control kernels in an embedded JupyterLab or JupyterLite application from a parent page.
The client and extension communicate through Comlink over a private MessagePort. The
extension uses Jupyter's native kernel APIs and owns only the kernels it starts.

- `@coursekata/jupyter-kernel-client`: JavaScript API imported by the parent application.
- `coursekata-jupyter-kernel-bridge`: Python-installable frontend extension. Python
  packages its JavaScript assets; it does not execute code or run a server.

The extension supports discovery, start, execution with streamed output, status,
interrupt, restart and shutdown. It includes no language kernels, grading code,
exercise reset policy, or output renderer. The hosting site installs its own kernels.

## Installation

Install the client from GitHub Packages and declare the extension as a tagged uv
dependency:

Configure the consumer's `.npmrc` with the GitHub Packages scope and authenticate
with an account or CI token that has read access:

```ini
@coursekata:registry=https://npm.pkg.github.com
```

Keep credentials in the user/CI npm configuration, outside source control.

```sh
npm install @coursekata/jupyter-kernel-client
uv add git+https://github.com/coursekata/jupyter-kernel-bridge --tag v0.1.1
```

Use a separate uv project for the environment that builds your JupyterLite site.
Commit its `pyproject.toml` and `uv.lock`, and use `uv sync --locked` in CI. The
Python install requires Node.js 22 or newer and npm: its build hook runs `npm ci`
against this repository's lockfile and builds the extension. Then run `jupyter lite
build` from that environment. No Pyodide addon is required by the bridge.

The repository and npm package are public. GitHub's npm registry still requires
authentication for package installation, while the tagged source dependency needs
no Git credentials.

See [client usage](packages/client/README.md) for iframe ownership, callback
handling and the complete API. The [extension documentation](packages/extension/README.md)
describes activation and startup configuration.

## Development

```sh
npm ci
npm test
uv build
npm run pack:client
```

`uv build` creates an isolated Python build environment. `dist/` contains the
source distribution, wheel and client npm tarball. Generated assets are not committed.
The standalone extension has been tested with JupyterLite 0.8.3 / JupyterLab 4.6.3
frontend APIs. Server-backed JupyterLab deployment still needs validation.

## Releases and updates

The client and extension use the same package version and immutable `vX.Y.Z` tag.
Protocol compatibility is checked separately during connection. A release must
preserve compatibility with deployed clients within the supported protocol version.
The Python package derives its version from the root npm package with
`hatch-nodejs-version`. Set all npm workspace versions together with
`npm run version:set -- X.Y.Z`; the Python metadata follows automatically.

Renovate handles routine versions using CourseKata's shared software preset;
Dependabot handles security alerts and supported security fixes. There is no second
bot managing routine upgrades. The consumer's uv manifest owns the extension tag;
its lockfile records the resolved commit. JavaScript consumers use normal npm
version constraints and package locks.

Tag publication and npm publication are explicit release actions. No build command
publishes a package or deploys a site. Install both candidate packages in consumers
and run their browser acceptance checks before releasing.

The release workflow runs manually against an existing version tag, verifies that the
tag matches the package version, installs both built packages as consumers would,
publishes the client to GitHub Packages and attaches the wheel and source archive to a
GitHub release. Configure the `release` environment before using it.
