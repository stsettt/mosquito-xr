import * as THREE from
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

// ============================================================
// MOSQUITO SENSORY VISION
//
// Artistic mixed-reality overlays, not measured thermal data.
// Hosts are manually placed and do not track real people.
// All distances are in metres.
// ============================================================

const SETTINGS = {
  placeDistance: 0.95,
  stingDistance: 1.8,
  acquisitionTime: 0.35,
  cooldown: 0.9,
  maxHosts: 6,

  visorOpacity: 0.055,
  atmosphereParticles: 140,
  scentParticles: 32,
  showFloorRipples: true
};

const COLORS = {
  cool: 0x263fa3,
  violet: 0x773cc4,
  magenta: 0xed2875,
  orange: 0xff7935,
  cream: 0xfff0b3
};

const startButton = document.getElementById("start");
const statusElement = document.getElementById("status");
const panel = document.getElementById("panel");

// ============================================================
// SCENE
// Keep the background transparent for passthrough.
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
  alpha: true,
  antialias: true
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

const raycaster = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const rotationMatrix = new THREE.Matrix4();

const headPosition = new THREE.Vector3(0, 1.6, 0);
const headQuaternion = new THREE.Quaternion();

let activeSession = null;
let seedOnNextFrame = false;

let stingCount = 0;
let previousTime = null;
let nowSeconds = 0;
let proboscisUntil = 0;
let feedbackUntil = 0;
let feedbackText = "";
let lastHUDText = "";

const PATCH_OFFSET = new THREE.Vector3(-0.12, 0.24, 0.25);

// ============================================================
// MATERIAL HELPERS
// ============================================================

function overlayMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false
  });
}

function createParticleTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create particle texture.");
  }

  const gradient = context.createRadialGradient(
    32, 32, 0,
    32, 32, 32
  );

  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.8)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);

  return new THREE.CanvasTexture(canvas);
}

const particleTexture = createParticleTexture();

// ============================================================
// HEAD-ATTACHED SENSORY VISOR
// A tint, NOT a thermal transformation of camera pixels.
// ============================================================

const visor = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  overlayMaterial(COLORS.cool, SETTINGS.visorOpacity)
);

visor.position.z = -1;
visor.material.depthTest = false;
visor.renderOrder = 100;
camera.add(visor);

function createHeadLine(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map((point) => new THREE.Vector3(...point))
  );

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.3,
    depthTest: false,
    depthWrite: false
  });

  const line = new THREE.Line(geometry, material);
  line.renderOrder = 110;
  camera.add(line);

  return line;
}

const leftAntenna = createHeadLine(
  [
    [-0.16, 0.12, -0.4],
    [-0.23, 0.20, -0.5],
    [-0.29, 0.26, -0.6]
  ],
  COLORS.magenta
);

const rightAntenna = createHeadLine(
  [
    [0.16, 0.12, -0.4],
    [0.23, 0.20, -0.5],
    [0.29, 0.26, -0.6]
  ],
  COLORS.magenta
);

const proboscis = createHeadLine(
  [
    [0, -0.13, -0.3],
    [0, -0.08, -0.6]
  ],
  COLORS.cream
);

proboscis.material.opacity = 0.65;

// ============================================================
// HUD
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
  new THREE.PlaneGeometry(0.86, 0.215),
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

  if (key === lastHUDText) return;
  lastHUDText = key;

  hudContext.clearRect(0, 0, 1024, 256);

  hudContext.fillStyle = "rgba(16,10,46,0.78)";
  hudContext.fillRect(0, 0, 1024, 256);

  hudContext.textAlign = "center";
  hudContext.fillStyle = "#FFF0B3";
  hudContext.font = "bold 68px sans-serif";
  hudContext.fillText(`STINGS: ${stingCount}`, 512, 95);

  hudContext.fillStyle = "#E8DCFF";
  hudContext.font = "30px sans-serif";
  hudContext.fillText(message, 512, 155);

  // Decorative reservoir: fills across each group of 10 stings.
  const fill = stingCount === 0
    ? 0
    : ((stingCount - 1) % 10 + 1) / 10;

  hudContext.fillStyle = "#382455";
  hudContext.fillRect(212, 195, 600, 14);

  hudContext.fillStyle = "#FF7935";
  hudContext.fillRect(212, 195, 600 * fill, 14);

  hudTexture.needsUpdate = true;
}

function showFeedback(text, duration = 1.2) {
  feedbackText = text;
  feedbackUntil = nowSeconds + duration;
}

updateHUD("Grip: place host | Aim: acquire | Trigger: sting");

// ============================================================
// ENVIRONMENTAL SENSORY FIELD
// These objects are fictional spatial graphics.
// They do not reconstruct walls or furniture.
// ============================================================

const atmosphere = new THREE.Group();
scene.add(atmosphere);

const atmospherePositions = new Float32Array(
  SETTINGS.atmosphereParticles * 3
);

const atmosphereSeeds = [];

for (let i = 0; i < SETTINGS.atmosphereParticles; i++) {
  atmosphereSeeds.push({
    x: (Math.random() - 0.5) * 7,
    y: 0.2 + Math.random() * 2.6,
    z: (Math.random() - 0.5) * 7,
    phase: Math.random() * Math.PI * 2
  });
}

const atmosphereGeometry = new THREE.BufferGeometry();

atmosphereGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(atmospherePositions, 3)
);

const atmospherePoints = new THREE.Points(
  atmosphereGeometry,
  new THREE.PointsMaterial({
    color: COLORS.violet,
    map: particleTexture,
    size: 0.035,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    sizeAttenuation: true
  })
);

// Positions change continuously.
atmospherePoints.frustumCulled = false;
atmosphere.add(atmospherePoints);

const floorRipples = [];

if (SETTINGS.showFloorRipples) {
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1, 64),
      overlayMaterial(COLORS.violet, 0.08)
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;

    atmosphere.add(ring);
    floorRipples.push(ring);
  }
}

// ============================================================
// HOST AURA SHADER
// Violet silhouette -> magenta -> orange centre.
// ============================================================

function createAuraMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFocus: { value: 0 },
      uFlash: { value: 0 }
    },

    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vLocal;

      void main() {
        vLocal = position;
        vNormalView = normalize(normalMatrix * normal);

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
      varying vec3 vLocal;

      void main() {
        float facing = max(
          normalize(vNormalView).z,
          0.0
        );

        float heat = pow(facing, 0.7);

        // Decorative variation across the virtual torso.
        float band = 0.04 * sin(
          vLocal.y * 22.0 - uTime * 1.4
        );

        heat = clamp(heat + band, 0.0, 1.0);

        vec3 violet = vec3(0.22, 0.08, 0.48);
        vec3 magenta = vec3(0.93, 0.16, 0.46);
        vec3 orange = vec3(1.0, 0.47, 0.21);
        vec3 cream = vec3(1.0, 0.94, 0.70);

        vec3 color = mix(
          violet,
          magenta,
          smoothstep(0.0, 0.65, heat)
        );

        color = mix(
          color,
          orange,
          smoothstep(0.55, 1.0, heat) *
          (0.4 + uFocus * 0.6)
        );

        color = mix(color, cream, uFlash * 0.6);

        float pulse = 0.035 * sin(uTime * 2.2);

        float alpha =
          0.17 +
          heat * 0.22 +
          uFocus * 0.10 +
          pulse;

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
// HOST CREATION
//
// The placement point is the sting patch itself.
// The torso is positioned around that patch.
// ============================================================

function disposeHost(host) {
  scene.remove(host);

  host.traverse((object) => {
    object.geometry?.dispose();

    if (Array.isArray(object.material)) {
      object.material.forEach((material) => material.dispose());
    } else {
      object.material?.dispose();
    }
  });

  // particleTexture is shared; do not dispose it here.
}

function clearHosts() {
  for (const host of hosts) disposeHost(host);
  hosts.length = 0;
}

function createHost(stingPosition) {
  if (hosts.length >= SETTINGS.maxHosts) {
    disposeHost(hosts.shift());
  }

  const host = new THREE.Group();

  // Face the user at placement time.
  const yaw = Math.atan2(
    headPosition.x - stingPosition.x,
    headPosition.z - stingPosition.z
  );

  host.rotation.y = yaw;

  const rotatedOffset = PATCH_OFFSET.clone()
    .applyQuaternion(host.quaternion);

  host.position.copy(stingPosition).sub(rotatedOffset);

  // Torso-shaped aura.
  const aura = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.23, 0.55, 5, 20),
    createAuraMaterial()
  );

  aura.scale.set(1.05, 1, 0.65);
  host.add(aura);

  // Outer patch: this is the raycast interaction surface.
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(0.085, 32),
    overlayMaterial(COLORS.magenta, 0.85)
  );

  patch.position.copy(PATCH_OFFSET);
  patch.scale.y = 0.85;
  patch.userData.host = host;
  host.add(patch);

  const warmPatch = new THREE.Mesh(
    new THREE.CircleGeometry(0.058, 32),
    overlayMaterial(COLORS.orange, 0.95)
  );

  warmPatch.position.z = 0.003;
  patch.add(warmPatch);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.027, 24),
    overlayMaterial(COLORS.cream, 0.35)
  );

  core.position.z = 0.006;
  patch.add(core);

  // Three incomplete ring segments.
  const segments = new THREE.Group();
  segments.position.copy(PATCH_OFFSET);
  segments.position.z += 0.012;
  host.add(segments);

  for (let i = 0; i < 3; i++) {
    const segment = new THREE.Mesh(
      new THREE.RingGeometry(
        0.105,
        0.114,
        24,
        1,
        i * Math.PI * 2 / 3,
        Math.PI * 0.47
      ),
      overlayMaterial(COLORS.magenta, 0.6)
    );

    segments.add(segment);
  }

  // Closed ring appears when acquisition is complete.
  const closedRing = new THREE.Mesh(
    new THREE.RingGeometry(0.103, 0.115, 48),
    overlayMaterial(COLORS.cream, 0.95)
  );

  closedRing.position.copy(segments.position);
  closedRing.visible = false;
  host.add(closedRing);

  // Expanding sting ripple.
  const stingRipple = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.10, 48),
    overlayMaterial(COLORS.orange, 0)
  );

  stingRipple.position.copy(segments.position);
  stingRipple.position.z += 0.005;
  host.add(stingRipple);

  // Scent particles: curved fictional trail extending
  // from the patch towards the space in front of the host.
  const scentPositions = new Float32Array(
    SETTINGS.scentParticles * 3
  );

  const scentGeometry = new THREE.BufferGeometry();

  scentGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(scentPositions, 3)
  );

  const scent = new THREE.Points(
    scentGeometry,
    new THREE.PointsMaterial({
      color: COLORS.magenta,
      map: particleTexture,
      size: 0.045,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      sizeAttenuation: true
    })
  );

  scent.frustumCulled = false;
  host.add(scent);

  host.userData = {
    aura,
    patch,
    core,
    segments,
    closedRing,
    stingRipple,
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

// Desktop visual preview.
createHost(new THREE.Vector3(0, 1.4, -1.2));

// ============================================================
// CONTROLLER AIMING
// ============================================================

function setControllerRay(controller) {
  scene.updateMatrixWorld(true);

  rayOrigin.setFromMatrixPosition(controller.matrixWorld);
  rotationMatrix.extractRotation(controller.matrixWorld);

  rayDirection
    .set(0, 0, -1)
    .applyMatrix4(rotationMatrix)
    .normalize();

  raycaster.set(rayOrigin, rayDirection);
  raycaster.near = 0;
  raycaster.far = SETTINGS.stingDistance;
}

function getAimedHost(controller) {
  if (!controller.userData.inputSource || !controller.visible) {
    return null;
  }

  setControllerRay(controller);

  const patches = hosts.map((host) => host.userData.patch);

  // Only the sting patches count, not the entire aura.
  const hits = raycaster.intersectObjects(patches, false);

  return hits.length
    ? hits[0].object.userData.host
    : null;
}

function placeHost(controller) {
  if (!renderer.xr.isPresenting) return;

  setControllerRay(controller);

  const position = rayOrigin.clone().addScaledVector(
    rayDirection,
    SETTINGS.placeDistance
  );

  createHost(position);

  showFeedback("Host placed. Aim at the warm patch.");
}

function sting(controller) {
  if (!renderer.xr.isPresenting) return;

  const host = getAimedHost(controller);

  if (!host) {
    showFeedback("Aim at the small warm sting patch.");
    return;
  }

  const data = host.userData;

  if (nowSeconds - data.lastStung < SETTINGS.cooldown) {
    showFeedback("Recovering…", 0.5);
    return;
  }

  if (!data.ready) {
    showFeedback("Hold your aim until the ring closes.");
    return;
  }

  data.lastStung = nowSeconds;
  data.focus = 0;
  data.ready = false;

  stingCount += 1;
  proboscisUntil = nowSeconds + 0.2;

  showFeedback("Sting collected!");

  // Optional controller vibration.
  const actuator =
    controller.userData.inputSource
      ?.gamepad?.hapticActuators?.[0];

  if (actuator) {
    try {
      Promise.resolve(
        actuator.pulse(0.45, 90)
      ).catch(() => {});
    } catch {
      // Haptics must not interrupt the experience.
    }
  }
}

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);

  controller.addEventListener("connected", (event) => {
    controller.userData.inputSource = event.data;
  });

  controller.addEventListener("disconnected", () => {
    controller.userData.inputSource = null;
  });

  controller.addEventListener("selectstart", () => {
    sting(controller);
  });

  controller.addEventListener("squeezestart", () => {
    placeHost(controller);
  });

  // A short pointer replaces the previous long laser.
  const pointer = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -0.14)
    ]),
    new THREE.LineBasicMaterial({
      color: COLORS.cream,
      transparent: true,
      opacity: 0.7
    })
  );

  controller.add(pointer);
  scene.add(controller);
  controllers.push(controller);
}

// ============================================================
// WEBXR STARTUP
// ============================================================

async function checkSupport() {
  if (!window.isSecureContext) {
    startButton.textContent = "HTTPS required";
    statusElement.textContent =
      "Open the HTTPS version of your published website.";
    return;
  }

  if (!navigator.xr) {
    startButton.textContent = "Desktop preview";
    statusElement.textContent =
      "Open this website in the Quest browser for passthrough.";
    return;
  }

  try {
    const supported =
      await navigator.xr.isSessionSupported("immersive-ar");

    if (!supported) {
      startButton.textContent = "AR unavailable";
      statusElement.textContent =
        "This browser is not reporting immersive-ar support.";
      return;
    }

    startButton.disabled = false;
    startButton.textContent = "Enter Mosquito Vision";

    statusElement.textContent =
      "Ready. Grip places a host; trigger performs a sting.";
  } catch (error) {
    statusElement.textContent =
      "Support check failed: " + error.message;
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
      seedOnNextFrame = false;

      panel.style.display = "";
      startButton.disabled = false;
      startButton.textContent = "Enter Mosquito Vision";

      statusElement.textContent =
        "Session ended. Re-enter to reset the sting count.";
    });

    clearHosts();

    stingCount = 0;
    feedbackUntil = 0;
    previousTime = null;
    proboscisUntil = 0;

    await renderer.xr.setSession(session);

    seedOnNextFrame = true;
    panel.style.display = "none";
  } catch (error) {
    if (session) {
      try {
        await session.end();
      } catch {
        // Preserve the original error.
      }
    }

    activeSession = null;
    panel.style.display = "";
    startButton.disabled = false;

    statusElement.textContent =
      "Could not start XR: " + error.message;

    console.error(error);
  }
});

await checkSupport();

// ============================================================
// ANIMATION HELPERS
// ============================================================

const tempPosition = new THREE.Vector3();
const localDirection = new THREE.Vector3();
const inverseHeadQuaternion = new THREE.Quaternion();

function updateAtmosphere(time) {
  for (let i = 0; i < atmosphereSeeds.length; i++) {
    const seed = atmosphereSeeds[i];
    const index = i * 3;

    atmospherePositions[index] =
      seed.x + Math.sin(time * 0.18 + seed.phase) * 0.12;

    atmospherePositions[index + 1] =
      seed.y + Math.sin(time * 0.28 + seed.phase) * 0.08;

    atmospherePositions[index + 2] =
      seed.z + Math.cos(time * 0.16 + seed.phase) * 0.12;
  }

  atmosphereGeometry.attributes.position.needsUpdate = true;

  floorRipples.forEach((ring, i) => {
    const cycle = (time * 0.09 + i / 3) % 1;
    const radius = 0.4 + cycle * 3.6;

    ring.scale.setScalar(radius);
    ring.material.opacity = (1 - cycle) * 0.075;
  });
}

function updateHost(host, time, delta) {
  const data = host.userData;

  const recovering =
    time - data.lastStung < SETTINGS.cooldown;

  const targetFocus = data.aimed && !recovering ? 1 : 0;

  if (targetFocus) {
    data.focus = Math.min(
      1,
      data.focus + delta / SETTINGS.acquisitionTime
    );
  } else {
    // Loss of aim immediately removes sting readiness.
    data.focus = Math.max(0, data.focus - delta * 4);
  }

  data.ready =
    data.aimed &&
    !recovering &&
    data.focus >= 1;

  const flashAge = time - data.lastStung;
  const flash = Math.max(0, 1 - flashAge / 0.45);

  data.aura.material.uniforms.uTime.value = time + data.phase;
  data.aura.material.uniforms.uFocus.value = data.focus;
  data.aura.material.uniforms.uFlash.value = flash;

  data.patch.material.opacity = recovering ? 0.4 : 0.85;
  data.core.material.opacity = 0.3 + data.focus * 0.7;

  data.segments.visible = !data.ready;
  data.closedRing.visible = data.ready;

  data.segments.rotation.z = time * 0.35;
  data.segments.scale.setScalar(1.25 - data.focus * 0.25);

  for (const segment of data.segments.children) {
    segment.material.color.setHex(
      data.aimed ? COLORS.orange : COLORS.magenta
    );

    segment.material.opacity = recovering ? 0.2 : 0.6;
  }

  data.stingRipple.visible = flashAge >= 0 && flashAge < 0.6;

  if (data.stingRipple.visible) {
    data.stingRipple.scale.setScalar(1 + flashAge * 5);
    data.stingRipple.material.opacity =
      (1 - flashAge / 0.6) * 0.9;
  }

  // Particles flow away from the fictional host signature.
  for (let i = 0; i < SETTINGS.scentParticles; i++) {
    const u = (
      i / SETTINGS.scentParticles +
      time * 0.10
    ) % 1;

    const index = i * 3;
    const swirl = u * Math.PI * 3 + data.phase;

    data.scentPositions[index] =
      PATCH_OFFSET.x +
      Math.sin(swirl) * 0.16 * u;

    data.scentPositions[index + 1] =
      PATCH_OFFSET.y +
      u * 0.22 +
      Math.cos(swirl) * 0.05;

    data.scentPositions[index + 2] =
      PATCH_OFFSET.z + u * 1.45;
  }

  data.scent.geometry.attributes.position.needsUpdate = true;

  data.scent.material.color.setHex(
    data.aimed ? COLORS.orange : COLORS.magenta
  );

  data.scent.material.opacity =
    recovering ? 0.25 : 0.55 + data.focus * 0.2;
}

function updateAntennae() {
  let closest = null;
  let closestDistance = Infinity;

  for (const host of hosts) {
    host.userData.patch.getWorldPosition(tempPosition);

    const distance = tempPosition.distanceTo(headPosition);

    if (distance < closestDistance) {
      closestDistance = distance;
      closest = host;
    }
  }

  leftAntenna.material.opacity = 0.22;
  rightAntenna.material.opacity = 0.22;

  if (!closest) return;

  closest.userData.patch.getWorldPosition(tempPosition);

  inverseHeadQuaternion.copy(headQuaternion).invert();

  localDirection
    .copy(tempPosition)
    .sub(headPosition)
    .applyQuaternion(inverseHeadQuaternion)
    .normalize();

  // Left/right cues refer to the nearest manually placed host.
  if (localDirection.x < -0.15) {
    leftAntenna.material.opacity = 0.8;
  } else if (localDirection.x > 0.15) {
    rightAntenna.material.opacity = 0.8;
  } else {
    leftAntenna.material.opacity = 0.65;
    rightAntenna.material.opacity = 0.65;
  }

  const focused = hosts.some((host) => host.userData.aimed);
  const color = focused ? COLORS.orange : COLORS.magenta;

  leftAntenna.material.color.setHex(color);
  rightAntenna.material.color.setHex(color);
}

// ============================================================
// MAIN LOOP
// ============================================================

renderer.setAnimationLoop((milliseconds, frame) => {
  nowSeconds = milliseconds / 1000;

  const delta = previousTime === null
    ? 0
    : Math.min(nowSeconds - previousTime, 0.05);

  previousTime = nowSeconds;

  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(referenceSpace);

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

      if (seedOnNextFrame) {
        // Centre the environmental field on the starting area.
        atmosphere.position.set(
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

        for (const offset of [-0.45, 0.45]) {
          const stingPosition = headPosition.clone()
            .addScaledVector(forward, 1.25)
            .addScaledVector(right, offset);

          stingPosition.y -= 0.20;

          createHost(stingPosition);
        }

        seedOnNextFrame = false;
      }
    }
  } else {
    headPosition.copy(camera.position);
    headQuaternion.copy(camera.quaternion);
  }

  // Clear aim state, then combine both controllers' selections.
  for (const host of hosts) {
    host.userData.aimed = false;
  }

  if (renderer.xr.isPresenting) {
    for (const controller of controllers) {
      const host = getAimedHost(controller);

      if (host) host.userData.aimed = true;
    }
  }

  updateAtmosphere(nowSeconds);

  for (const host of hosts) {
    updateHost(host, nowSeconds, delta);
  }

  scene.updateMatrixWorld(true);
  updateAntennae();

  proboscis.scale.z =
    nowSeconds < proboscisUntil ? 1.35 : 1;

  let message = "Grip: place host | Follow the scent trail";

  if (hosts.some((host) => host.userData.aimed)) {
    message = hosts.some((host) => host.userData.ready)
      ? "Host acquired — press trigger"
      : "Hold aim — acquiring host";
  }

  if (nowSeconds < feedbackUntil) {
    message = feedbackText;
  }

  updateHUD(message);

  renderer.render(scene, camera);
});

// ============================================================
// WINDOW RESIZE
// ============================================================

window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
});
