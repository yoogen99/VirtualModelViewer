import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// All translations are in meters. Model scale is never changed.
export async function startQuest(assetUrl: string, planeHeight: number, session: XRSession): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.domElement.className = 'xr';
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c9e82, 2.5));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(1, 4, 2); scene.add(light);
  const modelRoot = new THREE.Group();
  modelRoot.visible = false; scene.add(modelRoot);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeHeight);
  const target = new THREE.Vector3();
  const ray = new THREE.Ray();
  const rotation = new THREE.Matrix4();
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.06, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xc2e793, side: THREE.DoubleSide }));
  reticle.visible = false; scene.add(reticle);
  const controllers: THREE.XRTargetRaySpace[] = [];
  const sources = new Map<THREE.Object3D, XRInputSource>();
  let activeController = 0;
  let ended = false;
  let modelReady = false;
  let previousFrame = 0;
  let hud: THREE.Mesh;
  const pressed = [false, false];
  const disposables: THREE.Object3D[] = [];

  function intersection(controller: THREE.Object3D) {
    controller.updateWorldMatrix(true, false);
    rotation.extractRotation(controller.matrixWorld);
    ray.origin.setFromMatrixPosition(controller.matrixWorld);
    ray.direction.set(0, 0, -1).applyMatrix4(rotation);
    if (ray.direction.y >= -0.02 || !ray.intersectPlane(plane, target) || ray.origin.distanceTo(target) > 20) return false;
    return true;
  }

  function createHud() {
    const canvas = document.createElement('canvas');
    canvas.width = 1536; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#12241eee'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c2e793'; ctx.font = 'bold 44px sans-serif';
    ctx.fillText('実寸 100% ｜ トリガー：配置・移動', 50, 85);
    ctx.fillStyle = '#ffffff'; ctx.font = '34px sans-serif';
    ctx.fillText('グリップ：15°回転 ｜ スティック左右：回転 ｜ B / Y：終了', 50, 160);
    ctx.fillText(`配置面：床から ${planeHeight.toFixed(2)} m`, 50, 215);
    const texture = new THREE.CanvasTexture(canvas);
    hud = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.12), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false }));
    hud.position.set(0, -0.22, -0.8); hud.renderOrder = 100;
    camera.add(hud);
  }

  const endedPromise = new Promise<void>(resolve => {
    session.addEventListener('end', () => { ended = true; resolve(); }, { once: true });
  });
  try {
    createHud();
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      controllers.push(controller);
      controller.addEventListener('connected', (event) => sources.set(controller, event.data));
      controller.addEventListener('disconnected', () => sources.delete(controller));
      controller.addEventListener('selectstart', () => {
        activeController = i;
        if (modelReady && intersection(controller)) {
          modelRoot.position.copy(target); modelRoot.visible = true;
        }
      });
      controller.addEventListener('squeezestart', () => { modelRoot.rotation.y += Math.PI / 12; });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]),
        new THREE.LineBasicMaterial({ color: 0xc2e793 }));
      controller.add(line); scene.add(controller);
    }
    await renderer.xr.setSession(session);
    renderer.setAnimationLoop((time) => {
      const dt = previousFrame ? Math.min((time - previousFrame) / 1000, 0.05) : 0;
      previousFrame = time;
      const controller = controllers[activeController];
      reticle.visible = modelReady && sources.has(controller) && intersection(controller);
      if (reticle.visible) reticle.position.copy(target);
      controllers.forEach((c, i) => {
        const gamepad = sources.get(c)?.gamepad;
        if (!gamepad) return;
        const x = gamepad.axes[2] ?? 0;
        if (Math.abs(x) > 0.2) modelRoot.rotation.y -= x * dt * 1.5;
        const exit = gamepad.buttons[5]?.pressed ?? false;
        if (exit && !pressed[i]) void session.end().catch(() => undefined);
        pressed[i] = exit;
      });
      renderer.render(scene, camera);
    });
    const gltf = await new GLTFLoader().loadAsync(assetUrl);
    if (ended) { disposables.push(gltf.scene); return; }
    modelRoot.add(gltf.scene);
    modelReady = true;
    await endedPromise;
  } finally {
    if (!ended) await session.end().catch(() => undefined);
    renderer.setAnimationLoop(null);
    // Shared resources may appear on several nodes; dispose each once.
    const resources = new Set<{ dispose(): void }>();
    const collect = (object: THREE.Object3D) => object.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) resources.add(mesh.geometry);
      if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        resources.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
      }
    });
    collect(scene); disposables.forEach(collect);
    resources.forEach(resource => resource.dispose());
    renderer.dispose(); renderer.domElement.remove();
  }
}
