import * as THREE from
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

// ============================================================
// MOSQUITO SENSORY V6
//
// Artistic passthrough overlays, not genuine thermal sensing.
// Host signatures are manually placed and remain stationary.
// All distances are in metres.
// ============================================================

const CONFIG = {
  version: "SENSORY V6",
  placementDistance: 1.0,
  stingDistance: 2.0,
  acquisitionSeconds: 0.35,
  cooldownSeconds: 0.9,
  maximumHosts: 6,
  environmentParticles: 180,
  scentParticles: 40,
  visorOpacity: 0.075,
  showFloorRipples: true
};

const COLOR = {
  blue: 0x263fa3,
  violet: 0x773cc4,
  magenta: 0xed2875,
  orange: 0xff7935,
  cream: 0xfff0b3
};

// Reuse the elements from your existing index.html.
const startButton = document.getElementById("start");
const statusText = document.getElementById("status");
const panel = document.getElementById("panel");

if (!startButton || !statusText || !panel) {
  throw new Error(
    "index.html must contain elements with IDs: start, status, panel."
  );
}

startButton.disabled = true;
startButton.textContent = "Loading sensory vision…";
statusText.textContent = `${CONFIG.version} is loading.`;

// ============================================================
// SCENE AND TRANSPARENT RENDERER
// ============================================================

const scene = new THREE.Scene();
// Do not add an opaque scene.background.

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  30
);

camera.position.set(0, 1.6, 0);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 0);

renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");

document.body.appendChild(renderer.domElement);

// ============================================================
// STATE
// ============================================================

const hosts = [];
const controllers = [];

const headPosition = new THREE.Vector3(0, 1.6, 0);
const headQuaternion = new THREE.Quaternion();

const raycaster = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const rayRotation = new THREE.Matrix4();

const tempPosition = new THREE.Vector3();
const inverseHeadRotation = new THREE.Quaternion();

let activeSession = null;
let needsInitialHosts = false;
let previousTime = null;
let now = 0;
let stingCount = 0;
let proboscisUntil = 0;

let feedback = "";
let feedbackUntil = 0;
let lastHUDKey = "";

// The sting patch is positioned at the upper-left torso.
const PATCH_OFFSET = new THREE.Vector3(-0.12, 0.22, 0.22);

// ============================================================
// HELPERS
// ============================================================

function transparentMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  });
}

function makeCanvasTexture(width, height, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create a canvas texture.");
  }

  draw(context, canvas);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

const particleTexture = makeCanvasTexture(64, 64, (context) => {
  const gradient = context.createRadialGradient(
    32, 32, 0,
    32, 32, 32
  );

  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.7)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
});

function showFeedback(message, seconds = 1.2) {
  feedback = message;
  feedbackUntil = now + seconds;
}

// ============================================================
// COOL SENSORY VISOR
// This tints the view; it does not process camera pixels.
// ============================================================

const visor = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  transparentMaterial(COLOR.blue, CONFIG.visorOpacity)
);

visor.position.z = -1.05;
visor.material.depthTest = false;
visor.renderOrder = 100;
camera.add(visor);

// ============================================================
// COMPOUND-EYE OVERLAY
// Stronger around the periphery; clearer in the centre.
// ============================================================

const eyeTexture = makeCanvasTexture(1024, 1024, (context) => {
  const gradient = context.createRadialGradient(
    512, 512, 150,
    512, 512, 720
  );

  gradient.addColorStop(0, "rgba(25,10,50,0)");
  gradient.addColorStop(0.5, "rgba(65,20,110,0.06)");
  gradient.addColorStop(1, "rgba(65,20,110,0.30)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, 1024, 1024);

  const radius = 48;
  const hexHeight = Math.sqrt(3) * radius;

  context.lineWidth = 1.8;

  for (let column = -1; column < 17; column++) {
    for (let row = -1; row < 15; row++) {
      const x = column * radius * 1.5;
      const y =
        row * hexHeight +
        (Math.abs(column % 2) === 1 ? hexHeight / 2 : 0);

      const distance = Math.hypot(x - 512, y - 512);
      const strength = Math.min(1, distance / 650);
      const alpha = 0.045 + strength * 0.20;

      context.strokeStyle =
        `rgba(190,125,255,${alpha})`;

      context.beginPath();

      for (let corner = 0; corner < 6; corner++) {
        const angle = corner * Math.PI / 3;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;

        if (corner === 0) {
          context.moveTo(px, py);
        } else {
          context.lineTo(px, py);
        }
      }

      context.closePath();
      context.stroke();
    }
  }
});

const compoundEye = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshBasicMaterial({
    map: eyeTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  })
);

compoundEye.position.z = -1.02;
compoundEye.renderOrder = 101;
camera.add(compoundEye);

// ============================================================
// ANTENNAE AND PROBOSCIS
// ============================================================

function makeHeadLine(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map((point) => new THREE.Vector3(...point))
  );

  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      depthWrite: false
    })
  );

  line.renderOrder = 110;
  camera.add(line);

  return line;
}

const leftAntenna = makeHeadLine(
  [
    [-0.15, 0.12, -0.4],
    [-0.23, 0.20, -0.5],
    [-0.30, 0.26, -0.6]
  ],
  COLOR.magenta
);

const rightAntenna = makeHeadLine(
  [
    [0.15, 0.12, -0.4],
    [0.23, 0.20, -0.5],
    [0.30, 0.26, -0.6]
  ],
  COLOR.magenta
);

const proboscis = makeHeadLine(
  [
    [0, -0.13, -0.3],
    [0, -0.08, -0.6]
  ],
  COLOR.cream
);

// ============================================================
// HEADSET HUD
// ============================================================

const hudCanvas = document.createElement("canvas");
hudCanvas.width = 1024;
hudCanvas.height = 256;

const hudContext = hudCanvas.getContext("2d");

if (!hudContext) {
  throw new Error("Could not create HUD.");
}

const hudTexture = new THREE.CanvasTexture(hudCanvas);
hudTexture.colorSpace = THREE.SRGBColorSpace;

const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.88, 0.22),
  new THREE.MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  })
);

hud.position.set(0, -0.30, -1);
hud.renderOrder = 120;
camera.add(hud);

function updateHUD(message) {
  const key = `${stingCount}|${message}`;
  if (key === lastHUDKey) return;
  lastHUDKey = key;

  hudContext.clearRect(0, 0, 1024, 256);

  hudContext.fillStyle = "rgba(16,10,46,0.78)";
  hudContext.fillRect(0, 0, 1024, 256);

  hudContext.textAlign = "center";
  hudContext.fillStyle = "#FFF0B3";
  hudContext.font = "bold 50px sans-serif";

  hudContext.fillText(
    `${CONFIG.version} · STINGS: ${stingCount}`,
    512,
    85
  );

  hudContext.fillStyle = "#E8DCFF";
  hudContext.font = "30px sans-serif";
  hudContext.fillText(message, 512, 145);

  // Decorative reservoir: fills over groups of ten stings.
  const fill = stingCount === 0
    ? 0
    : (((stingCount - 1) % 10) + 1) / 10;

  hudContext.fillStyle = "#382455";
  hudContext.fillRect(212, 190, 600, 16);

  hudContext.fillStyle = "#FF7935";
  hudContext.fillRect(212, 190, 600 * fill, 16);

  hudTexture.needsUpdate = true;
}

// ============================================================
// ENVIRONMENTAL PARTICLES AND FLOOR RIPPLE GRAPHICS
// These do not scan or reconstruct the real room.
// ============================================================

const environment = new THREE.Group();
scene.add(environment);

const environmentPositions = new Float32Array(
  CONFIG.environmentParticles * 3
);

const environmentSeeds = [];

for (let i = 0; i < CONFIG.environmentParticles; i++) {
  environmentSeeds.push({
    x: (Math.random() - 0.5) * 7,
    y: 0.15 + Math.random() * 2.7,
    z: (Math.random() - 0.5) * 7,
    phase: Math.random() * Math.PI * 2
  });
}

const environmentGeometry = new THREE.BufferGeometry();

environmentGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(environmentPositions, 3)
);

const environmentPoints = new THREE.Points(
  environmentGeometry,
  new THREE.PointsMaterial({
    color: COLOR.violet,
    map: particleTexture,
    size: 0.045,
    opacity: 0.45,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true
  })
);

environmentPoints.frustumCulled = false;
environment.add(environmentPoints);

const floorRipples = [];

if (CONFIG.showFloorRipples) {
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1, 64),
      transparentMaterial(COLOR.violet, 0.10)
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;

    environment.add(ring);
    floorRipples.push(ring);
  }
}

// ============================================================
// FALSE-COLOUR MATERIAL FOR VIRTUAL HOST PARTS
// The gradient applies ONLY to these virtual meshes.
// ============================================================

function makeHeatMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFocus: { value: 0 },
      uFlash: { value: 0 }
    },

    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vLocalPosition;

      void main() {
        vNormalView = normalize(normalMatrix * normal);
        vLocalPosition = position;

        gl_Position =
          projectionMatrix *
          modelViewMatrix *
          vec4(position, 1.0);
      }
    `,

    fragmentShader: `
      uniform float uTime;
      uniform float uFocus;
      uniform float uFlash;

      varying vec3 vNormalView;
      varying vec3 vLocalPosition;

      void main() {
        float facing = max(
          normalize(vNormalView).z,
          0.0
        );

        float heat = pow(facing, 0.7);

        heat += 0.035 * sin(
          vLocalPosition.y * 24.0 - uTime * 1.8
        );

        heat = clamp(heat, 0.0, 1.0);

        vec3 violet = vec3(0.30, 0.08, 0.55);
        vec3 magenta = vec3(0.93, 0.16, 0.46);
        vec3 orange = vec3(1.0, 0.47, 0.21);
        vec3 cream = vec3(1.0, 0.94, 0.70);

        vec3 color = mix(
          violet,
          magenta,
          smoothstep(0.0, 0.55, heat)
        );

        color = mix(
          color,
          orange,
          smoothstep(0.45, 0.95, heat)
        );

        color = mix(
          color,
          cream,
          smoothstep(0.82, 1.0, heat) *
          (0.25 + uFocus * 0.45)
        );

        color = mix(color, cream, uFlash * 0.7);

        float alpha =
          0.24 +
          heat * 0.20 +
          uFocus * 0.08;

        gl_FragColor = vec4(color, alpha);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,

    transparent: true,
    depthWrite: false
  });
}

// ============================================================
// HOST SIGNATURES: HEAD, SHOULDERS, TORSO, ARMS
// ============================================================

function disposeHost(host) {
  scene.remove(host);

  const geometries = new Set();
  const materials = new Set();

  host.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);

    if (Array.isArray(object.material)) {
      object.material.forEach((material) => materials.add(material));
    } else if (object.material) {
      materials.add(object.material);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());

  // Shared particleTexture is intentionally not disposed.
}

function clearHosts() {
  hosts.forEach(disposeHost);
  hosts.length = 0;
}

function createHost(stingPosition) {
  if (hosts.length >= CONFIG.maximumHosts) {
    disposeHost(hosts.shift());
  }

  const host = new THREE.Group();

  // Face the user when placed; remain stationary afterwards.
  host.rotation.y = Math.atan2(
    headPosition.x - stingPosition.x,
    headPosition.z - stingPosition.z
  );

  const rotatedOffset = PATCH_OFFSET.clone()
    .applyQuaternion(host.quaternion);

  host.position.copy(stingPosition).sub(rotatedOffset);

  const heatMaterial = makeHeatMaterial();

  // Torso.
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.23, 0.48, 5, 20),
    heatMaterial
  );

  torso.scale.z = 0.65;
  host.add(torso);

  // Head.
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 20, 14),
    heatMaterial
  );

  head.position.set(0, 0.64, 0);
  head.scale.set(0.88, 1.05, 0.85);
  host.add(head);

  // Shoulders.
  const shoulders = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 12),
    heatMaterial
  );

  shoulders.position.set(0, 0.30, 0);
  shoulders.scale.set(0.32, 0.10, 0.15);
  host.add(shoulders);

  // Arms.
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.06, 0.35, 4, 12),
      heatMaterial
    );

    arm.position.set(side * 0.29, 0.015, 0);
    arm.rotation.z = side * 0.15;
    arm.scale.z = 0.8;

    host.add(arm);
  }

  // Small bright inner torso.
  const innerTorso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.10, 0.23, 4, 16),
    transparentMaterial(COLOR.cream, 0.12)
  );

  innerTorso.position.z = 0.05;
  innerTorso.scale.z = 0.5;
  host.add(innerTorso);

  // Actual interactive sting patch.
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(0.10, 32),
    transparentMaterial(COLOR.magenta, 0.85)
  );

  patch.position.copy(PATCH_OFFSET);
  patch.scale.y = 0.85;
  patch.userData.host = host;
  host.add(patch);

  const warmPatch = new THREE.Mesh(
    new THREE.CircleGeometry(0.070, 32),
    transparentMaterial(COLOR.orange, 0.95)
  );

  warmPatch.position.z = 0.003;
  patch.add(warmPatch);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.030, 24),
    transparentMaterial(COLOR.cream, 0.4)
  );

  core.position.z = 0.006;
  patch.add(core);

  // Three rotating acquisition segments.
  const segments = new THREE.Group();

  segments.position.copy(PATCH_OFFSET);
  segments.position.z += 0.015;
  host.add(segments);

  for (let i = 0; i < 3; i++) {
    const segment = new THREE.Mesh(
      new THREE.RingGeometry(
        0.125,
        0.136,
        24,
        1,
        i * Math.PI * 2 / 3,
        Math.PI * 0.48
      ),
      transparentMaterial(COLOR.magenta, 0.7)
    );

    segments.add(segment);
  }

  // Complete ring means ready.
  const closedRing = new THREE.Mesh(
    new THREE.RingGeometry(0.125, 0.138, 48),
    transparentMaterial(COLOR.cream, 0.95)
  );

  closedRing.position.copy(segments.position);
  closedRing.visible = false;
  host.add(closedRing);

  // Sting ripple.
  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.10, 0.112, 48),
    transparentMaterial(COLOR.orange, 0)
  );

  ripple.position.copy(segments.position);
  ripple.position.z += 0.005;
  ripple.visible = false;
  host.add(ripple);

  // Scent trail.
  const scentPositions = new Float32Array(
    CONFIG.scentParticles * 3
  );

  const scentGeometry = new THREE.BufferGeometry();

  scentGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(scentPositions, 3)
  );

  const scent = new THREE.Points(
    scentGeometry,
    new THREE.PointsMaterial({
      color: COLOR.magenta,
      map: particleTexture,
      size: 0.06,
      opacity: 0.75,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true
    })
  );

  scent.frustumCulled = false;
  host.add(scent);

  host.userData = {
    heatMaterial,
    patch,
    core,
    segments,
    closedRing,
    ripple,
    scent,
    scentPositions,
    focus: 0,
    aimed: false,
    ready: false,
    lastStung: -Infinity,
    phase: Math.random() * Math.PI * 2
  };

  scene.add(host);
  hosts.push(host);

  return host;
}

// Desktop preview. These are replaced when XR starts.
createHost(new THREE.Vector3(-0.45, 1.4, -1.4));
createHost(new THREE.Vector3(0.45, 1.4, -1.4));

// ============================================================
// CONTROLLER RAYS AND STING INTERACTION
// ============================================================

function setControllerRay(controller) {
  scene.updateMatrixWorld(true);

  rayOrigin.setFromMatrixPosition(controller.matrixWorld);
  rayRotation.extractRotation(controller.matrixWorld);

  rayDirection
    .set(0, 0, -1)
    .applyMatrix4(rayRotation)
    .normalize();

  raycaster.set(rayOrigin, rayDirection);
  raycaster.near = 0;
  raycaster.far = CONFIG.stingDistance;
}

function getControllerHit(controller) {
  if (!controller.visible || !controller.userData.inputSource) {
    return null;
  }

  setControllerRay(controller);

  const patches = hosts.map((host) => host.userData.patch);
  const hits = raycaster.intersectObjects(patches, false);

  return hits.length ? hits[0] : null;
}

function placeHost(controller) {
  if (!renderer.xr.isPresenting || !controller.visible) return;

  setControllerRay(controller);

  const position = rayOrigin.clone().addScaledVector(
    rayDirection,
    CONFIG.placementDistance
  );

  createHost(position);
  showFeedback("Host placed — aim at the orange patch.");
}

function sting(controller) {
  if (!renderer.xr.isPresenting) return;

  const hit = getControllerHit(controller);

  if (!hit) {
    showFeedback("Aim at a small orange sting patch.");
    return;
  }

  const host = hit.object.userData.host;
  const data = host.userData;

  if (now - data.lastStung < CONFIG.cooldownSeconds) {
    showFeedback("Recovering…", 0.5);
    return;
  }

  // This specific controller must have acquired the host.
  if (
    controller.userData.aimedHost !== host ||
    controller.userData.aimTime < CONFIG.acquisitionSeconds
  ) {
    showFeedback("Hold your aim until the ring closes.");
    return;
  }

  data.lastStung = now;
  data.focus = 0;
  data.ready = false;

  for (const other of controllers) {
    if (other.userData.aimedHost === host) {
      other.userData.aimTime = 0;
    }
  }

  stingCount += 1;
  proboscisUntil = now + 0.2;

  showFeedback("Sting collected!");

  const actuator =
    controller.userData.inputSource
      ?.gamepad?.hapticActuators?.[0];

  if (actuator) {
    try {
      Promise.resolve(actuator.pulse(0.45, 90)).catch(() => {});
    } catch {
      // Optional vibration must not interrupt the app.
    }
  }
}

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);

  controller.userData.inputSource = null;
  controller.userData.aimedHost = null;
  controller.userData.aimTime = 0;

  controller.addEventListener("connected", (event) => {
    controller.userData.inputSource = event.data;
  });

  controller.addEventListener("disconnected", () => {
    controller.userData.inputSource = null;
    controller.userData.aimedHost = null;
    controller.userData.aimTime = 0;
  });

  controller.addEventListener("selectstart", () => {
    sting(controller);
  });

  controller.addEventListener("squeezestart", () => {
    placeHost(controller);
  });

  // Short pointer instead of a long shooting-style laser.
  const pointer = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -0.18)
    ]),
    new THREE.LineBasicMaterial({
      color: COLOR.cream,
      transparent: true,
      opacity: 0.75
    })
  );

  controller.add(pointer);

  // World-space dot appears when a patch is hit.
  const aimDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 10, 8),
    new THREE.MeshBasicMaterial({
      color: COLOR.cream,
      depthTest: false
    })
  );

  aimDot.visible = false;
  aimDot.renderOrder = 20;
  scene.add(aimDot);

  controller.userData.aimDot = aimDot;

  scene.add(controller);
  controllers.push(controller);
}

// ============================================================
// ANIMATION HELPERS
// ============================================================

function updateEnvironment(time) {
  environmentSeeds.forEach((seed, i) => {
    const index = i * 3;

    environmentPositions[index] =
      seed.x + Math.sin(time * 0.18 + seed.phase) * 0.12;

    environmentPositions[index + 1] =
      seed.y + Math.sin(time * 0.28 + seed.phase) * 0.08;

    environmentPositions[index + 2] =
      seed.z + Math.cos(time * 0.16 + seed.phase) * 0.12;
  });

  environmentGeometry.attributes.position.needsUpdate = true;

  floorRipples.forEach((ring, i) => {
    const cycle = (time * 0.09 + i / 3) % 1;

    ring.scale.setScalar(0.4 + cycle * 3.6);
    ring.material.opacity = (1 - cycle) * 0.11;
  });
}

function updateAiming(delta) {
  for (const host of hosts) {
    host.userData.aimed = false;
    host.userData.focus = 0;
    host.userData.ready = false;
  }

  for (const controller of controllers) {
    const hit = renderer.xr.isPresenting
      ? getControllerHit(controller)
      : null;

    const host = hit ? hit.object.userData.host : null;
    const dot = controller.userData.aimDot;

    dot.visible = Boolean(hit);

    if (hit) dot.position.copy(hit.point);

    if (controller.userData.aimedHost !== host) {
      controller.userData.aimedHost = host;
      controller.userData.aimTime = 0;
    }

    if (!host) {
      controller.userData.aimTime = 0;
      continue;
    }

    const data = host.userData;
    const recovering =
      now - data.lastStung < CONFIG.cooldownSeconds;

    if (recovering) {
      controller.userData.aimTime = 0;
    } else {
      controller.userData.aimTime += delta;
    }

    const focus = Math.min(
      1,
      controller.userData.aimTime / CONFIG.acquisitionSeconds
    );

    data.aimed = true;
    data.focus = Math.max(data.focus, focus);
    data.ready = !recovering && data.focus >= 1;
  }
}

function updateHost(host, time) {
  const data = host.userData;
  const age = time - data.lastStung;

  const recovering = age < CONFIG.cooldownSeconds;
  const flash = Math.max(0, 1 - age / 0.45);

  data.heatMaterial.uniforms.uTime.value = time + data.phase;
  data.heatMaterial.uniforms.uFocus.value = data.focus;
  data.heatMaterial.uniforms.uFlash.value = flash;

  data.patch.material.opacity = recovering ? 0.35 : 0.85;
  data.core.material.opacity = 0.35 + data.focus * 0.65;

  data.segments.visible = !data.ready;
  data.closedRing.visible = data.ready;

  data.segments.rotation.z = time * 0.4;
  data.segments.scale.setScalar(1.3 - data.focus * 0.3);

  for (const segment of data.segments.children) {
    segment.material.color.setHex(
      data.aimed ? COLOR.orange : COLOR.magenta
    );

    segment.material.opacity = recovering ? 0.2 : 0.75;
  }

  data.ripple.visible = age >= 0 && age < 0.65;

  if (data.ripple.visible) {
    data.ripple.scale.setScalar(1 + age * 5);
    data.ripple.material.opacity = (1 - age / 0.65) * 0.9;
  }

  // Fictional scent particles drift out from the host.
  for (let i = 0; i < CONFIG.scentParticles; i++) {
    const u = (i / CONFIG.scentParticles + time * 0.10) % 1;
    const index = i * 3;
    const swirl = u * Math.PI * 3 + data.phase;

    data.scentPositions[index] =
      PATCH_OFFSET.x + Math.sin(swirl) * 0.18 * u;

    data.scentPositions[index + 1] =
      PATCH_OFFSET.y + u * 0.28 + Math.cos(swirl) * 0.05;

    data.scentPositions[index + 2] =
      PATCH_OFFSET.z + u * 1.45;
  }

  data.scent.geometry.attributes.position.needsUpdate = true;

  data.scent.material.color.setHex(
    data.aimed ? COLOR.orange : COLOR.magenta
  );

  data.scent.material.opacity =
    recovering ? 0.25 : 0.75 + data.focus * 0.15;
}

function updateAntennae() {
  let nearestHost = null;
  let nearestDistance = Infinity;

  for (const host of hosts) {
    host.userData.patch.getWorldPosition(tempPosition);

    const distance = tempPosition.distanceTo(headPosition);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestHost = host;
    }
  }

  leftAntenna.material.opacity = 0.25;
  rightAntenna.material.opacity = 0.25;

  if (!nearestHost) return;

  nearestHost.userData.patch.getWorldPosition(tempPosition);

  inverseHeadRotation.copy(headQuaternion).invert();

  tempPosition
    .sub(headPosition)
    .applyQuaternion(inverseHeadRotation)
    .normalize();

  if (tempPosition.x < -0.15) {
    leftAntenna.material.opacity = 0.9;
  } else if (tempPosition.x > 0.15) {
    rightAntenna.material.opacity = 0.9;
  } else {
    leftAntenna.material.opacity = 0.75;
    rightAntenna.material.opacity = 0.75;
  }

  const focused = hosts.some((host) => host.userData.aimed);
  const color = focused ? COLOR.orange : COLOR.magenta;

  leftAntenna.material.color.setHex(color);
  rightAntenna.material.color.setHex(color);
}

// ============================================================
// WEBXR STARTUP
// ============================================================

async function checkSupport() {
  if (!window.isSecureContext) {
    startButton.textContent = "HTTPS required";
    statusText.textContent =
      `${CONFIG.version}: open the HTTPS published website.`;
    return;
  }

  if (!navigator.xr) {
    startButton.textContent = "Desktop preview";
    statusText.textContent =
      `${CONFIG.version} loaded. Open on Quest to enter AR.`;
    return;
  }

  try {
    const supported =
      await navigator.xr.isSessionSupported("immersive-ar");

    if (!supported) {
      startButton.textContent = "AR unavailable";
      statusText.textContent =
        `${CONFIG.version} loaded, but immersive-ar is unavailable.`;
      return;
    }

    startButton.disabled = false;
    startButton.textContent = "Enter Sensory V6";

    statusText.textContent =
      `${CONFIG.version} ready: grip places a host; trigger stings.`;
  } catch (error) {
    statusText.textContent =
      "XR support check failed: " + error.message;
  }
}

startButton.addEventListener("click", async () => {
  if (activeSession) return;

  startButton.disabled = true;
  let session = null;

  try {
    session = await navigator.xr.requestSession(
      "immersive-ar",
      {
        requiredFeatures: ["local-floor"]
      }
    );

    activeSession = session;

    session.addEventListener("end", () => {
      activeSession = null;
      needsInitialHosts = false;

      for (const controller of controllers) {
        controller.userData.aimedHost = null;
        controller.userData.aimTime = 0;
        controller.userData.aimDot.visible = false;
      }

      panel.style.display = "";
      startButton.disabled = false;
      startButton.textContent = "Enter Sensory V6";
      statusText.textContent = `${CONFIG.version}: session ended.`;
    });

    clearHosts();

    stingCount = 0;
    feedbackUntil = 0;
    proboscisUntil = 0;
    previousTime = null;

    for (const controller of controllers) {
      controller.userData.aimedHost = null;
      controller.userData.aimTime = 0;
    }

    await renderer.xr.setSession(session);

    needsInitialHosts = true;
    panel.style.display = "none";
  } catch (error) {
    if (session) {
      try {
        await session.end();
      } catch {
        // Keep the original startup error.
      }
    }

    activeSession = null;
    panel.style.display = "";
    startButton.disabled = false;

    statusText.textContent =
      "Could not start XR: " + error.message;

    console.error(error);
  }
});

// ============================================================
// MAIN ANIMATION LOOP
// ============================================================

renderer.setAnimationLoop((milliseconds, frame) => {
  now = milliseconds / 1000;

  const delta = previousTime === null
    ? 0
    : Math.max(0, Math.min(now - previousTime, 0.05));

  previousTime = now;

  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const pose = referenceSpace
      ? frame.getViewerPose(referenceSpace)
      : null;

    if (pose) {
      const position = pose.transform.position;
      const orientation = pose.transform.orientation;

      headPosition.set(position.x, position.y, position.z);

      headQuaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w
      );

      if (needsInitialHosts) {
        environment.position.set(
          headPosition.x,
          0,
          headPosition.z
        );

        const forward = new THREE.Vector3(0, 0, -1)
          .applyQuaternion(headQuaternion);

        forward.y = 0;

        if (forward.lengthSq() < 0.001) {
          forward.set(0, 0, -1);
        }

        forward.normalize();

        const right = new THREE.Vector3(
          -forward.z,
          0,
          forward.x
        );

        for (const offset of [-0.5, 0.5]) {
          const position = headPosition.clone()
            .addScaledVector(forward, 1.4)
            .addScaledVector(right, offset);

          position.y -= 0.2;
          createHost(position);
        }

        needsInitialHosts = false;
      }
    }
  } else {
    headPosition.copy(camera.position);
    headQuaternion.copy(camera.quaternion);
  }

  updateEnvironment(now);
  updateAiming(delta);

  for (const host of hosts) {
    updateHost(host, now);
  }

  scene.updateMatrixWorld(true);
  updateAntennae();

  proboscis.scale.z = now < proboscisUntil ? 1.35 : 1;

  let message = "Grip: place host | Follow the scent trails";

  if (hosts.some((host) => host.userData.aimed)) {
    message = hosts.some((host) => host.userData.ready)
      ? "Host acquired — press trigger"
      : "Hold your aim — acquiring host";
  }

  if (now < feedbackUntil) {
    message = feedback;
  }

  updateHUD(message);
  renderer.render(scene, camera);
});

// ============================================================
// RESIZE AND SUPPORT CHECK
// ============================================================

window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
});

await checkSupport();

// END OF MOSQUITO SENSORY V6
