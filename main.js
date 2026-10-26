import * as THREE from
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

// ============================================================
// MOSQUITO SENSORY V8
// Purple / magenta environment with orange / yellow hosts.
//
// Passthrough remains visible beneath artistic graphics.
// This does not process camera pixels or detect real people.
// Hosts are manually placed and remain stationary.
// ============================================================

const CONFIG = {
  version: "SENSORY V8",

  placementDistance: 1.0,
  stingDistance: 2.0,
  acquisitionSeconds: 0.35,
  cooldownSeconds: 0.9,
  maximumHosts: 6,

  environmentParticles: 180,
  scentParticles: 40,

  // Reduce this if the room becomes difficult to see.
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
// PAGE ELEMENTS
// Uses the IDs from your existing index.html.
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
startButton.textContent = "Loading Sensory V8…";
statusText.textContent = "Preparing mosquito sensory vision.";

// ============================================================
// SCENE
// Never add an opaque scene.background in this AR experience.
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
let needsInitialHosts = false;
let previousTime = null;
let now = 0;

let stingCount = 0;
let proboscisUntil = 0;

let feedback = "";
let feedbackUntil = 0;
let lastHUDKey = "";

// ============================================================
// HELPERS
// ============================================================

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
    throw new Error("Could not create a canvas texture.");
  }

  draw(context, canvas);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

function showFeedback(message, seconds = 1.2) {
  feedback = message;
  feedbackUntil = now + seconds;
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
// MULTICOLOUR SENSORY FILTER
// View-attached artistic gradient, not camera processing.
// ============================================================

const filterTexture = makeCanvasTexture(
  1024,
  1024,
  (context) => {
    // Purple base across the view.
    context.fillStyle = "rgba(85, 5, 145, 0.27)";
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

    // Broad magenta regions.
    glow(270, 460, 530, 255, 10, 155, 0.38);
    glow(770, 390, 510, 230, 10, 180, 0.34);

    // Purple upper region.
    glow(510, 200, 520, 115, 10, 220, 0.26);

    // Orange lower peripheral regions.
    glow(270, 790, 330, 255, 100, 0, 0.32);
    glow(770, 790, 330, 255, 125, 0, 0.32);

    // Smaller yellow highlights.
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

// Draw before the virtual hosts so their warm colours stay clear.
visor.renderOrder = -100;
visor.frustumCulled = false;

camera.add(visor);

// ============================================================
// COMPOUND-EYE PATTERN
// A stylised hexagonal frame, not optical image duplication.
// ============================================================

const eyeTexture = makeCanvasTexture(
  1024,
  1024,
  (context) => {
    const gradient = context.createRadialGradient(
      512, 512, 160,
      512, 512, 710
    );

    gradient.addColorStop(0, "rgba(50,5,90,0)");
    gradient.addColorStop(0.6, "rgba(75,10,110,0.04)");
    gradient.addColorStop(1, "rgba(90,5,130,0.20)");

    context.fillStyle = gradient;
    context.fillRect(0, 0, 1024, 1024);

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
        const edge = Math.min(1, distance / 600);
        const alpha = 0.025 + edge * 0.21;

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
// HEADSET HUD
// ============================================================

const hudCanvas = document.createElement("canvas");
hudCanvas.width = 1024;
hudCanvas.height = 256;

const hudContext = hudCanvas.getContext("2d");

if (!hudContext) {
  throw new Error("Could not create the headset HUD.");
}

const hudTexture = new THREE.CanvasTexture(hudCanvas);
hudTexture.colorSpace = THREE.SRGBColorSpace;

const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.88, 0.22),
  new THREE.MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  })
);

hud.position.set(0, -0.30, -1);
hud.renderOrder = 120;
hud.frustumCulled = false;
camera.add(hud);

function updateHUD(message) {
  const key = `${stingCount}|${message}`;

  if (key === lastHUDKey) return;
  lastHUDKey = key;

  hudContext.clearRect(0, 0, 1024, 256);

  hudContext.fillStyle = "rgba(40,4,65,0.80)";
  hudContext.fillRect(0, 0, 1024, 256);

  hudContext.textAlign = "center";
  hudContext.fillStyle = "#FFEB70";
  hudContext.font = "bold 50px sans-serif";

  hudContext.fillText(
    `${CONFIG.version} · STINGS: ${stingCount}`,
    512,
    85
  );

  hudContext.fillStyle = "#FFD6F2";
  hudContext.font = "29px sans-serif";
  hudContext.fillText(message, 512, 145);

  const fill = stingCount === 0
    ? 0
    : (((stingCount - 1) % 10) + 1) / 10;

  hudContext.fillStyle = "#66205F";
  hudContext.fillRect(212, 190, 600, 16);

  const barGradient = hudContext.createLinearGradient(
    212, 0, 812, 0
  );

  barGradient.addColorStop(0, "#FF1493");
  barGradient.addColorStop(0.5, "#FF8500");
  barGradient.addColorStop(1, "#FFEB70");

  hudContext.fillStyle = barGradient;
  hudContext.fillRect(212, 190, 600 * fill, 16);

  hudTexture.needsUpdate = true;
}

// ============================================================
// ENVIRONMENTAL SENSORY PARTICLES
// Fictional spatial atmosphere, not room reconstruction.
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
    x: (Math.random() - 0.5) * 7,
    y: 0.15 + Math.random() * 2.7,
    z: (Math.random() - 0.5) * 7,
    phase: Math.random() * Math.PI * 2
  });

  // Mostly purple/magenta, with occasional orange particles.
  const chosen = particlePalette[
    i % 10 === 0 ? 2 : i % 2
  ];

  chosen.toArray(environmentColors, i * 3);
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
    opacity: 0.50,
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
      new THREE.RingGeometry(0.98, 1, 64),
      transparentMaterial(
        i === 1 ? COLOR.magenta : COLOR.violet,
        0.10
      )
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;

    environment.add(ring);
    floorRipples.push(ring);
  }
}

// ============================================================
// HOT SIGNATURE MATERIAL
// Applies false colours to virtual host meshes only.
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
          0.25 +
          heat * 0.23 +
          uFocus * 0.08;

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
// HOST SIGNATURE CREATION AND CLEANUP
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

  // particleTexture is shared and must not be disposed here.
}

function clearHosts() {
  for (const controller of controllers) {
    controller.userData.aimedHost = null;
    controller.userData.aimTime = 0;
  }

  hosts.forEach(disposeHost);
  hosts.length = 0;
}

function createHost(stingPosition) {
  if (hosts.length >= CONFIG.maximumHosts) {
    const oldest = hosts.shift();

    for (const controller of controllers) {
      if (controller.userData.aimedHost === oldest) {
        controller.userData.aimedHost = null;
        controller.userData.aimTime = 0;
      }
    }

    disposeHost(oldest);
  }

  const host = new THREE.Group();

  // Face the user at placement time.
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

  // Warm inner torso.
  const innerTorso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.10, 0.23, 4, 16),
    transparentMaterial(COLOR.yellow, 0.15)
  );

  innerTorso.position.z = 0.05;
  innerTorso.scale.z = 0.5;
  host.add(innerTorso);

  // Interactive sting patch.
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(0.10, 32),
    transparentMaterial(COLOR.magenta, 0.88)
  );

  patch.position.copy(PATCH_OFFSET);
  patch.scale.y = 0.85;
  patch.userData.host = host;
  host.add(patch);

  const warmPatch = new THREE.Mesh(
    new THREE.CircleGeometry(0.070, 32),
    transparentMaterial(COLOR.orange, 0.98)
  );

  warmPatch.position.z = 0.003;
  patch.add(warmPatch);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.030, 24),
    transparentMaterial(COLOR.yellow, 0.50)
  );

  core.position.z = 0.006;
  patch.add(core);

  // Three acquisition-ring segments.
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
      transparentMaterial(COLOR.magenta, 0.75)
    );

    segments.add(segment);
  }

  // Closed yellow ring means ready to sting.
  const closedRing = new THREE.Mesh(
    new THREE.RingGeometry(0.125, 0.138, 48),
    transparentMaterial(COLOR.yellow, 0.98)
  );

  closedRing.position.copy(segments.position);
  closedRing.visible = false;
  host.add(closedRing);

  // Expanding sting ripple.
  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.10, 0.112, 48),
    transparentMaterial(COLOR.orange, 0)
  );

  ripple.position.copy(segments.position);
  ripple.position.z += 0.005;
  ripple.visible = false;
  host.add(ripple);

  // Scent particles.
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
    lastStung: -Infinity,
    phase: Math.random() * Math.PI * 2
  };

  scene.add(host);
  hosts.push(host);

  return host;
}

// Desktop preview signatures.
createHost(new THREE.Vector3(-0.45, 1.4, -1.4));
createHost(new THREE.Vector3(0.45, 1.4, -1.4));

// ============================================================
// CONTROLLER INTERACTION
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

  const patches = hosts.map((host) => host.userData.patch);
  const hits = raycaster.intersectObjects(patches, false);

  return hits.length ? hits[0] : null;
}

function placeHost(controller) {
  if (
    !renderer.xr.isPresenting ||
    !controller.visible
  ) {
    return;
  }

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

  // Optional vibration.
  const actuator =
    controller.userData.inputSource
      ?.gamepad?.hapticActuators?.[0];

  if (actuator) {
    try {
      Promise.resolve(
        actuator.pulse(0.45, 90)
      ).catch(() => {});
    } catch {
      // Vibration failure must not interrupt the experience.
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
    controller.userData.aimDot.visible = false;
  });

  controller.addEventListener("selectstart", () => {
    sting(controller);
  });

  controller.addEventListener("squeezestart", () => {
    placeHost(controller);
  });

  // Short pointing line.
  const pointer = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -0.18)
    ]),
    new THREE.LineBasicMaterial({
      color: COLOR.yellow,
      transparent: true,
      opacity: 0.8,
      toneMapped: false
    })
  );

  controller.add(pointer);

  // A small dot appears on a patch when aimed at.
  const aimDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 10, 8),
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

    if (hit) {
      dot.position.copy(hit.point);
    }

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
      controller.userData.aimTime /
        CONFIG.acquisitionSeconds
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

  data.heatMaterial.uniforms.uTime.value =
    time + data.phase;

  data.heatMaterial.uniforms.uFocus.value = data.focus;
  data.heatMaterial.uniforms.uFlash.value = flash;

  data.patch.material.opacity =
    recovering ? 0.35 : 0.88;

  data.core.material.opacity =
    0.45 + data.focus * 0.55;

  data.segments.visible = !data.ready;
  data.closedRing.visible = data.ready;

  data.segments.rotation.z = time * 0.4;

  data.segments.scale.setScalar(
    1.3 - data.focus * 0.3
  );

  for (const segment of data.segments.children) {
    segment.material.color.setHex(
      data.aimed ? COLOR.orange : COLOR.magenta
    );

    segment.material.opacity =
      recovering ? 0.2 : 0.8;
  }

  data.ripple.visible = age >= 0 && age < 0.65;

  if (data.ripple.visible) {
    data.ripple.scale.setScalar(1 + age * 5);

    data.ripple.material.opacity =
      (1 - age / 0.65) * 0.9;
  }

  // Curved fictional scent trail.
  for (let i = 0; i < CONFIG.scentParticles; i++) {
    const u = (
      i / CONFIG.scentParticles +
      time * 0.10
    ) % 1;

    const index = i * 3;
    const swirl = u * Math.PI * 3 + data.phase;

    data.scentPositions[index] =
      PATCH_OFFSET.x +
      Math.sin(swirl) * 0.18 * u;

    data.scentPositions[index + 1] =
      PATCH_OFFSET.y +
      u * 0.28 +
      Math.cos(swirl) * 0.05;

    data.scentPositions[index + 2] =
      PATCH_OFFSET.z + u * 1.45;
  }

  data.scent.geometry.attributes.position.needsUpdate = true;

  data.scent.material.color.setHex(
    data.aimed ? COLOR.orange : COLOR.magenta
  );

  data.scent.material.opacity =
    recovering ? 0.25 : 0.78 + data.focus * 0.12;
}

function updateAntennae() {
  let nearestHost = null;
  let nearestDistance = Infinity;

  for (const host of hosts) {
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

  const color = focused
    ? COLOR.orange
    : COLOR.magenta;

  leftAntenna.material.color.setHex(color);
  rightAntenna.material.color.setHex(color);
}

// ============================================================
// WEBXR SUPPORT AND STARTUP
// ============================================================

async function checkSupport() {
  if (!window.isSecureContext) {
    startButton.textContent = "HTTPS required";

    statusText.textContent =
      `${CONFIG.version}: open your HTTPS website.`;

    return;
  }

  if (!navigator.xr) {
    startButton.textContent = "Desktop preview";

    statusText.textContent =
      `${CONFIG.version} loaded. Open on Quest for AR.`;

    return;
  }

  try {
    const supported =
      await navigator.xr.isSessionSupported("immersive-ar");

    if (!supported) {
      startButton.textContent = "AR unavailable";

      statusText.textContent =
        `${CONFIG.version} loaded; immersive-ar unavailable.`;

      return;
    }

    startButton.disabled = false;
    startButton.textContent = "Enter Sensory V8";

    statusText.textContent =
      "Grip: place host. Aim: acquire. Trigger: sting.";
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
      startButton.textContent = "Enter Sensory V8";

      statusText.textContent =
        `${CONFIG.version}: session ended.`;
    });

    clearHosts();

    stingCount = 0;
    feedbackUntil = 0;
    proboscisUntil = 0;
    previousTime = null;

    await renderer.xr.setSession(session);

    needsInitialHosts = true;
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

// ============================================================
// MAIN LOOP
// ============================================================

renderer.setAnimationLoop((milliseconds, frame) => {
  now = milliseconds / 1000;

  const delta = previousTime === null
    ? 0
    : Math.max(
        0,
        Math.min(now - previousTime, 0.05)
      );

  previousTime = now;

  if (frame) {
    const referenceSpace =
      renderer.xr.getReferenceSpace();

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
          const stingPosition = headPosition.clone()
            .addScaledVector(forward, 1.4)
            .addScaledVector(right, offset);

          stingPosition.y -= 0.2;

          createHost(stingPosition);
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

  proboscis.scale.z =
    now < proboscisUntil ? 1.35 : 1;

  let message =
    "Grip: place host | Follow the scent trails";

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
// RESIZE
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

// END OF MOSQUITO SENSORY V8
