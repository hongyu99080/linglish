// 裸标识符,由 game.html 的 importmap 解析到 /js/vendor/three.module.min.js。
// 别写死路径——importmap 是版本切换的唯一开关。
import * as THREE from 'three';

const rig = window.GameCharacterRig;

const CAMERA_HALF_HEIGHT = 3.2;
const UNLOCK_DURATION_MS = 1600;
const REVIVAL_DURATION_MS = 2600;

function springEase(t) {
  // Overshoot-and-settle, matching --ease-spring.
  if (t >= 1) return 1;
  return 1 - Math.pow(2, -10 * t) * Math.cos(t * Math.PI * 3.2);
}

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch (_) {
    return false;
  }
}

// 降级不用 PNG 序列帧(会引入 6 个待产美术资产,MVP 无资产管线),
// 改用 CSS 盒子剪影:同一份 rig 部位数据驱动,零资产、任意解锁组合都能画。
function renderFallback(container, unlockedParts) {
  container.innerHTML = '';
  const figure = document.createElement('div');
  figure.className = 'game-figure-fallback';
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', '角色已解锁 ' + unlockedParts.length + ' / 6 个部位');

  for (const def of rig.getPartDefinitions()) {
    const el = document.createElement('span');
    el.className = 'game-figure-part';
    el.dataset.part = def.name;
    el.dataset.unlocked = String(unlockedParts.includes(def.name));
    // rig 用 three 的世界单位(y 向上),这里换算成百分比定位(y 向下)。
    el.style.width = (def.size[0] * 22) + '%';
    el.style.height = (def.size[1] * 22) + '%';
    el.style.left = 'calc(50% + ' + (def.home[0] * 22) + '% - ' + (def.size[0] * 11) + '%)';
    el.style.bottom = 'calc(' + ((def.home[1] + 0.6) * 22) + '% - ' + (def.size[1] * 11) + '%)';
    el.style.background = '#' + def.color.toString(16).padStart(6, '0');
    figure.appendChild(el);
  }

  container.appendChild(figure);

  function paint(parts) {
    for (const el of figure.querySelectorAll('.game-figure-part')) {
      el.dataset.unlocked = String(parts.includes(el.dataset.part));
    }
    figure.setAttribute('aria-label', '角色已解锁 ' + parts.length + ' / 6 个部位');
  }

  let current = unlockedParts.slice();
  return {
    isFallback: true,
    unlockPart: async (name) => {
      if (!current.includes(name)) current = current.concat(name);
      paint(current);
    },
    playRevival: async () => { figure.dataset.revived = 'true'; },
    dispose: () => { container.innerHTML = ''; },
  };
}

export async function createCharacterStage(container, options) {
  const settings = options || {};
  const unlockedParts = Array.isArray(settings.unlockedParts) ? settings.unlockedParts.slice() : [];
  const reducedMotion = Boolean(settings.reducedMotion);

  if (!supportsWebGL()) return renderFallback(container, unlockedParts);

  const scene = new THREE.Scene();
  const width = container.clientWidth || 320;
  const height = container.clientHeight || 420;
  const aspect = width / height;
  const camera = new THREE.OrthographicCamera(
    -CAMERA_HALF_HEIGHT * aspect,
    CAMERA_HALF_HEIGHT * aspect,
    CAMERA_HALF_HEIGHT,
    -CAMERA_HALF_HEIGHT,
    0.1,
    100
  );
  camera.position.set(3.5, 3.5, 6);
  camera.lookAt(0, 0.6, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfc9a8, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(3, 6, 4);
  scene.add(key);

  const groups = new Map();
  rig.getPartDefinitions().forEach((def) => {
    const geometry = new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
    const material = new THREE.MeshLambertMaterial({ color: def.color });
    const group = new THREE.Group();
    group.name = def.name;
    group.add(new THREE.Mesh(geometry, material));

    const transform = rig.computePartTransform(def, unlockedParts.includes(def.name));
    group.position.set(transform.position[0], transform.position[1], transform.position[2]);
    group.scale.setScalar(transform.scale);
    material.color.setHex(def.color);
    if (transform.saturation === 0) material.color.lerp(new THREE.Color(0x9aa0a6), 0.85);

    group.userData = { def, material, baseColor: new THREE.Color(def.color) };
    scene.add(group);
    groups.set(def.name, group);
  });

  let running = true;
  let spin = 0;
  function loop() {
    if (!running) return;
    if (!reducedMotion) spin += 0.004;
    scene.rotation.y = Math.sin(spin) * 0.25;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  function animate(durationMs, onFrame) {
    return new Promise((resolve) => {
      if (reducedMotion) { onFrame(1); resolve(); return; }
      const start = performance.now();
      function step(now) {
        const t = Math.min(1, (now - start) / durationMs);
        onFrame(springEase(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  async function unlockPart(name) {
    const group = groups.get(name);
    if (!group) return;
    const def = group.userData.def;
    const from = rig.computePartTransform(def, false);
    const to = rig.computePartTransform(def, true);
    const greyed = new THREE.Color(def.color).lerp(new THREE.Color(0x9aa0a6), 0.85);

    await animate(UNLOCK_DURATION_MS, (k) => {
      group.position.set(
        from.position[0] + (to.position[0] - from.position[0]) * k,
        from.position[1] + (to.position[1] - from.position[1]) * k,
        from.position[2] + (to.position[2] - from.position[2]) * k
      );
      group.scale.setScalar(from.scale + (to.scale - from.scale) * k);
      group.userData.material.color.copy(greyed).lerp(group.userData.baseColor, k);
    });
    if (!unlockedParts.includes(name)) unlockedParts.push(name);
  }

  async function playRevival() {
    await animate(REVIVAL_DURATION_MS, (k) => {
      const bounce = Math.sin(k * Math.PI * 3) * 0.12 * (1 - k);
      groups.forEach((group) => { group.position.y = group.userData.def.home[1] + bounce; });
      scene.rotation.y = k * Math.PI * 2;
    });
  }

  function dispose() {
    running = false;
    groups.forEach((group) => {
      group.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) node.material.dispose();
      });
    });
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  return { isFallback: false, unlockPart, playRevival, dispose };
}
