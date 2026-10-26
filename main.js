import * as THREE from
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

// ============================================================
// MOSQUITO SENSORY V9 — RANDOM TARGET ROUNDS
//
// Artistic sensory overlays, not actual thermal imaging.
// Targets are virtual and do not account for real obstacles.
// Remain in your safe play area; use controller-ray aiming.
// ============================================================

const CONFIG = {
  version: "SENSORY V9",

  minimumTargets: 7,
  maximumTargets: 20,

  // Distance from the user's starting position.
  minimumDistance: 0.9,
  maximumDistance: 4.0,

  // Patch height relative to the user's head.
  minimumHeightOffset: -1.0,
  maximumHeightOffset: 0.9,

  minimumTargetSpacing: 0.55,
  stingDistance: 6.0,
  acquisitionSeconds: 0.3,
  nextRoundDelay: 1.8,

  environmentParticles: 150,
  scentParticles: 20,
  filterOpacity: 0.85,
  showFloorRipples: true
};

const COLOR = {
  purple: 0x6815b5,
  violet: 0xa020f0,
  magenta: 0xff1493,
  orange: 0xff8500,
  yellow: 0xffeb70
};

// ============================================================
// HTML ELEMENTS
// ============================================================

const startButton = document.getElementById("start");
const statusText = document.getElementById("status");
const panel = document.getElementById("panel");

if (!startButton || !statusText || !panel) {
  throw new Error(
    "index.html needs elements with IDs: start, status, panel."
  );
}

startButton.disabled = true;
startButton.textContent = "Loading Sensory V9…";
statusText.textContent = "Preparing random target rounds.";

// ============================================================
// SCENE AND RENDERER
// ============================================================

const scene = new THREE.Scene();

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
const PATCH_OFFSET = new THREE.Vector3(-0.12, 0.22, 0.22);

let activeSession = null;
let needsInitialRound = false;
let previousTime = null;
let now = 0;

let roundNumber = 0;
let roundTotal = 0;
let roundCollected = 0;
let totalStings = 0;

let nextRoundAt = null;
let lastManualRoundAt = -Infinity;

let proboscisUntil = 0;
let feedback = "";
let feedbackUntil = 0;
let lastHUDKey = "";

// ============================================================
// HELPERS
// ============================================================

function randomBetween(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function randomInteger(minimum, maximum) {
  return Math.floor(
    randomBetween(minimum, maximum + 1)
  );
}

function transparentMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false
  });
}

function makeCanvasTexture(width, height, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create canvas texture.");
  }

  draw(context);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

function showFeedback(message, duration = 1.2) {
  feedback = message;
  feedbackUntil = now + duration;
}

const particleTexture = makeCanvasTexture(
  64,
  64,
  (context) => {
    const gradient = context.createRadialGradient(
      32, 32, 0,
      32, 32, 32
    );

    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.75)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");

    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
);

// ============================================================
// PURPLE / MAGENTA / ORANGE / YELLOW FILTER
// Artistic view-attached overlay, not camera processing.
// ============================================================

const filterTexture = makeCanvasTexture(
  1024,
  1024,
  (context) => {
    context.fillStyle = "rgba(85,5,145,0.27)";
    context.fillRect(0, 0, 1024, 1024);

    function glow(x, y, radius, red, green, blue, alpha) {
      const gradient = context.createRadialGradient(
        x, y, 0,
        x, y, radius
      );

      gradient.addColorStop(
        0,
        `rgba(${red},${green},${blue},${alpha})`
      );

      gradient.addColorStop(
        1,
        `rgba(${red},${green},${blue},0)`
      );

      context.fillStyle = gradient;
      context.fillRect(0, 0, 1024, 1024);
    }

    glow(270, 460, 530, 255, 10, 155, 0.38);
    glow(770, 390, 510, 230, 10, 180, 0.34);
    glow(510, 200, 520, 115, 10, 220, 0.26);

    glow(270, 790, 330, 255, 100, 0, 0.32);
    glow(770, 790, 330, 255, 125, 0, 0.32);

    glow(300, 900, 210, 255, 230, 35, 0.24);
    glow(730, 900, 210, 255, 230, 35, 0.24);
  }
);

const visor = new THREE.Mesh(
  new THREE.PlaneGeometry(2.8, 2.8),
  new THREE.MeshBasicMaterial({
    map: filterTexture,
    transparent: true,
    opacity: CONFIG.filterOpacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false
  })
);

visor.position.z = -1.05;
visor.renderOrder = -100;
visor.frustumCulled = false;
camera.add(visor);

// ============================================================
// COMPOUND-EYE OVERLAY
// ============================================================

const eyeTexture = makeCanvasTexture(
  1024,
  1024,
  (context) => {
    const radius = 43;
    const height = Math.sqrt(3) * radius;

    context.lineWidth = 1.6;

    for (let column = -1; column < 19; column++) {
      for (let row = -1; row < 16; row++) {
        const x = column * radius * 1.5;

        const y =
          row * height +
          (Math.abs(column % 2) === 1 ? height / 2 : 0);

        const distance = Math.hypot(x - 512, y - 512);
        const alpha =
          0.025 + Math.min(1, distance / 600) * 0.21;

        context.strokeStyle =
          `rgba(255,115,220,${alpha})`;

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
  }
);

const compoundEye = new THREE.Mesh(
  new THREE.PlaneGeometry(2.8, 2.8),
  new THREE.MeshBasicMaterial({
    map: eyeTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  })
);

compoundEye.position.z = -1.02;
compoundEye.renderOrder = 100;
compoundEye.frustumCulled = false;
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
      depthWrite: false,
      toneMapped: false
    })
  );

  line.renderOrder = 110;
  line.frustumCulled = false;
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
  COLOR.yellow
);

// ============================================================
// HUD
// ============================================================

const hudCanvas = document.createElement("canvas");
hudCanvas.width = 1024;
hudCanvas.height = 300;

const hudContext = hudCanvas.getContext("2d");

if (!hudContext) {
  throw new Error("Could not create HUD.");
}

const hudTexture = new THREE.CanvasTexture(hudCanvas);
hudTexture.colorSpace = THREE.SRGBColorSpace;

const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.9, 0.264),
  new THREE.MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  })
);

hud.position.set(0, -0.32, -1);
hud.renderOrder = 120;
hud.frustumCulled = false;
camera.add(hud);

function updateHUD(message) {
  const key = [
    roundNumber,
    roundTotal,
    roundCollected,
    totalStings,
    message
  ].join("|");

  if (key === lastHUDKey) return;
  lastHUDKey = key;

  hudContext.clearRect(0, 0, 1024, 300);

  hudContext.fillStyle = "rgba(40,4,65,0.82)";
  hudContext.fillRect(0, 0, 1024, 300);

  hudContext.textAlign = "center";

  hudContext.fillStyle = "#FFD6F2";
  hudContext.font = "25px sans-serif";
  hudContext.fillText(CONFIG.version, 512, 40);

  hudContext.fillStyle = "#FFEB70";
  hudContext.font = "bold 44px sans-serif";

  hudContext.fillText(
    `ROUND ${roundNumber} · ${roundCollected}/${roundTotal}`,
    512,
    98
  );

  hudContext.fillStyle = "#FFD6F2";
  hudContext.font = "27px sans-serif";
  hudContext.fillText(message, 512, 153);

  hudContext.font = "23px sans-serif";
  hudContext.fillText(
    `Total stings: ${totalStings} · Grip: new random round`,
    512,
    199
  );

  const progress = roundTotal > 0
    ? roundCollected / roundTotal
    : 0;

  hudContext.fillStyle = "#66205F";
  hudContext.fillRect(160, 243, 704, 17);

  const gradient = hudContext.createLinearGradient(
    160, 0, 864, 0
  );

  gradient.addColorStop(0, "#FF1493");
  gradient.addColorStop(0.5, "#FF8500");
  gradient.addColorStop(1, "#FFEB70");

  hudContext.fillStyle = gradient;
  hudContext.fillRect(160, 243, 704 * progress, 17);

  hudTexture.needsUpdate = true;
}

// ============================================================
// ENVIRONMENTAL PARTICLES AND FLOOR RIPPLE GRAPHICS
// ============================================================

const environment = new THREE.Group();
scene.add(environment);

const environmentPositions = new Float32Array(
  CONFIG.environmentParticles * 3
);

const environmentColors = new Float32Array(
  CONFIG.environmentParticles * 3
);

const environmentSeeds = [];

const particlePalette = [
  new THREE.Color(COLOR.violet),
  new THREE.Color(COLOR.magenta),
  new THREE.Color(COLOR.orange)
];

for (let i = 0; i < CONFIG.environmentParticles; i++) {
  environmentSeeds.push({
    x: randomBetween(-5, 5),
    y: randomBetween(0.15, 3),
    z: randomBetween(-5, 5),
    phase: randomBetween(0, Math.PI * 2)
  });

  particlePalette[
    i % 10 === 0 ? 2 : i % 2
  ].toArray(environmentColors, i * 3);
}

const environmentGeometry = new THREE.BufferGeometry();

environmentGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(environmentPositions, 3)
);

environmentGeometry.setAttribute(
  "color",
  new THREE.BufferAttribute(environmentColors, 3)
);

const environmentPoints = new THREE.Points(
  environmentGeometry,
  new THREE.PointsMaterial({
    vertexColors: true,
    map: particleTexture,
    size: 0.045,
    opacity: 0.5,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false
  })
);

environmentPoints.frustumCulled = false;
environment.add(environmentPoints);

const floorRipples = [];

if (CONFIG.showFloorRipples) {
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1, 48),
      transparentMaterial(
        i === 1 ? COLOR.magenta : COLOR.violet,
        0.1
      )
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;

    environment.add(ring);
    floorRipples.push(ring);
  }
}

// ============================================================
// HOT SIGNATURE SHADER
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

        vec3 purple = vec3(0.41, 0.03, 0.72);
        vec3 magenta = vec3(1.0, 0.04, 0.55);
        vec3 orange = vec3(1.0, 0.38, 0.0);
        vec3 yellow = vec3(1.0, 0.90, 0.10);

        vec3 color = mix(
          purple,
          magenta,
          smoothstep(0.0, 0.45, heat)
        );

        color = mix(
          color,
          orange,
          smoothstep(0.40, 0.80, heat)
        );

        color = mix(
          color,
          yellow,
          smoothstep(0.72, 1.0, heat) *
          (0.65 + uFocus * 0.35)
        );

        color = mix(color, yellow, uFlash * 0.8);

        float alpha =
          0.25 + heat * 0.23 + uFocus * 0.08;

        gl_FragColor = vec4(color, alpha);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,

    transparent: true,
    depthWrite: false,
    toneMapped: false
  });
}

// ============================================================
// HOST CREATION AND CLEANUP
// ============================================================

function disposeHost(host) {
  scene.remove(host);

  const geometries = new Set();
  const materials = new Set();

  host.traverse((object) => {
    if (object.geometry) {
      geometries.add(object.geometry);
    }

    if (Array.isArray(object.material)) {
      object.material.forEach((material) => {
        materials.add(material);
      });
    } else if (object.material) {
      materials.add(object.material);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());

  // Shared particleTexture is intentionally retained.
}

function resetControllerAim() {
  for (const controller of controllers) {
    controller.userData.aimedHost = null;
    controller.userData.aimTime = 0;

    if (controller.userData.aimDot) {
      controller.userData.aimDot.visible = false;
    }
  }
}

function clearHosts() {
  resetControllerAim();
  hosts.forEach(disposeHost);
  hosts.length = 0;
}

function createHost(stingPosition) {
  const host = new THREE.Group();

  host.rotation.y = Math.atan2(
    headPosition.x - stingPosition.x,
    headPosition.z - stingPosition.z
  );

  const rotatedOffset = PATCH_OFFSET.clone()
    .applyQuaternion(host.quaternion);

  host.position.copy(stingPosition).sub(rotatedOffset);

  const heatMaterial = makeHeatMaterial();

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.23, 0.48, 4, 12),
    heatMaterial
  );

  torso.scale.z = 0.65;
  host.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 12, 10),
    heatMaterial
  );

  head.position.set(0, 0.64, 0);
  head.scale.set(0.88, 1.05, 0.85);
  host.add(head);

  const shoulders = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    heatMaterial
  );

  shoulders.position.set(0, 0.30, 0);
  shoulders.scale.set(0.32, 0.10, 0.15);
  host.add(shoulders);

  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.06, 0.35, 3, 8),
      heatMaterial
    );

    arm.position.set(side * 0.29, 0.015, 0);
    arm.rotation.z = side * 0.15;
    arm.scale.z = 0.8;
    host.add(arm);
  }

  const innerTorso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.10, 0.23, 3, 10),
    transparentMaterial(COLOR.yellow, 0.15)
  );

  innerTorso.position.z = 0.05;
  innerTorso.scale.z = 0.5;
  host.add(innerTorso);

  // Slightly larger patch for distant target aiming.
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(0.12, 24),
    transparentMaterial(COLOR.magenta, 0.88)
  );

  patch.position.copy(PATCH_OFFSET);
  patch.scale.y = 0.85;
  patch.userData.host = host;
  host.add(patch);

  const warmPatch = new THREE.Mesh(
    new THREE.CircleGeometry(0.085, 24),
    transparentMaterial(COLOR.orange, 0.98)
  );

  warmPatch.position.z = 0.003;
  patch.add(warmPatch);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 20),
    transparentMaterial(COLOR.yellow, 0.5)
  );

  core.position.z = 0.006;
  patch.add(core);

  const segments = new THREE.Group();
  segments.position.copy(PATCH_OFFSET);
  segments.position.z += 0.015;
  host.add(segments);

  for (let i = 0; i < 3; i++) {
    const segment = new THREE.Mesh(
      new THREE.RingGeometry(
        0.145,
        0.158,
        16,
        1,
        i * Math.PI * 2 / 3,
        Math.PI * 0.48
      ),
      transparentMaterial(COLOR.magenta, 0.75)
    );

    segments.add(segment);
  }

  const closedRing = new THREE.Mesh(
    new THREE.RingGeometry(0.145, 0.16, 32),
    transparentMaterial(COLOR.yellow, 0.98)
  );

  closedRing.position.copy(segments.position);
  closedRing.visible = false;
  host.add(closedRing);

  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.135, 32),
    transparentMaterial(COLOR.orange, 0)
  );

  ripple.position.copy(segments.position);
  ripple.position.z += 0.005;
  ripple.visible = false;
  host.add(ripple);

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
      opacity: 0.78,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false
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
    collected: false,
    collectedAt: -Infinity,
    phase: randomBetween(0, Math.PI * 2)
  };

  scene.add(host);
  hosts.push(host);

  return host;
}

// ============================================================
// RANDOM ROUND GENERATION
// ============================================================

function generateRandomPositions(count) {
  const positions = [];

  for (let i = 0; i < count; i++) {
    let candidate = null;

    // Try to avoid patches being very close together.
    for (let attempt = 0; attempt < 100; attempt++) {
      const angle = randomBetween(0, Math.PI * 2);

      const distance = randomBetween(
        CONFIG.minimumDistance,
        CONFIG.maximumDistance
      );

      const height = Math.max(
        0.65,
        headPosition.y + randomBetween(
          CONFIG.minimumHeightOffset,
          CONFIG.maximumHeightOffset
        )
      );

      candidate = new THREE.Vector3(
        headPosition.x + Math.sin(angle) * distance,
        height,
        headPosition.z - Math.cos(angle) * distance
      );

      const wellSpaced = positions.every((position) => {
        return position.distanceTo(candidate) >=
          CONFIG.minimumTargetSpacing;
      });

      if (wellSpaced) break;
    }

    // Count is always preserved, even if spacing attempts fail.
    positions.push(candidate);
  }

  return positions;
}

function startNewRound() {
  clearHosts();

  roundNumber += 1;
  roundCollected = 0;
  nextRoundAt = null;

  roundTotal = randomInteger(
    CONFIG.minimumTargets,
    CONFIG.maximumTargets
  );

  environment.position.set(
    headPosition.x,
    0,
    headPosition.z
  );

  const positions = generateRandomPositions(roundTotal);

  positions.forEach(createHost);

  showFeedback(
    `Round ${roundNumber}: find ${roundTotal} targets around you!`,
    2.2
  );
}

function requestManualRound() {
  if (!renderer.xr.isPresenting || needsInitialRound) return;

  // Prevent two grip presses from immediately making two rounds.
  if (now - lastManualRoundAt < 0.75) return;

  lastManualRoundAt = now;
  startNewRound();
}

// ============================================================
// CONTROLLER RAYS
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
  if (
    !controller.visible ||
    !controller.userData.inputSource
  ) {
    return null;
  }

  setControllerRay(controller);

  const patches = hosts
    .filter((host) => !host.userData.collected)
    .map((host) => host.userData.patch);

  const hits = raycaster.intersectObjects(patches, false);

  return hits.length ? hits[0] : null;
}

function sting(controller) {
  if (!renderer.xr.isPresenting || nextRoundAt !== null) {
    return;
  }

  const hit = getControllerHit(controller);

  if (!hit) {
    showFeedback("Aim at an orange sting patch.");
    return;
  }

  const host = hit.object.userData.host;
  const data = host.userData;

  if (data.collected) return;

  if (
    controller.userData.aimedHost !== host ||
    controller.userData.aimTime < CONFIG.acquisitionSeconds
  ) {
    showFeedback("Hold aim until the yellow ring closes.");
    return;
  }

  data.collected = true;
  data.collectedAt = now;
  data.focus = 0;
  data.ready = false;

  roundCollected += 1;
  totalStings += 1;
  proboscisUntil = now + 0.2;

  resetControllerAim();

  const remaining = roundTotal - roundCollected;

  if (remaining === 0) {
    nextRoundAt = now + CONFIG.nextRoundDelay;

    showFeedback(
      "Round complete! Preparing new targets…",
      CONFIG.nextRoundDelay
    );
  } else {
    showFeedback(`Collected! ${remaining} targets remaining.`);
  }

  const actuator =
    controller.userData.inputSource
      ?.gamepad?.hapticActuators?.[0];

  if (actuator) {
    try {
      Promise.resolve(
        actuator.pulse(0.45, 90)
      ).catch(() => {});
    } catch {
      // Haptics are optional.
    }
  }
}

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);

  controller.userData.inputSource = null;
  controller.userData.aimedHost = null;
  controller.userData.aimTime = 0;

  const aimDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.01, 8, 6),
    new THREE.MeshBasicMaterial({
      color: COLOR.yellow,
      depthTest: false,
      toneMapped: false
    })
  );

  aimDot.visible = false;
  aimDot.renderOrder = 20;
  scene.add(aimDot);

  controller.userData.aimDot = aimDot;

  controller.addEventListener("connected", (event) => {
    controller.userData.inputSource = event.data;
  });

  controller.addEventListener("disconnected", () => {
    controller.userData.inputSource = null;
    controller.userData.aimedHost = null;
    controller.userData.aimTime = 0;
    aimDot.visible = false;
  });

  controller.addEventListener("selectstart", () => {
    sting(controller);
  });

  controller.addEventListener("squeezestart", () => {
    requestManualRound();
  });

  const pointer = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -0.25)
    ]),
    new THREE.LineBasicMaterial({
      color: COLOR.yellow,
      transparent: true,
      opacity: 0.8,
      toneMapped: false
    })
  );

  controller.add(pointer);
  scene.add(controller);
  controllers.push(controller);
}

// ============================================================
// ANIMATION
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

    ring.scale.setScalar(0.4 + cycle * 4.5);
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

    controller.userData.aimTime += delta;

    const data = host.userData;

    data.aimed = true;

    data.focus = Math.max(
      data.focus,
      Math.min(
        1,
        controller.userData.aimTime /
          CONFIG.acquisitionSeconds
      )
    );

    data.ready = data.focus >= 1;
  }
}

function updateHost(host, time) {
  const data = host.userData;

  if (data.collected) {
    const age = time - data.collectedAt;

    data.heatMaterial.uniforms.uFlash.value =
      Math.max(0, 1 - age / 0.45);

    data.heatMaterial.uniforms.uTime.value = time;

    data.segments.visible = false;
    data.closedRing.visible = false;
    data.scent.visible = false;

    data.ripple.visible = age < 0.65;

    if (data.ripple.visible) {
      data.ripple.scale.setScalar(1 + age * 5);

      data.ripple.material.opacity =
        (1 - age / 0.65) * 0.9;
    }

    if (age >= 0.65) {
      host.visible = false;
    }

    return;
  }

  data.heatMaterial.uniforms.uTime.value =
    time + data.phase;

  data.heatMaterial.uniforms.uFocus.value = data.focus;
  data.heatMaterial.uniforms.uFlash.value = 0;

  data.core.material.opacity =
    0.45 + data.focus * 0.55;

  data.segments.visible = !data.ready;
  data.closedRing.visible = data.ready;

  data.segments.rotation.z = time * 0.4;
  data.segments.scale.setScalar(1.3 - data.focus * 0.3);

  for (const segment of data.segments.children) {
    segment.material.color.setHex(
      data.aimed ? COLOR.orange : COLOR.magenta
    );
  }

  for (let i = 0; i < CONFIG.scentParticles; i++) {
    const u = (
      i / CONFIG.scentParticles + time * 0.10
    ) % 1;

    const index = i * 3;
    const swirl = u * Math.PI * 3 + data.phase;

    data.scentPositions[index] =
      PATCH_OFFSET.x + Math.sin(swirl) * 0.18 * u;

    data.scentPositions[index + 1] =
      PATCH_OFFSET.y + u * 0.28 + Math.cos(swirl) * 0.05;

    data.scentPositions[index + 2] =
      PATCH_OFFSET.z + u * 1.1;
  }

  data.scent.geometry.attributes.position.needsUpdate = true;

  data.scent.material.color.setHex(
    data.aimed ? COLOR.orange : COLOR.magenta
  );

  data.scent.material.opacity =
    0.78 + data.focus * 0.12;
}

function updateAntennae() {
  let nearestHost = null;
  let nearestDistance = Infinity;

  for (const host of hosts) {
    if (host.userData.collected) continue;

    host.userData.patch.getWorldPosition(tempPosition);

    const distance =
      tempPosition.distanceTo(headPosition);

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

  const focused = hosts.some(
    (host) => host.userData.aimed
  );

  const color = focused ? COLOR.orange : COLOR.magenta;

  leftAntenna.material.color.setHex(color);
  rightAntenna.material.color.setHex(color);
}

function getGuidanceMessage() {
  if (nextRoundAt !== null) {
    return "Round complete — new targets incoming!";
  }

  if (hosts.some((host) => host.userData.ready)) {
    return "Target acquired — press trigger";
  }

  if (hosts.some((host) => host.userData.aimed)) {
    return "Hold aim — acquiring target";
  }

  let nearest = null;
  let nearestDistance = Infinity;

  for (const host of hosts) {
    if (host.userData.collected) continue;

    host.userData.patch.getWorldPosition(tempPosition);

    const distance = tempPosition.distanceTo(headPosition);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = host;
    }
  }

  if (!nearest) return "Find the warm signatures";

  nearest.userData.patch.getWorldPosition(tempPosition);

  inverseHeadRotation.copy(headQuaternion).invert();

  tempPosition
    .sub(headPosition)
    .applyQuaternion(inverseHeadRotation)
    .normalize();

  if (tempPosition.z > 0.15) {
    return "A target is behind you — turn carefully";
  }

  if (tempPosition.y > 0.35) {
    return "Look up — a target is above";
  }

  if (tempPosition.y < -0.35) {
    return "Look down — a target is below";
  }

  if (tempPosition.x < -0.3) {
    return "Look left — follow the scent trail";
  }

  if (tempPosition.x > 0.3) {
    return "Look right — follow the scent trail";
  }

  return "Aim at the orange patch";
}

// ============================================================
// WEBXR STARTUP
// ============================================================

async function checkSupport() {
  if (!window.isSecureContext) {
    startButton.textContent = "HTTPS required";
    statusText.textContent = "Open your published HTTPS website.";
    return;
  }

  if (!navigator.xr) {
    startButton.textContent = "Desktop preview";
    statusText.textContent =
      "Sensory V9 loaded. Open on Quest for AR.";
    return;
  }

  try {
    const supported =
      await navigator.xr.isSessionSupported("immersive-ar");

    if (!supported) {
      startButton.textContent = "AR unavailable";
      statusText.textContent =
        "Sensory V9 loaded; immersive-ar unavailable.";
      return;
    }

    startButton.disabled = false;
    startButton.textContent = "Enter Sensory V9";

    statusText.textContent =
      "Random rounds: 7–20 targets. Trigger: sting. Grip: new round.";
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
      needsInitialRound = false;
      nextRoundAt = null;

      resetControllerAim();

      panel.style.display = "";
      startButton.disabled = false;
      startButton.textContent = "Enter Sensory V9";
      statusText.textContent = "Sensory V9: session ended.";
    });

    clearHosts();

    roundNumber = 0;
    roundTotal = 0;
    roundCollected = 0;
    totalStings = 0;

    nextRoundAt = null;
    lastManualRoundAt = -Infinity;
    feedbackUntil = 0;
    proboscisUntil = 0;
    previousTime = null;

    await renderer.xr.setSession(session);

    needsInitialRound = true;
    panel.style.display = "none";
  } catch (error) {
    if (session) {
      try {
        await session.end();
      } catch {
        // Preserve the original startup error.
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

// Desktop visual preview of one random round.
startNewRound();

// ============================================================
// MAIN LOOP
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

      headPosition.set(
        position.x,
        position.y,
        position.z
      );

      headQuaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w
      );

      if (needsInitialRound) {
        startNewRound();
        needsInitialRound = false;
      }

      if (
        nextRoundAt !== null &&
        now >= nextRoundAt
      ) {
        startNewRound();
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

  proboscis.scale.z =
    now < proboscisUntil ? 1.35 : 1;

  const message = now < feedbackUntil
    ? feedback
    : getGuidanceMessage();

  updateHUD(message);
  renderer.render(scene, camera);
});

// ============================================================
// RESIZE AND SUPPORT CHECK
// ============================================================

window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return;

  camera.aspect =
    window.innerWidth / window.innerHeight;

  camera.updateProjectionMatrix();

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );
});

await checkSupport();

// END OF MOSQUITO SENSORY V9
