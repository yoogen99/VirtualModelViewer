import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const files = {};
for (const name of await readdir('blender_addon/virtual_model_viewer')) {
  if (name.endsWith('.py')) files[`virtual_model_viewer/${name}`] = new Uint8Array(await readFile(`blender_addon/virtual_model_viewer/${name}`));
}
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/virtual_model_viewer-0.1.0.zip', zipSync(files));
console.log('Created artifacts/virtual_model_viewer-0.1.0.zip');
