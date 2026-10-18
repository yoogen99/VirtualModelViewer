import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const files = {};
for (const name of await readdir('fusion_addon/VirtualModelViewer')) {
  if (['.py', '.manifest', '.html', '.js'].some(extension => name.endsWith(extension))) {
    files[`VirtualModelViewer/${name}`] = new Uint8Array(await readFile(`fusion_addon/VirtualModelViewer/${name}`));
  }
}
// The Blender client is the canonical source; both distributed add-ons use
// exactly the same protocol/authentication implementation.
files['VirtualModelViewer/client.py'] = new Uint8Array(await readFile('blender_addon/virtual_model_viewer/client.py'));
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/VirtualModelViewer-Fusion-0.1.0.zip', zipSync(files));
console.log('Created artifacts/VirtualModelViewer-Fusion-0.1.0.zip');
