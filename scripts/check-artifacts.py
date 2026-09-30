"""Check the shipped inputs and assets, not just the working-tree build."""
import json
from pathlib import Path
import tarfile
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
with tarfile.open(root / "dist" / f"coursekata_jupyter_kernel_bridge-{version}.tar.gz") as archive:
    names = {name.partition("/")[2] for name in archive.getnames()}
    required = {"package-lock.json", "build_hook.py", "packages/client/src/index.ts",
                "packages/client/src/protocol.ts", "packages/extension/src/extension.ts",
                "packages/extension/src/service.ts", "packages/extension/src/endpoint.ts",
                "packages/extension/build-extension.mjs", "scripts/check-version.mjs"}
    assert required <= names, f"Missing source inputs: {required - names}"
    assert not any("node_modules/" in name or "/lib/" in name for name in names)
with zipfile.ZipFile(root / "dist" / f"coursekata_jupyter_kernel_bridge-{version}-py3-none-any.whl") as archive:
    names = archive.namelist()
    prefix = f"coursekata_jupyter_kernel_bridge-{version}.data/data/share/jupyter/labextensions/@coursekata/jupyter-kernel-bridge/"
    metadata = json.loads(archive.read(prefix + "package.json"))
    assert metadata["version"] == version
    assert prefix + metadata["jupyterlab"]["_build"]["load"] in names
    assert prefix + "install.json" in names
with tarfile.open(root / "dist" / f"coursekata-jupyter-kernel-client-{version}.tgz") as archive:
    names = set(archive.getnames())
    assert {"package/lib/index.js", "package/lib/index.d.ts", "package/lib/protocol.js", "package/lib/protocol.d.ts"} <= names
    assert not any("node_modules/" in name for name in names)
print("Source, extension wheel and client tarball contain their required inputs and assets.")
