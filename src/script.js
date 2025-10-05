
(async () => {
  const url = '/HDR_rich_multi_nebulae_3.hdr'; // change if different
  try {
    const r = await fetch(url);
    console.log('status', r.status, 'content-type', r.headers.get('content-type'));
    const buf = await r.arrayBuffer();
    console.log('bytes:', buf.byteLength);
    const head = new TextDecoder().decode(buf.slice(0, 128));
    console.log('ASCII header preview:', head.replace(/\n/g, '\\n'));
    // Print hex preview for binary signatures
    const arr = new Uint8Array(buf.slice(0, 16));
    console.log('hex signature:', Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join(' '));
  } catch (e) {
    console.error('fetch error', e);
  }
})();

// ============================================
// IMPORTS
// ============================================
import * as THREE from "three";
import earthVertexShader from "./shaders/earth/vertex.glsl";
import earthFragmentShader from "./shaders/earth/fragment.glsl";
import atmosphereVertexShader from "./shaders/atmosphere/vertex.glsl";
import atmosphereFragmentShader from "./shaders/atmosphere/fragment.glsl";
import cloudVertexShader from "./shaders/clouds/vertex.glsl";
import cloudFragmentShader from "./shaders/clouds/fragment.glsl";
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'  


// ============================================
// LOADING SCREEN LOGIC (DOM hooks)
// ============================================
let experienceReady = false;
let totalAssets = 0;
let loadedAssets = 0;

const enterBtn = document.querySelector('.enter-btn');
const bodyWrapper = document.querySelector('.body-wrapper');
const loaderScreen = document.querySelector('.loader-screen');
const progressFill = document.querySelector('.progress-fill');
const progressText = document.querySelector('.progress-text');
const loaderSubtitle = document.querySelector('.loader-subtitle');
const canvas = document.querySelector('canvas.webgl');

if (!enterBtn || !bodyWrapper || !loaderScreen || !progressFill || !progressText || !canvas) {
  throw new Error('Required DOM elements not found (.enter-btn, .body-wrapper, .loader-screen, .progress-fill, .progress-text, canvas.webgl)');
}

// When enter is clicked: fade intro and start actual loading
enterBtn.addEventListener('click', () => {
  bodyWrapper.classList.add('fade-out');
  setTimeout(() => {
    loaderScreen.classList.add('active');
    initThreeJS(); // start init & loading only after user click
  }, 800);
});

// Start the experience: fade out loader, enable canvas, play audio
function startExperience() {
  loaderScreen.classList.add('fade-out');

  setTimeout(() => {
    loaderScreen.style.display = 'none';
    canvas.classList.add('active');
    experienceReady = true;

    // Play background music now (browser will accept since user clicked Enter already)
    if (backgroundMusic && !backgroundMusic.isPlaying) {
      try { backgroundMusic.play(); } catch (err) { console.warn('Audio play failed:', err); }
    }
  }, 800);
}

// Helper UI update
function updateProgressUI(percent) {
  progressFill.style.width = percent + '%';
  progressText.textContent = Math.floor(percent) + '%';
}

// ============================================
// MAIN THREE.JS EXPERIENCE (production-ready — no lil-gui)
// ============================================

// forward declarations so existing helper functions can reference them
let scene;
let loader;
let earthDayTexture, earthNightTexture, earthSpecularCloudsTexture, cloudsTexture, cloudsNormal;
let EARTH_RADIUS = 2.0, ATMOSPHERE_RADIUS = 2.09;
let earthGroup, earth, atmosphere, clouds;
let atmosphereMaterial, earthMaterial, cloudMaterial;
let atmoUniforms;
let camera, renderer;
let pmremGenerator;
let rgbeLoader;
let currentEnv = null;
let currentRawHDR = null;
let backgroundMusic = null;
let sound = null;

// AUDIO SETUP (listener attached once camera exists)
const audioLoader = new THREE.AudioLoader();
function initAudio() {
  const listener = new THREE.AudioListener();
  camera.add(listener);
  sound = new THREE.Audio(listener);
  audioLoader.load(
    '/voice.mp3',
    (buffer) => {
      sound.setBuffer(buffer);
      sound.setLoop(true);
      sound.setVolume(1.0);
      // don't play yet — play in startExperience()
      backgroundMusic = sound;
    },
    undefined,
    (err) => {
      console.error('Audio load error:', err);
    }
  );
}

// Primary initializer (called after Enter click)
function initThreeJS() {
  // ------------------------------
  // Scene
  // ------------------------------
  scene = new THREE.Scene();

  // ------------------------------
  // Sizes, Camera & Renderer
  // ------------------------------
  const sizes = {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: Math.min(window.devicePixelRatio, 2),
  };

  window.addEventListener("resize", () => {
    sizes.width = window.innerWidth;
    sizes.height = window.innerHeight;
    sizes.pixelRatio = Math.min(window.devicePixelRatio, 2);
    if (camera) { camera.aspect = sizes.width / sizes.height; camera.updateProjectionMatrix(); }
    if (renderer) { renderer.setSize(sizes.width, sizes.height); renderer.setPixelRatio(sizes.pixelRatio); }
  });

  // camera (initial placement you provided)
  camera = new THREE.PerspectiveCamera(30, sizes.width / sizes.height, 0.1, 100);
  camera.position.set(4.2, 2.6, 2.0);
  camera.rotation.set(-1.0352642958308822, 1.101825032519919, 0.9838163195887895);
  scene.add(camera);

  // renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setSize(sizes.width, sizes.height);
  renderer.setPixelRatio(sizes.pixelRatio);
  renderer.setClearColor("#000000");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  if ("outputEncoding" in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

  // PMREM generator (for HDR -> env)
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // init audio now that camera exists
  initAudio();

  // ------------------------------
  // Loading manager (REAL tracking) and loaders
  // ------------------------------
  const loadingManager = new THREE.LoadingManager();

  loadingManager.onStart = (url, itemsLoadedOnStart, itemsTotalOnStart) => {
    totalAssets = itemsTotalOnStart || 0;
    loadedAssets = itemsLoadedOnStart || 0;
    const percent = totalAssets ? (loadedAssets / totalAssets) * 100 : 0;
    updateProgressUI(percent);
  };

  loadingManager.onProgress = (url, itemsLoadedNow, itemsTotalNow) => {
    loadedAssets = itemsLoadedNow;
    totalAssets = itemsTotalNow;
    const percent = totalAssets ? (loadedAssets / totalAssets) * 100 : 0;
    updateProgressUI(percent);
  };

  loadingManager.onError = (url) => console.warn('LoadingManager error for:', url);

  // CRITICAL: when everything that LoadingManager tracks is loaded -> finalize and start experience
  loadingManager.onLoad = () => {
    // Ensure progress reads 100% and subtitle shows
    updateProgressUI(100);
    loaderSubtitle.classList.add('show');

    // Attempt to precompile shaders (best-effort)
    try { renderer.compile(scene, camera); } catch (err) { console.warn('renderer.compile failed (ignored):', err); }

    // Respect the 3s grace window you wanted, then show experience
    setTimeout(() => {
      startExperience();
    }, 3000);
  };

  // create texture loader that uses our loadingManager
  loader = new THREE.TextureLoader(loadingManager);

  // ------------------------------
  // Textures (queued and tracked by loadingManager)
  // ------------------------------
  earthDayTexture = loader.load("./earth/Earth_Diffuse_21k.webp");
  earthNightTexture = loader.load("./earth/AAA.webp");
  earthSpecularCloudsTexture = loader.load("./earth/specularClouds.jpg");
  cloudsTexture = loader.load("./earth/Earth_Clouds_16k.jpg");
  cloudsNormal = loader.load("./earth/Earth_Clouds_Normal_16k.jpg");

  if (THREE.SRGBColorSpace) {
    earthDayTexture.colorSpace = THREE.SRGBColorSpace;
    earthNightTexture.colorSpace = THREE.SRGBColorSpace;
    earthSpecularCloudsTexture.colorSpace = THREE.SRGBColorSpace;
    cloudsTexture.colorSpace = THREE.SRGBColorSpace;
    cloudsNormal.colorSpace = THREE.NoColorSpace;
  } else {
    earthDayTexture.encoding = THREE.sRGBEncoding;
    earthNightTexture.encoding = THREE.sRGBEncoding;
    earthSpecularCloudsTexture.encoding = THREE.sRGBEncoding;
    cloudsTexture.encoding = THREE.sRGBEncoding;
  }

  // ------------------------------
  // Scene scale & groups
  // ------------------------------
  EARTH_RADIUS = 2.0;
  ATMOSPHERE_RADIUS = 2.09;

  earthGroup = new THREE.Group();
  earthGroup.name = "EarthGroup";
  earthGroup.position.set(0, 0, 0);
  scene.add(earthGroup);

  const groupSettings = { positionX: 0, positionY: 0, positionZ: 0 };

  // these are your production atmosphere defaults
  const atmosphereSettings = {
    atmosphereDayColor: "#294b8e",
    twilightColor: "#7aadff",
    atmosphereIntensity: 3.85,
    rayleighStrength: 80,
    mieStrength: 80,
    scatteringPower: 0.1,
    rimDayColor: "#182a30",
    rimTwilightColor: "#3d5dff",
    rimIntensity: 6.0,
    rimPower: 80.0,
    rimStart: 0.55,
    rimEnd: 1.0,
    rimAltitudeBoost: 0.67,
    haloColor: "#001eff",
    haloIntensity: 20.0,
    haloThickness: 0.5,
    haloSoftness: 1.0,
    sunAzimuth: 3.141592,
    sunElevation: 1.57079,
    debugMode: 0,
  };

  // ------------------------------
  // Earth material + mesh
  // ------------------------------
  earthMaterial = new THREE.ShaderMaterial({
    vertexShader: earthVertexShader,
    fragmentShader: earthFragmentShader,
    uniforms: {
      uDayTexture: { value: earthDayTexture },
      uNightTexture: { value: earthNightTexture },
      uCloudsTexture: { value: cloudsTexture },
      uSpecularCloudsTexture: { value: earthSpecularCloudsTexture },
      uSunDirection: { value: new THREE.Vector3(0, 0, 1) },
      uAtmosphereDayColor: { value: new THREE.Color(atmosphereSettings.atmosphereDayColor) },
      uTwilightColor: { value: new THREE.Color(atmosphereSettings.twilightColor) },
      uAtmosphereIntensity: { value: atmosphereSettings.atmosphereIntensity },
    },
    onCompile: (shader) => { /* no-op: compile precompilation handled by renderer.compile */ }
  });

  earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), earthMaterial);
  earth.name = "Earth";
  earthGroup.add(earth);

  // ------------------------------
  // Atmosphere
  // ------------------------------
  atmoUniforms = {
    uSunDirection: { value: new THREE.Vector3(0.0, 0.3, 1.0).normalize() },
    uAtmosphereDayColor: { value: new THREE.Color(atmosphereSettings.atmosphereDayColor) },
    uTwilightColor: { value: new THREE.Color(atmosphereSettings.twilightColor) },
    uAtmosphereIntensity: { value: atmosphereSettings.atmosphereIntensity },
    uRayleighStrength: { value: atmosphereSettings.rayleighStrength },
    uMieStrength: { value: atmosphereSettings.mieStrength },
    uScatteringPower: { value: atmosphereSettings.scatteringPower },
    uDebugMode: { value: atmosphereSettings.debugMode },
    uRimDayColor: { value: new THREE.Color(atmosphereSettings.rimDayColor) },
    uRimTwilightColor: { value: new THREE.Color(atmosphereSettings.rimTwilightColor) },
    uRimIntensity: { value: atmosphereSettings.rimIntensity },
    uRimPower: { value: atmosphereSettings.rimPower },
    uRimStart: { value: atmosphereSettings.rimStart },
    uRimEnd: { value: atmosphereSettings.rimEnd },
    uRimAltitudeBoost: { value: atmosphereSettings.rimAltitudeBoost },
    uHaloColor: { value: new THREE.Color(atmosphereSettings.haloColor) },
    uHaloIntensity: { value: atmosphereSettings.haloIntensity },
    uHaloThickness: { value: atmosphereSettings.haloThickness },
    uHaloSoftness: { value: atmosphereSettings.haloSoftness },
  };

  atmosphereMaterial = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: atmoUniforms,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    onCompile: () => {}
  });

  atmosphere = new THREE.Mesh(new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 128, 96), atmosphereMaterial);
  atmosphere.name = "Atmosphere";
  atmosphere.renderOrder = 2;
  earthGroup.add(atmosphere);

  // ------------------------------
  // Clouds
  // ------------------------------
  cloudMaterial = new THREE.ShaderMaterial({
    transparent: true,
    vertexShader: cloudVertexShader,
    fragmentShader: cloudFragmentShader,
    uniforms: {
      uCloudsTexture: { value: cloudsTexture },
      uCloudsNormal: { value: cloudsNormal },
      uSunDirection: { value: atmoUniforms.uSunDirection.value },
    },
    onCompile: () => {}
  });

  clouds = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * 1.01, 64, 64), cloudMaterial);
  earthGroup.add(clouds);

  // ------------------------------
  // HDR via RGBELoader (tracked by same loadingManager)
  // ------------------------------
 
rgbeLoader = new RGBELoader(loadingManager)

  rgbeLoader.setDataType(THREE.HalfFloatType); // or THREE.FloatType

  // load a default HDR environment for production
  rgbeLoader.load('./HDR_rich_multi_nebulae_3.hdr', (hdrTexture)=>{
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping
    scene.background = hdrTexture
    scene.environment = hdrTexture
  })
  // ------------------------------
  // Helper functions (preserved)
  // ------------------------------
  function updateSunVectorFromSettings() {
    const az = atmosphereSettings.sunAzimuth;
    const el = atmosphereSettings.sunElevation;
    const s = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    atmoUniforms.uSunDirection.value.copy(s);
    if (atmosphereMaterial && atmosphereMaterial.uniforms) atmosphereMaterial.uniforms.uSunDirection.value.copy(s);
    if (earthMaterial && earthMaterial.uniforms) earthMaterial.uniforms.uSunDirection.value.copy(s);
    if (cloudMaterial && cloudMaterial.uniforms) cloudMaterial.uniforms.uSunDirection.value.copy(s);
    if (debugSun) debugSun.position.copy(s).multiplyScalar(14);
  }

  function applyAtmosphereSettings() {
    atmoUniforms.uAtmosphereDayColor.value.set(atmosphereSettings.atmosphereDayColor);
    atmoUniforms.uTwilightColor.value.set(atmosphereSettings.twilightColor);
    atmoUniforms.uAtmosphereIntensity.value = atmosphereSettings.atmosphereIntensity;
    atmoUniforms.uRayleighStrength.value = atmosphereSettings.rayleighStrength;
    atmoUniforms.uMieStrength.value = atmosphereSettings.mieStrength;
    atmoUniforms.uScatteringPower.value = atmosphereSettings.scatteringPower;
    atmoUniforms.uDebugMode.value = atmosphereSettings.debugMode;
    atmoUniforms.uRimDayColor.value.set(atmosphereSettings.rimDayColor);
    atmoUniforms.uRimTwilightColor.value.set(atmosphereSettings.rimTwilightColor);
    atmoUniforms.uRimIntensity.value = atmosphereSettings.rimIntensity;
    atmoUniforms.uRimPower.value = atmosphereSettings.rimPower;
    atmoUniforms.uRimStart.value = atmosphereSettings.rimStart;
    atmoUniforms.uRimEnd.value = atmosphereSettings.rimEnd;
    atmoUniforms.uRimAltitudeBoost.value = atmosphereSettings.rimAltitudeBoost;
    atmoUniforms.uHaloColor.value.set(atmosphereSettings.haloColor);
    atmoUniforms.uHaloIntensity.value = atmosphereSettings.haloIntensity;
    atmoUniforms.uHaloThickness.value = atmosphereSettings.haloThickness;
    atmoUniforms.uHaloSoftness.value = atmosphereSettings.haloSoftness;

    if (earthMaterial && earthMaterial.uniforms) {
      earthMaterial.uniforms.uAtmosphereDayColor.value.copy(atmoUniforms.uAtmosphereDayColor.value);
      earthMaterial.uniforms.uTwilightColor.value.copy(atmoUniforms.uTwilightColor.value);
      earthMaterial.uniforms.uAtmosphereIntensity.value = atmoUniforms.uAtmosphereIntensity.value;
    }

    updateSunVectorFromSettings();
  }

  // ------------------------------
  // Minimal camera ref helper (replaces GUI updating)
  // ------------------------------
  const cameraRef = { x: camera.position.x, y: camera.position.y, z: camera.position.z, autoApply: true };
  function updateGuiCameraRefFromCamera() { // name preserved for compatibility with earlier calls
    cameraRef.x = camera.position.x;
    cameraRef.y = camera.position.y;
    cameraRef.z = camera.position.z;
  }

  // ------------------------------
  // Reference camera / misc helpers kept (no GUI)
  // ------------------------------
  function applyReferencePositionToOrbitAndBase() {
    setInitialOrbitFromCamera();
    _tmpObj.position.copy(camera.position); _tmpObj.lookAt(cameraOrbit.target);
    const lookAtQuatNow = _tmpObj.quaternion.clone();
    const currentBaseQuat = camera.quaternion.clone();
    baseOffsetQuat = currentBaseQuat.clone().multiply(lookAtQuatNow.clone().invert());
    const newBaseEuler = new THREE.Euler().setFromQuaternion(currentBaseQuat, "XYZ");
    mouseLook.baseRotationX = newBaseEuler.x; mouseLook.baseRotationY = newBaseEuler.y; mouseLook.baseRotationZ = newBaseEuler.z;
    mouseLook.rotationX = mouseLook.baseRotationX; mouseLook.rotationY = mouseLook.baseRotationY; mouseLook.rotationZ = mouseLook.baseRotationZ;
    updateGuiCameraRefFromCamera();
  }

  function captureCurrentCameraAsReference() {
    updateGuiCameraRefFromCamera();
    setInitialOrbitFromCamera();
    _tmpObj.position.copy(camera.position); _tmpObj.lookAt(cameraOrbit.target);
    const lookAtQuatNow = _tmpObj.quaternion.clone();
    baseOffsetQuat = camera.quaternion.clone().multiply(lookAtQuatNow.clone().invert());
    const newBaseEuler = new THREE.Euler().setFromQuaternion(camera.quaternion, "XYZ");
    mouseLook.baseRotationX = newBaseEuler.x; mouseLook.baseRotationY = newBaseEuler.y; mouseLook.baseRotationZ = newBaseEuler.z;
    mouseLook.rotationX = mouseLook.baseRotationX; mouseLook.rotationY = mouseLook.baseRotationY; mouseLook.rotationZ = mouseLook.baseRotationZ;
  }

  // ------------------------------
  // Orbit & mouseLook setup (kept intact)
  // ------------------------------
  const cameraOrbit = { target: earthGroup.position.clone(), distance: 0, azimuth: 0, inclination: 0, autoRotateSpeed: 0.12, enabled: true };
  const _tmpObj = new THREE.Object3D();
  function setInitialOrbitFromCamera() {
    const offset = new THREE.Vector3().subVectors(camera.position, cameraOrbit.target);
    cameraOrbit.distance = offset.length();
    if (cameraOrbit.distance === 0) { cameraOrbit.azimuth = 0; cameraOrbit.inclination = 0; return; }
    cameraOrbit.inclination = Math.asin(offset.y / cameraOrbit.distance);
    cameraOrbit.azimuth = Math.atan2(offset.z, offset.x);
  }
  setInitialOrbitFromCamera();
  _tmpObj.position.copy(camera.position); _tmpObj.lookAt(cameraOrbit.target);
  const lookAtQuatInitial = _tmpObj.quaternion.clone();
  const baseQuat = camera.quaternion.clone();
  let baseOffsetQuat = baseQuat.clone().multiply(lookAtQuatInitial.clone().invert());

  const mouseLook = {
    rotationX: -1.0352642958308822, rotationY: 1.101825032519919, rotationZ: 0.9838163195887895,
    baseRotationX: -1.0352642958308822, baseRotationY: 1.101825032519919, baseRotationZ: 0.9838163195887895,
    velocityX: 0, velocityY: 0, targetVelocityX: 0, targetVelocityY: 0,
    sensitivity: 0.0025, acceleration: 0.08, friction: 0.012, maxVelocity: 0.025,
    minVertical: -0.15, maxVertical: 0.15, minHorizontal: -0.2, maxHorizontal: 0.2,
  };

  window.addEventListener("mousemove", (e) => {
    const movementX = e.movementX || 0, movementY = e.movementY || 0;
    mouseLook.targetVelocityY = -movementX * mouseLook.sensitivity;
    mouseLook.targetVelocityX = -movementY * mouseLook.sensitivity;
    mouseLook.targetVelocityX = Math.max(-mouseLook.maxVelocity, Math.min(mouseLook.maxVelocity, mouseLook.targetVelocityX));
    mouseLook.targetVelocityY = Math.max(-mouseLook.maxVelocity, Math.min(mouseLook.maxVelocity, mouseLook.targetVelocityY));
  });

  function updateMouseLookRotation() {
    mouseLook.velocityX += (mouseLook.targetVelocityX - mouseLook.velocityX) * mouseLook.acceleration;
    mouseLook.velocityY += (mouseLook.targetVelocityY - mouseLook.velocityY) * mouseLook.acceleration;
    mouseLook.targetVelocityX *= 0.85; mouseLook.targetVelocityY *= 0.85;
    mouseLook.rotationX += mouseLook.velocityX; mouseLook.rotationY += mouseLook.velocityY;
    mouseLook.rotationX = Math.max(mouseLook.baseRotationX + mouseLook.minVertical, Math.min(mouseLook.baseRotationX + mouseLook.maxVertical, mouseLook.rotationX));
    mouseLook.rotationY = Math.max(mouseLook.baseRotationY + mouseLook.minHorizontal, Math.min(mouseLook.baseRotationY + mouseLook.maxHorizontal, mouseLook.rotationY));
    if (Math.abs(mouseLook.velocityX) > 0.0001) { if (mouseLook.velocityX > 0) mouseLook.velocityX = Math.max(0, mouseLook.velocityX - mouseLook.friction); else mouseLook.velocityX = Math.min(0, mouseLook.velocityX + mouseLook.friction); }
    if (Math.abs(mouseLook.velocityY) > 0.0001) { if (mouseLook.velocityY > 0) mouseLook.velocityY = Math.max(0, mouseLook.velocityY - mouseLook.friction); else mouseLook.velocityY = Math.min(0, mouseLook.velocityY + mouseLook.friction); }
  }

  // ------------------------------
  // Animation loop (preserved)
  // ------------------------------
  const clock = new THREE.Clock();

  function syncUniformsPerFrame() {
    if (!atmosphereMaterial || !earthMaterial) return;
    atmosphereMaterial.uniforms.uAtmosphereDayColor.value.copy(atmoUniforms.uAtmosphereDayColor.value);
    atmosphereMaterial.uniforms.uTwilightColor.value.copy(atmoUniforms.uTwilightColor.value);
    atmosphereMaterial.uniforms.uAtmosphereIntensity.value = atmoUniforms.uAtmosphereIntensity.value;
    atmosphereMaterial.uniforms.uRayleighStrength.value = atmoUniforms.uRayleighStrength.value;
    atmosphereMaterial.uniforms.uMieStrength.value = atmoUniforms.uMieStrength.value;
    atmosphereMaterial.uniforms.uScatteringPower.value = atmoUniforms.uScatteringPower.value;
    atmosphereMaterial.uniforms.uRimDayColor.value.copy(atmoUniforms.uRimDayColor.value);
    atmosphereMaterial.uniforms.uRimTwilightColor.value.copy(atmoUniforms.uRimTwilightColor.value);
    atmosphereMaterial.uniforms.uRimIntensity.value = atmoUniforms.uRimIntensity.value;
    atmosphereMaterial.uniforms.uRimPower.value = atmoUniforms.uRimPower.value;
    atmosphereMaterial.uniforms.uDebugMode.value = atmoUniforms.uDebugMode.value;
    atmosphereMaterial.uniforms.uSunDirection.value.copy(atmoUniforms.uSunDirection.value);
    atmosphereMaterial.uniforms.uRimStart.value = atmoUniforms.uRimStart.value;
    atmosphereMaterial.uniforms.uRimEnd.value = atmoUniforms.uRimEnd.value;
    atmosphereMaterial.uniforms.uRimAltitudeBoost.value = atmoUniforms.uRimAltitudeBoost.value;
    atmosphereMaterial.uniforms.uHaloColor.value.copy(atmoUniforms.uHaloColor.value);
    atmosphereMaterial.uniforms.uHaloIntensity.value = atmoUniforms.uHaloIntensity.value;
    atmosphereMaterial.uniforms.uHaloThickness.value = atmoUniforms.uHaloThickness.value;
    atmosphereMaterial.uniforms.uHaloSoftness.value = atmoUniforms.uHaloSoftness.value;

    if (earthMaterial && earthMaterial.uniforms) {
      earthMaterial.uniforms.uAtmosphereDayColor.value.copy(atmoUniforms.uAtmosphereDayColor.value);
      earthMaterial.uniforms.uTwilightColor.value.copy(atmoUniforms.uTwilightColor.value);
      earthMaterial.uniforms.uAtmosphereIntensity.value = atmoUniforms.uAtmosphereIntensity.value;
      earthMaterial.uniforms.uSunDirection.value.copy(atmoUniforms.uSunDirection.value);
    }
  }

  function updateOrbit(delta) {
    if (!cameraOrbit.enabled) return;
    cameraOrbit.azimuth += cameraOrbit.autoRotateSpeed * delta;
    const r = cameraOrbit.distance; const inc = cameraOrbit.inclination; const az = cameraOrbit.azimuth;
    const x = r * Math.cos(inc) * Math.cos(az); const y = r * Math.sin(inc); const z = r * Math.cos(inc) * Math.sin(az);
    camera.position.set(cameraOrbit.target.x + x, cameraOrbit.target.y + y, cameraOrbit.target.z + z);
    updateGuiCameraRefFromCamera(); // keep cameraRef in sync (no UI)
  }

  function applyCameraOrientation() {
    _tmpObj.position.copy(camera.position); _tmpObj.lookAt(cameraOrbit.target);
    const lookAtQuatCurrent = _tmpObj.quaternion.clone();
    const deltaX = mouseLook.rotationX - mouseLook.baseRotationX;
    const deltaY = mouseLook.rotationY - mouseLook.baseRotationY;
    const deltaZ = mouseLook.rotationZ - mouseLook.baseRotationZ;
    const offsetEuler = new THREE.Euler(deltaX, deltaY, deltaZ, "XYZ");
    const mouseOffsetQuat = new THREE.Quaternion().setFromEuler(offsetEuler);
    camera.quaternion.copy(lookAtQuatCurrent).multiply(baseOffsetQuat).multiply(mouseOffsetQuat);
  }

  function tick() {
    const delta = clock.getDelta();
    const t = clock.getElapsedTime();
    if (earth) earth.rotation.y = t * 0.05;
    if (clouds) clouds.rotation.y = t * 0.03;
    syncUniformsPerFrame();
    updateMouseLookRotation();
    updateOrbit(delta);
    applyCameraOrientation();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  // apply initial atmosphere settings once
  applyAtmosphereSettings();
  tick();

  // Done: LoadingManager will call onLoad and then startExperience() after 3s
}

// Debug sun (kept as a visible mesh in scene for dev if you want to toggle it via code later)
const debugSun = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
// don't add to scene until init (initThreeJS will add it)
if (typeof scene !== "undefined" && scene) scene.add(debugSun);

// Export or attach init if you use module bundlers that expect it
export { initThreeJS };
