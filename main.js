import * as THREE from
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

// ------------------------------------------------------------
// Configuration
// Distances are in metres.
// ------------------------------------------------------------

const PLACE_DISTANCE = 0.75;
const STING_DISTANCE = 1.5;
const STING_COOLDOWN = 0.65;
const MAX_TARGETS = 12;

const startButton = document.getElementById("start");
const statusElement = document.getElementById("status");
const panel = document.getElementById("panel");

// ------------------------------------------------------------
// Scene and transparent renderer
// Do not give the scene an opaque background:
// passthrough must remain visible behind the virtual objects.
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// State
// ------------------------------------------------------------

const targets = [];
const controllers = [];

let stingCount = 0;
let lastStingTime = -Infinity;
let seedTargetsOnNextFrame = false;
let activeSession = null;
let hudMessage = "Grip: place | Trigger: sting";

const raycaster = new THREE.Raycaster();

const origin = new THREE.Vector3();
const direction = new THREE.Vector3();
const rotation = new THREE.Matrix4();

// ------------------------------------------------------------
// Head-attached mosquito visuals
// These are artistic overlays, not camera-image processing.
// ------------------------------------------------------------

const visor = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshBasicMaterial({
    color: 0xff7800,
    transparent: true,
    opacity: 0.08,
    depthTest: false,
    depthWrite: false
  })
);

visor.position.set(0, 0, -1);
visor.renderOrder = 100;
camera.add(visor);

function makeHeadLine(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map((point) => new THREE.Vector3(...point))
  );

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    depthWrite: false
  });

  const line = new THREE.Line(geometry, material);
  line.renderOrder = 110;
  camera.add(line);

  return line;
}

// Antennae
makeHeadLine(
  [
    [-0.17, 0.12, -0.4],
    [-0.24, 0.2, -0.5],
    [-0.3, 0.25, -0.6]
  ],
  0xffbc63
);

makeHeadLine(
  [
    [0.17, 0.12, -0.4],
    [0.24, 0.2, -0.5],
    [0.3, 0.25, -0.6]
  ],
  0xffbc63
);

// Proboscis: extends briefly when you sting.
const proboscis = makeHeadLine(
  [
    [0, -0.12, -0.3],
    [0, -0.08, -0.6]
  ],
  0xffe3a0
);

let proboscisFlashUntil = 0;

// ------------------------------------------------------------
// In-headset HUD
// A 3D plane is used instead of relying on HTML DOM overlays.
// ------------------------------------------------------------

const hudCanvas = document.createElement("canvas");
hudCanvas.width = 1024;
hudCanvas.height = 256;

const hudContext = hudCanvas.getContext("2d");

if (!hudContext) {
  throw new Error("Could not create the HUD canvas.");
}

const hudTexture = new THREE.CanvasTexture(hudCanvas);
hudTexture.colorSpace = THREE.SRGBColorSpace;

const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.9, 0.225),
  new THREE.MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  })
);

hud.position.set(0, -0.28, -1);
hud.renderOrder = 120;
camera.add(hud);

function updateHUD(message = hudMessage) {
  hudMessage = message;

  hudContext.clearRect(0, 0, 1024, 256);

  hudContext.fillStyle = "rgba(20, 8, 0, 0.75)";
  hudContext.fillRect(0, 0, 1024, 256);

  hudContext.textAlign = "center";

  hudContext.fillStyle = "#ffe7a0";
  hudContext.font = "bold 76px sans-serif";
  hudContext.fillText(`STINGS: ${stingCount}`, 512, 110);

  hudContext.fillStyle = "#ffffff";
  hudContext.font = "32px sans-serif";
  hudContext.fillText(message, 512, 185);

  hudTexture.needsUpdate = true;
}

updateHUD();

// ------------------------------------------------------------
// Thermal-looking targets
// Their colours are generated for virtual objects only.
// ------------------------------------------------------------

const targetGeometry = new THREE.SphereGeometry(0.16, 24, 16);

function makeHeatMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFlash: { value: 0 }
    },

    vertexShader: `
      varying vec3 vNormalView;

      void main() {
        vNormalView = normalize(normalMatrix * normal);

        gl_Position =
          projectionMatrix *
          modelViewMatrix *
          vec4(position, 1.0);
      }
    `,

    fragmentShader: `
      uniform float uFlash;
      varying vec3 vNormalView;

      void main() {
        // The centre looks hotter than the silhouette.
        // This is a visual effect, not real heat data.
        float heat = pow(
          max(normalize(vNormalView).z, 0.0),
          0.65
        );

        vec3 red = vec3(1.0, 0.03, 0.0);
        vec3 orange = vec3(1.0, 0.35, 0.0);
        vec3 yellow = vec3(1.0, 0.95, 0.15);

        vec3 color = mix(
          red,
          orange,
          smoothstep(0.0, 0.55, heat)
        );

        color = mix(
          color,
          yellow,
          smoothstep(0.5, 1.0, heat)
        );

        color = mix(
          color,
          vec3(0.2, 1.0, 0.35),
          uFlash
        );

        gl_FragColor = vec4(color, 0.88);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,

    transparent: true,
    depthWrite: false
  });
}

function addTarget(position) {
  if (targets.length >= MAX_TARGETS) {
    const oldest = targets.shift();
    scene.remove(oldest);
    oldest.material.dispose();
  }

  const target = new THREE.Mesh(
    targetGeometry,
    makeHeatMaterial()
  );

  target.position.copy(position);

  target.userData.flashUntil = 0;
  target.userData.lastStung = -Infinity;

  scene.add(target);
  targets.push(target);

  return target;
}

function clearTargets() {
  for (const target of targets) {
    scene.remove(target);
    target.material.dispose();
  }

  targets.length = 0;
}

// Desktop preview target. Replaced when XR starts.
addTarget(new THREE.Vector3(0, 1.6, -1.2));

// ------------------------------------------------------------
// Controller interaction
// WebXR target-ray direction is the controller's local -Z.
// ------------------------------------------------------------

function setRayFromController(controller) {
  scene.updateMatrixWorld(true);

  origin.setFromMatrixPosition(controller.matrixWorld);

  rotation.extractRotation(controller.matrixWorld);

  direction
    .set(0, 0, -1)
    .applyMatrix4(rotation)
    .normalize();

  raycaster.set(origin, direction);
  raycaster.near = 0;
  raycaster.far = STING_DISTANCE;
}

function placeTarget(controller) {
  if (!renderer.xr.isPresenting) return;

  setRayFromController(controller);

  const position = origin.clone().addScaledVector(
    direction,
    PLACE_DISTANCE
  );

  addTarget(position);

  updateHUD("Target placed. Aim and press trigger.");
}

function sting(controller) {
  if (!renderer.xr.isPresenting) return;

  const now = performance.now() / 1000;

  if (now - lastStingTime < STING_COOLDOWN) return;

  setRayFromController(controller);

  const intersections = raycaster.intersectObjects(
    targets,
    false
  );

  if (intersections.length === 0) {
    updateHUD("Miss — aim at a heat target.");
    return;
  }

  const target = intersections[0].object;

  if (now - target.userData.lastStung < 1.0) return;

  lastStingTime = now;
  target.userData.lastStung = now;
  target.userData.flashUntil = now + 0.4;

  proboscisFlashUntil = now + 0.2;

  stingCount += 1;
  updateHUD("Sting!");

  // Optional vibration; not all browsers/devices expose it.
  const gamepad = controller.userData.inputSource?.gamepad;
  const actuator = gamepad?.hapticActuators?.[0];

  if (actuator) {
    try {
      Promise.resolve(actuator.pulse(0.5, 100)).catch(() => {});
    } catch {
      // Vibration failure should not interrupt gameplay.
    }
  }
}

for (let index = 0; index < 2; index += 1) {
  const controller = renderer.xr.getController(index);

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
    placeTarget(controller);
  });

  // A visible pointing ray.
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -STING_DISTANCE)
  ]);

  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({
      color: 0xffd17a,
      transparent: true,
      opacity: 0.6
    })
  );

  controller.add(ray);
  scene.add(controller);
  controllers.push(controller);
}

// ------------------------------------------------------------
// WebXR startup
// No opaque VR fallback: this project requires passthrough AR.
// ------------------------------------------------------------

async function checkSupport() {
  if (!window.isSecureContext) {
    startButton.textContent = "HTTPS required";
    statusElement.textContent =
      "Publish using HTTPS before opening this on Quest.";
    return;
  }

  if (!navigator.xr) {
    startButton.textContent = "WebXR unavailable";
    statusElement.textContent =
      "Desktop preview only. Open the published page on Quest.";
    return;
  }

  try {
    const supported = await navigator.xr.isSessionSupported(
      "immersive-ar"
    );

    if (!supported) {
      startButton.textContent = "AR unavailable";
      statusElement.textContent =
        "This browser/device is not reporting immersive-ar support.";
      return;
    }

    startButton.disabled = false;
    startButton.textContent = "Enter Mosquito XR";
    statusElement.textContent = "Ready. Use your Quest controllers.";
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
    // Must be requested directly from the user's button click.
    session = await navigator.xr.requestSession(
      "immersive-ar",
      {
        requiredFeatures: ["local-floor"]
      }
    );

    activeSession = session;

    session.addEventListener("end", () => {
      activeSession = null;
      seedTargetsOnNextFrame = false;

      panel.style.display = "";
      startButton.disabled = false;
      startButton.textContent = "Enter Mosquito XR";

      statusElement.textContent =
        "Session ended. Re-enter to start a new count.";
    });

    clearTargets();

    stingCount = 0;
    lastStingTime = -Infinity;
    updateHUD("Grip: place | Trigger: sting");

    await renderer.xr.setSession(session);

    seedTargetsOnNextFrame = true;
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
    startButton.disabled = false;
    panel.style.display = "";

    statusElement.textContent =
      "Could not start XR: " + error.message;

    console.error(error);
  }
});

await checkSupport();

// ------------------------------------------------------------
// Animation
// ------------------------------------------------------------

renderer.setAnimationLoop((time, frame) => {
  const seconds = time / 1000;

  // Place initial test targets relative to the user's actual
  // starting head pose, rather than an assumed room origin.
  if (seedTargetsOnNextFrame && frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(referenceSpace);

    if (pose) {
      const headPosition = new THREE.Vector3(
        pose.transform.position.x,
        pose.transform.position.y,
        pose.transform.position.z
      );

      const headRotation = new THREE.Quaternion(
        pose.transform.orientation.x,
        pose.transform.orientation.y,
        pose.transform.orientation.z,
        pose.transform.orientation.w
      );

      const forward = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(headRotation);

      const right = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(headRotation);

      for (const offset of [-0.4, 0, 0.4]) {
        const position = headPosition.clone()
          .addScaledVector(forward, 1.1)
          .addScaledVector(right, offset);

        position.y -= 0.15;

        addTarget(position);
      }

      seedTargetsOnNextFrame = false;
    }
  }

  for (const target of targets) {
    target.material.uniforms.uFlash.value =
      seconds < target.userData.flashUntil ? 1 : 0;

    const pulse = 1 + Math.sin(seconds * 3) * 0.035;
    target.scale.setScalar(pulse);
  }

  proboscis.scale.z =
    seconds < proboscisFlashUntil ? 1.3 : 1;

  renderer.render(scene, camera);
});

// ------------------------------------------------------------
// Resize: only change the ordinary desktop camera outside XR.
// ------------------------------------------------------------

window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
});
