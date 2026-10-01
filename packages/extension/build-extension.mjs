import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const python = process.env.KERNEL_BRIDGE_PYTHON || 'python';
const core = execFileSync(python, ['-c', 'import pathlib,jupyterlab; print(pathlib.Path(jupyterlab.__file__).parent / "staging")'], { encoding: 'utf8' }).trim();
execFileSync(process.execPath, [require.resolve('@jupyterlab/builder/lib/build-labextension.js'), '.', '--core-path', core], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'inherit' });
