import * as THREE from
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

// ============================================================
// MOSQUITO SENSORY V11
//
// 5–20 stationary, spread-out targets.
// Fresh browser-provided bounded-floor data on every AR entry.
// Blood charging and automatic power-up.
// Procedural mosquito background sound.
//
// No actual thermal sensing or real-person detection.
// No stored boundary and no guessed boundary fallback.
// Does not reset Meta Guardian or detect physical obstacles.
// ============================================================

const CONFIG = {
  version: "SENSORY V11",

  minimumTargets: 5,
  maximumTargets: 20,

  boundaryMargin: 0.65,

  // Minimum spacing between target patches.
  minimumTargetSpacing: 0.8,

  // Also prevent vertical stacks at almost the same floor position.
  minimumHorizontalSpacing: 0.45,

  minimumHeadDistance: 0.65,
  minimumHeightOffset: -0.85,
  maximumHeightOffset: 0.65,

  stingDistance: 8,
  acquisitionSeconds: 0.3,
  poweredAcquisitionSeconds: 0.12,

  bloodPerHit: 10,
  powerSeconds: 8,
  nextRoundDelay: 1.8,

  scentParticles: 18,
  filterOpacity: 0.85,
  buzzVolume: 0.018
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
startButton.textContent = "Loading Sensory V11…";
statusText.textContent = "Boundary will be checked when you enter AR.";

// ============================================================
// SCENE
// ============================================================

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  70,
  innerWidth / innerHeight,
  0.01,
  30
);

// Keep the XR scene origin unchanged.
scene.add(camera);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true
});

renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 0);

renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("bounded-floor");

document.body.appendChild(renderer.domElement);

// ============================================================
// STATE — MEMORY ONLY, NO SAVED BOUNDARY
// ============================================================

const hosts = [];
const controllers = [];

const headPosition = new THREE.Vector3();
const headQuaternion = new THREE.Quaternion();

const raycaster = new THREE.Raycaster();
const rayRotation = new THREE.Matrix4();
const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();

const temporary = new THREE.Vector3();
const inverseHead = new THREE.Quaternion();

const PATCH_OFFSET = new THREE.Vector3(-0.12, 0.22, 0.22);
const HOST_SCALE = 0.8;

let session = null;
let referenceSpace = null;
let boundary = [];
let boundarySignature = "";

let starting = false;
let stopping = false;
let needsRound = false;
let nextBoundaryCheck = 0;

let roundNumber = 0;
let roundTotal = 0;
let roundCollected = 0;
let totalStings = 0;

let bloodLevel = 0;
let powerUntil = 0;

let now = 0;
let previousTime = null;
let nextRoundAt = null;
let lastManualRound = -Infinity;

let feedback = "";
let feedbackUntil = 0;
let proboscisUntil = 0;
let lastHUDKey = "";

// ============================================================
// HELPERS
// ============================================================

function random(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function randomInteger(minimum, maximum) {
  return Math.floor(random(minimum, maximum + 1));
}

function isPowered() {
  return powerUntil > now;
}

function acquisitionTime() {
  return isPowered()
    ? CONFIG.poweredAcquisitionSeconds
    : CONFIG.acquisitionSeconds;
}

function say(message, duration = 1.5) {
  feedback = message;
  feedbackUntil = now + duration;
}

function material(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false
  });
}

function canvasTexture(width, height, draw) {
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

const particleTexture = canvasTexture(64, 64, (context) => {
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

// ============================================================
// MOSQUITO AUDIO
// Synthesised sound; no external audio file.
// ============================================================

let audioContext = null;
let audioMaster = null;
let soundEnabled = true;
let audioAvailable = true;

function prepareAudio() {
  try {
    if (!audioContext) {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        audioAvailable = false;
        return;
      }

      audioContext = new AudioContextClass();

      audioMaster = audioContext.createGain();
      audioMaster.gain.value = 0;
      audioMaster.connect(audioContext.destination);

      const lowPass = audioContext.createBiquadFilter();
      lowPass.type = "lowpass";
      lowPass.frequency.value = 2200;
      lowPass.connect(audioMaster);

      const highPass = audioContext.createBiquadFilter();
      highPass.type = "highpass";
      highPass.frequency.value = 250;
      highPass.connect(lowPass);

      const oscillatorA = audioContext.createOscillator();
      oscillatorA.type = "sawtooth";
      oscillatorA.frequency.value = 420;
      oscillatorA.connect(highPass);

      const oscillatorB = audioContext.createOscillator();
      oscillatorB.type = "sawtooth";
      oscillatorB.frequency.value = 427;

      const secondGain = audioContext.createGain();
      secondGain.gain.value = 0.35;

      oscillatorB.connect(secondGain);
      secondGain.connect(highPass);

      const pitchLFO = audioContext.createOscillator();
      pitchLFO.frequency.value = 0.7;

      const pitchDepth = audioContext.createGain();
      pitchDepth.gain.value = 14;

      pitchLFO.connect(pitchDepth);
      pitchDepth.connect(oscillatorA.frequency);
      pitchDepth.connect(oscillatorB.frequency);

      oscillatorA.start();
      oscillatorB.start();
      pitchLFO.start();
    }

    audioAvailable = true;

    audioContext.resume().catch(() => {
      audioAvailable = false;
    });
  } catch (error) {
    audioAvailable = false;
    console.warn("Audio unavailable:", error);
  }
}

function updateAudio() {
  if (!audioContext || !audioMaster) return;

  const audible =
    session &&
    session.visibilityState === "visible" &&
    soundEnabled &&
    audioAvailable &&
    !stopping;

  audioMaster.gain.setTargetAtTime(
    audible ? CONFIG.buzzVolume : 0,
    audioContext.currentTime,
    0.12
  );
}

function silenceAudio() {
  if (!audioContext || !audioMaster) return;

  audioMaster.gain.setTargetAtTime(
    0,
    audioContext.currentTime,
    0.05
  );
}

function toggleSound() {
  soundEnabled = !soundEnabled;

  if (soundEnabled) prepareAudio();

  updateAudio();

  say(
    !audioAvailable
      ? "Audio unavailable"
      : soundEnabled
        ? "Mosquito sound on"
        : "Mosquito sound off"
  );
}

// ============================================================
// MULTICOLOUR VIEW FILTER
// Artistic overlay, not passthrough-image processing.
// ============================================================

const filterTexture = canvasTexture(1024, 1024, (context) => {
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
});

const visor = new THREE.Mesh(
  new THREE.PlaneGeometry(2.8, 2.8),
  new THREE.MeshBasicMaterial({
    map: filterTexture,
    opacity: CONFIG.filterOpacity,
    transparent: true,
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
// COMPOUND-EYE PATTERN
// ============================================================

const eyeTexture = canvasTexture(1024, 1024, (context) => {
  const radius = 43;
  const height = Math.sqrt(3) * radius;

  context.lineWidth = 1.6;

  for (let column = -1; column < 19; column++) {
    for (let row = -1; row < 16; row++) {
      const x = column * radius * 1.5;
      const y = row * height +
        (Math.abs(column % 2) ? height / 2 : 0);

      const distance = Math.hypot(x - 512, y - 512);
      const alpha = 0.025 + Math.min(1, distance / 600) * 0.21;

      context.strokeStyle = `rgba(255,115,220,${alpha})`;
      context.beginPath();

      for (let corner = 0; corner < 6; corner++) {
        const angle = corner * Math.PI / 3;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;

        if (corner === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }

      context.closePath();
      context.stroke();
    }
  }
});

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
// ANTENNAE / PROBOSCIS
// ============================================================

function headLine(points, color) {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      points.map((point) => new THREE.Vector3(...point))
    ),
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

const leftAntenna = headLine([
  [-0.15, 0.12, -0.4],
  [-0.23, 0.20, -0.5],
  [-0.30, 0.26, -0.6]
], COLOR.magenta);

const rightAntenna = headLine([
  [0.15, 0.12, -0.4],
  [0.23, 0.20, -0.5],
  [0.30, 0.26, -0.6]
], COLOR.magenta);

const proboscis = headLine([
  [0, -0.13, -0.3],
  [0, -0.08, -0.6]
], COLOR.yellow);

// ============================================================
// HUD WITH BLOOD BAR AND POWER TIMER
// ============================================================

const hudCanvas = document.createElement("canvas");
hudCanvas.width = 1024;
hudCanvas.height = 360;

const hudContext = hudCanvas.getContext("2d");

if (!hudContext) throw new Error("Could not create HUD.");

const hudTexture = new THREE.CanvasTexture(hudCanvas);
hudTexture.colorSpace = THREE.SRGBColorSpace;

const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.9, 0.316),
  new THREE.MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  })
);

hud.position.set(0, -0.34, -1);
hud.renderOrder = 120;
hud.frustumCulled = false;
camera.add(hud);

function drawHUD(message) {
  const powerRemaining = Math.max(0, powerUntil - now);
  const powerDisplay = Math.ceil(powerRemaining * 10) / 10;

  const key = [
    roundNumber,
    roundTotal,
    roundCollected,
    totalStings,
    bloodLevel,
    powerDisplay,
    message
  ].join("|");

  if (key === lastHUDKey) return;
  lastHUDKey = key;

  hudContext.clearRect(0, 0, 1024, 360);

  hudContext.fillStyle = "rgba(40,4,65,0.84)";
  hudContext.fillRect(0, 0, 1024, 360);

  hudContext.textAlign = "center";
  hudContext.fillStyle = "#FFD6F2";
  hudContext.font = "24px sans-serif";
  hudContext.fillText(CONFIG.version, 512, 34);

  hudContext.fillStyle = "#FFEB70";
  hudContext.font = "bold 42px sans-serif";
  hudContext.fillText(
    `ROUND ${roundNumber} · ${roundCollected}/${roundTotal}`,
    512,
    87
  );

  hudContext.fillStyle = "#FFD6F2";
  hudContext.font = "26px sans-serif";
  hudContext.fillText(message, 512, 132);

  hudContext.font = "22px sans-serif";
  hudContext.fillText(
    `Hits: ${totalStings} · L grip: sound · R grip: new round`,
    512,
    171
  );

  hudContext.textAlign = "left";
  hudContext.fillStyle = isPowered() ? "#FFEB70" : "#FF7D9D";
  hudContext.font = "bold 25px sans-serif";

  hudContext.fillText(
    isPowered()
      ? `BLOOD 100% · POWER-UP ${powerDisplay.toFixed(1)}s`
      : `BLOOD ${bloodLevel}% · Charge to 100%`,
    150,
    215
  );

  hudContext.fillStyle = "#44152C";
  hudContext.fillRect(150, 230, 724, 27);

  const bloodGradient = hudContext.createLinearGradient(
    150, 0, 874, 0
  );

  bloodGradient.addColorStop(0, "#B80035");
  bloodGradient.addColorStop(0.5, "#FF2455");
  bloodGradient.addColorStop(1, isPowered() ? "#FFEB70" : "#FF8500");

  hudContext.fillStyle = bloodGradient;
  hudContext.fillRect(
    150, 230,
    724 * bloodLevel / 100,
    27
  );

  hudContext.strokeStyle = isPowered() ? "#FFEB70" : "#FF5A87";
  hudContext.lineWidth = 2;
  hudContext.strokeRect(150, 230, 724, 27);

  hudContext.fillStyle = "#57225E";
  hudContext.fillRect(150, 279, 724, 12);

  hudContext.fillStyle = isPowered() ? "#FFEB70" : "#FF8500";

  const lowerBar = isPowered()
    ? powerRemaining / CONFIG.powerSeconds
    : roundTotal
      ? roundCollected / roundTotal
      : 0;

  hudContext.fillRect(150, 279, 724 * lowerBar, 12);

  hudContext.textAlign = "center";
  hudContext.fillStyle = "#FFD6F2";
  hudContext.font = "20px sans-serif";
  hudContext.fillText(
    isPowered()
      ? "POWER ACTIVE: faster target acquisition"
      : "Each successful hit adds 10% blood",
    512,
    327
  );

  hudTexture.needsUpdate = true;
}

// ============================================================
// FRESH BOUNDARY READING
// ============================================================

function readBoundary() {
  const points = referenceSpace?.boundsGeometry;

  if (!points || points.length < 3) {
    throw new Error(
      "The browser did not provide a play-area boundary. " +
      "No targets were generated."
    );
  }

  const polygon = Array.from(points, (point) => ({
    x: point.x,
    z: point.z
  }));

  if (polygon.some((point) =>
    !Number.isFinite(point.x) || !Number.isFinite(point.z)
  )) {
    throw new Error("Invalid play-area boundary.");
  }

  let twiceArea = 0;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twiceArea += a.x * b.z - b.x * a.z;
  }

  if (Math.abs(twiceArea) < 0.01) {
    throw new Error("The reported play area is too small.");
  }

  boundary = polygon;

  boundarySignature = polygon.map((point) =>
    `${point.x.toFixed(3)},${point.z.toFixed(3)}`
  ).join(";");

  return boundarySignature;
}

function pointInsidePolygon(x, z) {
  let inside = false;

  for (
    let i = 0, j = boundary.length - 1;
    i < boundary.length;
    j = i++
  ) {
    const a = boundary[i];
    const b = boundary[j];

    if (
      (a.z > z) !== (b.z > z) &&
      x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function distanceToSegment(x, z, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;

  const t = lengthSquared === 0
    ? 0
    : THREE.MathUtils.clamp(
        ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared,
        0,
        1
      );

  return Math.hypot(
    x - (a.x + t * dx),
    z - (a.z + t * dz)
  );
}

function insideWithMargin(x, z) {
  if (!pointInsidePolygon(x, z)) return false;

  for (let i = 0; i < boundary.length; i++) {
    if (
      distanceToSegment(
        x,
        z,
        boundary[i],
        boundary[(i + 1) % boundary.length]
      ) < CONFIG.boundaryMargin
    ) {
      return false;
    }
  }

  return true;
}

// ============================================================
// SPREAD-OUT RANDOM PLACEMENT
// Does not relax the spacing or boundary rules.
// ============================================================

function generatePositions(requestedCount) {
  const xs = boundary.map((point) => point.x);
  const zs = boundary.map((point) => point.z);

  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumZ = Math.min(...zs);
  const maximumZ = Math.max(...zs);

  const candidates = [];

  for (
    let attempt = 0;
    attempt < 50000 && candidates.length < 1600;
    attempt++
  ) {
    const x = random(minimumX, maximumX);
    const z = random(minimumZ, maximumZ);

    if (!insideWithMargin(x, z)) continue;

    const y = Math.max(
      0.65,
      headPosition.y + random(
        CONFIG.minimumHeightOffset,
        CONFIG.maximumHeightOffset
      )
    );

    const position = new THREE.Vector3(x, y, z);
    const distance = position.distanceTo(headPosition);

    if (
      distance < CONFIG.minimumHeadDistance ||
      distance > CONFIG.stingDistance - 0.75
    ) {
      continue;
    }

    candidates.push(position);
  }

  if (candidates.length < CONFIG.minimumTargets) {
    throw new Error(
      "Not enough usable space inside the boundary. " +
      "At least five separated targets are required."
    );
  }

  let bestSelection = [];

  // Multiple random starts reduce the chance of a poor layout.
  for (let layoutAttempt = 0; layoutAttempt < 6; layoutAttempt++) {
    const selected = [
      candidates[Math.floor(Math.random() * candidates.length)]
    ];

    while (selected.length < requestedCount) {
      const options = [];

      for (const candidate of candidates) {
        let nearestDistance = Infinity;
        let valid = true;

        for (const placed of selected) {
          const distance = candidate.distanceTo(placed);

          const horizontalDistance = Math.hypot(
            candidate.x - placed.x,
            candidate.z - placed.z
          );

          if (
            distance < CONFIG.minimumTargetSpacing ||
            horizontalDistance < CONFIG.minimumHorizontalSpacing
          ) {
            valid = false;
            break;
          }

          nearestDistance = Math.min(nearestDistance, distance);
        }

        if (!valid) continue;

        options.push({
          position: candidate,
          score: nearestDistance
        });
      }

      if (options.length === 0) break;

      // Prefer widely separated candidates, with random selection
      // among the best few so each round still differs.
      options.sort((a, b) => b.score - a.score);

      const topCount = Math.min(8, options.length);
      const chosen = options[Math.floor(Math.random() * topCount)];

      selected.push(chosen.position);
    }

    if (selected.length > bestSelection.length) {
      bestSelection = selected;
    }

    if (bestSelection.length === requestedCount) break;
  }

  if (bestSelection.length < CONFIG.minimumTargets) {
    throw new Error(
      "The usable area could not fit five targets with " +
      "the required spacing and inward boundary margin. " +
      "No crowded layout was generated."
    );
  }

  return bestSelection.map((position) => position.clone());
}

// ============================================================
// HOT SIGNATURE MATERIAL
// ============================================================

function heatMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      focus: { value: 0 },
      flash: { value: 0 },
      power: { value: 0 }
    },

    vertexShader: `
      varying vec3 n;
      varying vec3 p;

      void main() {
        n = normalize(normalMatrix * normal);
        p = position;

        gl_Position = projectionMatrix *
          modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: `
      uniform float time;
      uniform float focus;
      uniform float flash;
      uniform float power;

      varying vec3 n;
      varying vec3 p;

      void main() {
        float heat = pow(max(normalize(n).z, 0.0), 0.7);

        heat = clamp(
          heat + 0.035 * sin(p.y * 24.0 - time * 1.8),
          0.0,
          1.0
        );

        vec3 purple = vec3(0.41, 0.03, 0.72);
        vec3 magenta = vec3(1.0, 0.04, 0.55);
        vec3 orange = vec3(1.0, 0.38, 0.0);
        vec3 yellow = vec3(1.0, 0.90, 0.10);

        vec3 color = mix(
          purple, magenta, smoothstep(0.0, 0.45, heat)
        );

        color = mix(
          color, orange, smoothstep(0.4, 0.8, heat)
        );

        color = mix(
          color, yellow,
          smoothstep(0.72, 1.0, heat) * (0.65 + focus * 0.35)
        );

        color = mix(color, yellow, flash * 0.8);
        color = mix(color, yellow, power * 0.12);

        gl_FragColor = vec4(
          color,
          0.25 + heat * 0.23 + focus * 0.08
        );

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

function resetAim() {
  for (const controller of controllers) {
    controller.userData.host = null;
    controller.userData.aimTime = 0;
    controller.userData.dot.visible = false;
  }
}

function clearHosts() {
  resetAim();

  for (const host of hosts) {
    scene.remove(host);

    const geometries = new Set();
    const materials = new Set();

    host.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);

      if (object.material) {
        const list = Array.isArray(object.material)
          ? object.material
          : [object.material];

        list.forEach((item) => materials.add(item));
      }
    });

    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((item) => item.dispose());
  }

  hosts.length = 0;
}

function createHost(position) {
  const host = new THREE.Group();
  host.scale.setScalar(HOST_SCALE);

  host.rotation.y = Math.atan2(
    headPosition.x - position.x,
    headPosition.z - position.z
  );

  const offset = PATCH_OFFSET.clone()
    .multiplyScalar(HOST_SCALE)
    .applyQuaternion(host.quaternion);

  host.position.copy(position).sub(offset);

  const heat = heatMaterial();

  function addPart(geometry, x, y, z, sx = 1, sy = 1, sz = 1) {
    const mesh = new THREE.Mesh(geometry, heat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    host.add(mesh);
    return mesh;
  }

  addPart(
    new THREE.CapsuleGeometry(0.23, 0.48, 4, 12),
    0, 0, 0,
    1, 1, 0.65
  );

  addPart(
    new THREE.SphereGeometry(0.14, 12, 10),
    0, 0.64, 0,
    0.88, 1.05, 0.85
  );

  addPart(
    new THREE.SphereGeometry(1, 12, 8),
    0, 0.3, 0,
    0.32, 0.1, 0.15
  );

  for (const side of [-1, 1]) {
    const arm = addPart(
      new THREE.CapsuleGeometry(0.06, 0.35, 3, 8),
      side * 0.29, 0.015, 0,
      1, 1, 0.8
    );

    arm.rotation.z = side * 0.15;
  }

  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(0.14, 24),
    material(COLOR.magenta, 0.88)
  );

  patch.position.copy(PATCH_OFFSET);
  patch.scale.y = 0.85;
  patch.userData.host = host;
  host.add(patch);

  const warm = new THREE.Mesh(
    new THREE.CircleGeometry(0.1, 24),
    material(COLOR.orange, 0.98)
  );

  warm.position.z = 0.003;
  patch.add(warm);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.04, 20),
    material(COLOR.yellow, 0.5)
  );

  core.position.z = 0.006;
  patch.add(core);

  const segments = new THREE.Group();
  segments.position.copy(PATCH_OFFSET);
  segments.position.z += 0.015;
  host.add(segments);

  for (let i = 0; i < 3; i++) {
    segments.add(new THREE.Mesh(
      new THREE.RingGeometry(
        0.165, 0.18, 16, 1,
        i * Math.PI * 2 / 3,
        Math.PI * 0.48
      ),
      material(COLOR.magenta, 0.8)
    ));
  }

  const closedRing = new THREE.Mesh(
    new THREE.RingGeometry(0.165, 0.182, 32),
    material(COLOR.yellow, 0.98)
  );

  closedRing.position.copy(segments.position);
  closedRing.visible = false;
  host.add(closedRing);

  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.14, 0.155, 32),
    material(COLOR.orange, 0)
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
      size: 0.05,
      opacity: 0.8,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    })
  );

  scent.frustumCulled = false;
  host.add(scent);

  host.userData = {
    heat,
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
    phase: random(0, Math.PI * 2)
  };

  scene.add(host);
  hosts.push(host);
}

// ============================================================
// ROUNDS
// ============================================================

function startRound() {
  readBoundary();

  const requestedCount = randomInteger(
    CONFIG.minimumTargets,
    CONFIG.maximumTargets
  );

  const positions = generatePositions(requestedCount);

  clearHosts();

  roundNumber++;
  roundTotal = positions.length;
  roundCollected = 0;
  nextRoundAt = null;

  positions.forEach(createHost);

  say(
    positions.length < requestedCount
      ? `Round ${roundNumber}: ${positions.length} targets fit with spacing`
      : `Round ${roundNumber}: find ${positions.length} targets!`,
    2.2
  );
}

async function stopWithError(error) {
  if (stopping) return;
  stopping = true;

  clearHosts();
  silenceAudio();

  const currentSession = session;

  if (currentSession) {
    try {
      await currentSession.end();
    } catch {
      // Keep the original error.
    }
  }

  panel.style.display = "";
  statusText.textContent = error.message;
  startButton.disabled = false;
  startButton.textContent = "Try Sensory V11 again";
}

function manualRound() {
  if (!session || needsRound || stopping) return;
  if (now - lastManualRound < 0.75) return;

  lastManualRound = now;

  try {
    startRound();
  } catch (error) {
    void stopWithError(error);
  }
}

// ============================================================
// BLOOD AND POWER-UP
// ============================================================

function addBlood() {
  if (isPowered()) return false;

  bloodLevel = Math.min(
    100,
    bloodLevel + CONFIG.bloodPerHit
  );

  if (bloodLevel === 100) {
    powerUntil = now + CONFIG.powerSeconds;
    return true;
  }

  return false;
}

function updatePower() {
  if (powerUntil > 0 && now >= powerUntil) {
    powerUntil = 0;
    bloodLevel = 0;
    resetAim();
    say("Power ended — collect blood to recharge.");
  }

  const antennaColor = isPowered()
    ? COLOR.yellow
    : COLOR.magenta;

  leftAntenna.material.color.setHex(antennaColor);
  rightAntenna.material.color.setHex(antennaColor);
  proboscis.material.color.setHex(
    isPowered() ? COLOR.orange : COLOR.yellow
  );
}

// ============================================================
// CONTROLLER AIMING
// ============================================================

function getHit(controller) {
  if (
    !controller.visible ||
    !controller.userData.inputSource
  ) {
    return null;
  }

  scene.updateMatrixWorld(true);

  rayOrigin.setFromMatrixPosition(controller.matrixWorld);
  rayRotation.extractRotation(controller.matrixWorld);

  rayDirection.set(0, 0, -1)
    .applyMatrix4(rayRotation)
    .normalize();

  raycaster.set(rayOrigin, rayDirection);
  raycaster.near = 0;
  raycaster.far = CONFIG.stingDistance;

  const patches = hosts
    .filter((host) => !host.userData.collected)
    .map((host) => host.userData.patch);

  return raycaster.intersectObjects(patches, false)[0] || null;
}

function sting(controller) {
  if (
    !session ||
    session.visibilityState !== "visible" ||
    needsRound ||
    nextRoundAt !== null ||
    stopping
  ) {
    return;
  }

  const hit = getHit(controller);

  if (!hit) {
    say("Aim at an orange patch.");
    return;
  }

  const host = hit.object.userData.host;
  const data = host.userData;

  if (
    controller.userData.host !== host ||
    controller.userData.aimTime < acquisitionTime()
  ) {
    say("Hold aim until the yellow ring closes.");
    return;
  }

  if (data.collected) return;

  data.collected = true;
  data.collectedAt = now;
  data.ready = false;
  data.focus = 0;

  roundCollected++;
  totalStings++;
  proboscisUntil = now + 0.2;

  const activatedPower = addBlood();

  resetAim();

  const remaining = roundTotal - roundCollected;

  if (remaining === 0) {
    nextRoundAt = now + CONFIG.nextRoundDelay;

    say(
      activatedPower
        ? "POWER-UP! Round complete — new targets incoming"
        : "Round complete! New targets incoming…",
      1.8
    );
  } else {
    say(
      activatedPower
        ? "POWER-UP! Faster acquisition for 8 seconds"
        : `Collected! ${remaining} targets remaining.`,
      activatedPower ? 2 : 1.3
    );
  }

  const actuator = controller.userData.inputSource
    ?.gamepad?.hapticActuators?.[0];

  if (actuator) {
    try {
      Promise.resolve(
        actuator.pulse(activatedPower ? 0.7 : 0.4, 100)
      ).catch(() => {});
    } catch {
      // Optional vibration.
    }
  }
}

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.01, 8, 6),
    new THREE.MeshBasicMaterial({
      color: COLOR.yellow,
      depthTest: false,
      toneMapped: false
    })
  );

  dot.visible = false;
  dot.renderOrder = 20;
  scene.add(dot);

  controller.userData = {
    inputSource: null,
    host: null,
    aimTime: 0,
    dot
  };

  controller.addEventListener("connected", (event) => {
    controller.userData.inputSource = event.data;
  });

  controller.addEventListener("disconnected", () => {
    controller.userData.inputSource = null;
    controller.userData.host = null;
    controller.userData.aimTime = 0;
    dot.visible = false;
  });

  controller.addEventListener(
    "selectstart",
    () => sting(controller)
  );

  controller.addEventListener("squeezestart", () => {
    if (
      controller.userData.inputSource?.handedness === "left"
    ) {
      toggleSound();
    } else {
      manualRound();
    }
  });

  controller.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -0.25)
    ]),
    new THREE.LineBasicMaterial({
      color: COLOR.yellow,
      transparent: true,
      opacity: 0.8,
      toneMapped: false
    })
  ));

  scene.add(controller);
  controllers.push(controller);
}

// ============================================================
// ANIMATION
// ============================================================

function updateAim(delta, trackingAvailable) {
  for (const host of hosts) {
    host.userData.aimed = false;
    host.userData.focus = 0;
    host.userData.ready = false;
  }

  if (!trackingAvailable) {
    resetAim();
    return;
  }

  for (const controller of controllers) {
    const hit = getHit(controller);
    const host = hit?.object.userData.host || null;
    const data = controller.userData;

    data.dot.visible = Boolean(hit);

    if (hit) data.dot.position.copy(hit.point);

    if (data.host !== host) {
      data.host = host;
      data.aimTime = 0;
    }

    if (!host) {
      data.aimTime = 0;
      continue;
    }

    data.aimTime += delta;

    host.userData.aimed = true;

    host.userData.focus = Math.max(
      host.userData.focus,
      Math.min(1, data.aimTime / acquisitionTime())
    );

    host.userData.ready = host.userData.focus >= 1;
  }
}

function animateHost(host) {
  const data = host.userData;

  data.heat.uniforms.time.value = now + data.phase;
  data.heat.uniforms.power.value = isPowered() ? 1 : 0;

  if (data.collected) {
    const age = now - data.collectedAt;

    data.heat.uniforms.flash.value =
      Math.max(0, 1 - age / 0.45);

    data.heat.uniforms.focus.value = 0;

    data.segments.visible = false;
    data.closedRing.visible = false;
    data.scent.visible = false;
    data.ripple.visible = age < 0.65;

    if (data.ripple.visible) {
      data.ripple.scale.setScalar(1 + age * 3);

      data.ripple.material.opacity =
        (1 - age / 0.65) * 0.9;
    }

    if (age >= 0.65) host.visible = false;
    return;
  }

  // The host's position is not animated.
  // Only rings and scent particles move.
  data.heat.uniforms.focus.value = data.focus;
  data.heat.uniforms.flash.value = 0;

  data.core.material.opacity =
    0.45 + data.focus * 0.55;

  data.segments.visible = !data.ready;
  data.closedRing.visible = data.ready;

  data.segments.rotation.z =
    now * (isPowered() ? 0.9 : 0.4);

  data.segments.scale.setScalar(
    1.25 - data.focus * 0.25
  );

  for (const segment of data.segments.children) {
    segment.material.color.setHex(
      isPowered()
        ? COLOR.yellow
        : data.aimed
          ? COLOR.orange
          : COLOR.magenta
    );
  }

  for (let i = 0; i < CONFIG.scentParticles; i++) {
    const u = (
      i / CONFIG.scentParticles + now * 0.12
    ) % 1;

    const swirl = u * Math.PI * 3 + data.phase;
    const index = i * 3;

    data.scentPositions[index] =
      PATCH_OFFSET.x + Math.sin(swirl) * 0.12 * u;

    data.scentPositions[index + 1] =
      PATCH_OFFSET.y + u * 0.6;

    data.scentPositions[index + 2] =
      PATCH_OFFSET.z + Math.cos(swirl) * 0.12 * u;
  }

  data.scent.geometry.attributes.position.needsUpdate = true;

  data.scent.material.color.setHex(
    isPowered()
      ? COLOR.yellow
      : data.aimed
        ? COLOR.orange
        : COLOR.magenta
  );
}

function nearestDirection() {
  let nearest = null;
  let distance = Infinity;

  for (const host of hosts) {
    if (host.userData.collected) continue;

    host.userData.patch.getWorldPosition(temporary);

    const candidateDistance =
      temporary.distanceTo(headPosition);

    if (candidateDistance < distance) {
      distance = candidateDistance;
      nearest = host;
    }
  }

  leftAntenna.material.opacity = 0.25;
  rightAntenna.material.opacity = 0.25;

  if (!nearest) return "Find the warm signatures";

  nearest.userData.patch.getWorldPosition(temporary);

  inverseHead.copy(headQuaternion).invert();

  temporary.sub(headPosition)
    .applyQuaternion(inverseHead)
    .normalize();

  if (temporary.x < -0.15) {
    leftAntenna.material.opacity = 0.9;
  } else if (temporary.x > 0.15) {
    rightAntenna.material.opacity = 0.9;
  } else {
    leftAntenna.material.opacity = 0.75;
    rightAntenna.material.opacity = 0.75;
  }

  if (temporary.z > 0.15) return "A target is behind you";
  if (temporary.y > 0.35) return "Look up — a target is above";
  if (temporary.y < -0.35) return "Look down — a target is below";
  if (temporary.x < -0.3) return "Look left — follow the scent";
  if (temporary.x > 0.3) return "Look right — follow the scent";

  return "Aim at an orange patch";
}

// ============================================================
// BOUNDARY RESET HANDLING
// ============================================================

function onReferenceReset() {
  // Remove targets immediately because their coordinates may
  // no longer match the current play-area reference space.
  clearHosts();

  boundary = [];
  boundarySignature = "";
  nextRoundAt = null;
  needsRound = true;

  say("Boundary changed — checking a fresh layout.");
}

function clearBoundaryState() {
  boundary = [];
  boundarySignature = "";
  referenceSpace = null;
  nextBoundaryCheck = 0;
  needsRound = false;
}

// ============================================================
// XR STARTUP
// ============================================================

startButton.addEventListener("click", async () => {
  if (session || starting) return;

  starting = true;
  stopping = false;
  startButton.disabled = true;

  clearHosts();
  clearBoundaryState();

  // Must be initiated from the user's button click.
  prepareAudio();

  let requestedSession = null;

  try {
    requestedSession = await navigator.xr.requestSession(
      "immersive-ar",
      {
        requiredFeatures: ["bounded-floor"]
      }
    );

    session = requestedSession;

    requestedSession.addEventListener("visibilitychange", () => {
      resetAim();
      previousTime = null;
      updateAudio();
    });

    requestedSession.addEventListener("end", () => {
      referenceSpace?.removeEventListener(
        "reset",
        onReferenceReset
      );

      session = null;
      nextRoundAt = null;

      clearHosts();
      clearBoundaryState();
      silenceAudio();

      panel.style.display = "";
      startButton.disabled = false;
      startButton.textContent = "Enter Sensory V11";

      if (!stopping) {
        statusText.textContent =
          "Session ended. Boundary will be checked again on entry.";
      }
    });

    await renderer.xr.setSession(requestedSession);

    referenceSpace = renderer.xr.getReferenceSpace();

    // Fresh data from this session, not a previous visit.
    readBoundary();

    referenceSpace.addEventListener(
      "reset",
      onReferenceReset
    );

    roundNumber = 0;
    roundTotal = 0;
    roundCollected = 0;
    totalStings = 0;

    bloodLevel = 0;
    powerUntil = 0;

    previousTime = null;
    nextRoundAt = null;
    feedbackUntil = 0;
    proboscisUntil = 0;
    lastManualRound = -Infinity;

    needsRound = true;
    nextBoundaryCheck = 0;

    panel.style.display = "none";
    updateAudio();
  } catch (error) {
    stopping = true;
    silenceAudio();

    if (requestedSession) {
      try {
        await requestedSession.end();
      } catch {
        // Preserve the original startup error.
      }
    }

    session = null;
    clearHosts();
    clearBoundaryState();

    panel.style.display = "";
    startButton.disabled = false;
    startButton.textContent = "Try Sensory V11 again";

    statusText.textContent =
      "Boundary-aware AR could not start. " +
      "This browser must expose bounded-floor data. " +
      "No saved or guessed boundary is used. Details: " +
      error.message;

    console.error(error);
  } finally {
    starting = false;
  }
});

// ============================================================
// MAIN LOOP
// ============================================================

renderer.setAnimationLoop((milliseconds, frame) => {
  now = milliseconds / 1000;

  const delta = previousTime === null
    ? 0
    : Math.max(0, Math.min(now - previousTime, 0.05));

  previousTime = now;

  let trackingAvailable = false;

  if (
    frame &&
    referenceSpace &&
    session?.visibilityState === "visible" &&
    !stopping
  ) {
    const pose = frame.getViewerPose(referenceSpace);

    if (pose) {
      trackingAvailable = true;

      const p = pose.transform.position;
      const q = pose.transform.orientation;

      headPosition.set(p.x, p.y, p.z);
      headQuaternion.set(q.x, q.y, q.z, q.w);

      try {
        // Also detect changed boundary geometry periodically.
        if (now >= nextBoundaryCheck) {
          const previousSignature = boundarySignature;
          const currentSignature = readBoundary();

          nextBoundaryCheck = now + 1;

          if (
            previousSignature &&
            previousSignature !== currentSignature
          ) {
            clearHosts();
            nextRoundAt = null;
            needsRound = true;
          }
        }

        if (
          needsRound ||
          (nextRoundAt !== null && now >= nextRoundAt)
        ) {
          startRound();
          needsRound = false;
        }
      } catch (error) {
        trackingAvailable = false;
        void stopWithError(error);
      }
    }
  }

  updatePower();

  updateAim(
    delta,
    trackingAvailable && !needsRound && !stopping
  );

  for (const host of hosts) {
    animateHost(host);
  }

  scene.updateMatrixWorld(true);

  let message = nearestDirection();

  if (!session) {
    message = "Enter AR to check a fresh boundary";
  } else if (!trackingAvailable) {
    message = "Waiting for headset tracking";
  } else if (nextRoundAt !== null) {
    message = "Round complete — new targets incoming";
  } else if (hosts.some((host) => host.userData.ready)) {
    message = isPowered()
      ? "POWER ACTIVE — press trigger!"
      : "Target acquired — press trigger";
  } else if (hosts.some((host) => host.userData.aimed)) {
    message = "Hold aim until the yellow ring closes";
  }

  if (now < feedbackUntil) {
    message = feedback;
  }

  proboscis.scale.z =
    now < proboscisUntil ? 1.35 : 1;

  drawHUD(message);
  renderer.render(scene, camera);
});

// ============================================================
// RESIZE / LEAVING PAGE
// ============================================================

window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return;

  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

window.addEventListener("pagehide", () => {
  silenceAudio();

  boundary = [];
  boundarySignature = "";

  if (session) {
    session.end().catch(() => {});
  }
});

// ============================================================
// SUPPORT CHECK
// Actual boundary access is checked on every AR entry.
// ============================================================

async function checkSupport() {
  if (!window.isSecureContext) {
    startButton.textContent = "HTTPS required";
    statusText.textContent = "Open your published HTTPS website.";
    return;
  }

  if (!navigator.xr) {
    startButton.textContent = "Open on Quest";

    statusText.textContent =
      "WebXR is unavailable. No boundary or targets were generated.";

    return;
  }

  try {
    const supported =
      await navigator.xr.isSessionSupported("immersive-ar");

    if (!supported) {
      startButton.textContent = "AR unavailable";

      statusText.textContent =
        "This browser does not report immersive AR support.";

      return;
    }

    startButton.disabled = false;
    startButton.textContent = "Enter Sensory V11";

    statusText.textContent =
      "Fresh boundary check on entry. " +
      "5–20 spaced targets. Hits charge blood and power.";
  } catch (error) {
    statusText.textContent =
      "Support check failed: " + error.message;
  }
}

await checkSupport();

// END OF MOSQUITO SENSORY V11
