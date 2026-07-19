import { useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useFBO } from '@react-three/drei'
import * as THREE from 'three'
import type { Telemetry } from '../telemetry'

// Fullscreen triangle/quad: PlaneGeometry(2,2) positions are already in clip
// space, so we pass them straight through.
const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Screen-space gravitational lensing (physics-inspired, not a real solver).
// The old version used a 1/d² pull hard-clamped to a ceiling, which produced a
// flat plateau (a disc where every pixel got the same offset) and an abrupt
// derivative break at its edge — the "포토샵 필터" faceting/stair-stepping.
// This version drives everything from ONE smooth exponential envelope so the
// bending is continuous everywhere: no spike at the centre, no clamp plateau.
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform vec2 uCenter;
  uniform float uStrength;   // peak radial contraction fraction near the ring
  uniform float uFalloff;    // how tightly the well decays with distance
  uniform float uAspect;
  uniform float uTime;
  uniform float uEdge;
  uniform float uHoleRadius;
  uniform float uMaskOn;
  uniform float uHoleFade;   // 1 = solid horizon, 0 = dissolved (final pass-through)
  uniform float uSwirl;      // peak swirl rotation (radians) near the ring
  uniform float uRingStrength; // brightness of the Einstein ring halo
  varying vec2 vUv;

  // Compact value-noise fBm to break the Einstein ring into gaseous wisps.
  float lhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lnoise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(lhash(i), lhash(i + vec2(1.0, 0.0)), u.x),
               mix(lhash(i + vec2(0.0, 1.0)), lhash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float lfbm(vec2 p){
    float v = 0.0; float a = 0.5;
    for (int k = 0; k < 4; k++) { v += a * lnoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 delta = uv - uCenter;
    delta.x *= uAspect;            // aspect-correct so the well is round
    float d = length(delta);
    float ang = atan(delta.y, delta.x);

    // Smooth gravitational well: a Gaussian-like exponential decay instead of
    // 1/d². It is C-infinity smooth — soft and curved everywhere, peaks gently
    // at the centre, and needs no clamp (so no plateau, no faceting).
    float falloff = exp(-d * d * uFalloff);
    // Fade the effect to zero *inside* the horizon (so we never sample the black
    // interior) and ramp it in just outside → a soft, curved Einstein-ring band.
    float ring = smoothstep(uHoleRadius * 0.6, uHoleRadius * 2.4 + 0.05, d);
    float amount = falloff * ring;

    // Swirl (tangential rotation) and radial contraction share the SAME smooth
    // envelope, so light spirals inward along one continuous curve rather than
    // two competing warps fighting each other into kinks.
    float swirl = uSwirl * amount;
    float pull = min(uStrength * amount, 0.9); // keep the sample from crossing centre
    float cs = cos(swirl), sn = sin(swirl);
    vec2 rotated = vec2(delta.x * cs - delta.y * sn, delta.x * sn + delta.y * cs);
    vec2 curved = rotated * (1.0 - pull);       // rotate, then step inward
    curved.x /= uAspect;                        // back to UV space
    vec2 distortedUv = uCenter + curved;

    // Edge instability: a soft, LOW-frequency ripple toward the frame edges.
    // Low frequency + tiny amplitude → shimmer without any visible faceting.
    float edge = smoothstep(0.34, 0.85, d);
    distortedUv += edge * uEdge * 0.0025 * vec2(
      sin(uv.y * 14.0 + uTime * 2.2),
      cos(uv.x * 14.0 + uTime * 1.8)
    );
    distortedUv = clamp(distortedUv, 0.0, 1.0); // never sample out of bounds

    gl_FragColor = texture2D(uScene, distortedUv);

    // --- Einstein ring: a torn halo of gravitationally lensed nebula gas that
    // winds around the horizon. Angular fBm shreds it into blueish wisps and a
    // Doppler beaming term makes it strongly asymmetric — one limb blazes, the
    // other nearly vanishes — so it reads as swirling gas, not a clean glow.
    float ringR = uHoleRadius * 1.06;
    float ringW = uHoleRadius * 0.16 + 0.012;        // gassy band, scales w/ hole
    float rd = (d - ringR) / ringW;
    float gas = lfbm(vec2(ang * 2.6 + uTime * 0.35, d * 9.0 - uTime * 0.15));
    float ering = exp(-rd * rd) * (0.25 + 1.25 * gas); // thin band, torn by noise
    float dop = 0.5 + 0.5 * cos(ang - uTime * 0.2 - 1.1); // asymmetric limb
    vec3 ringCol = mix(vec3(0.30, 0.52, 0.95), vec3(0.82, 0.92, 1.0), gas);
    gl_FragColor.rgb += ringCol * ering * uRingStrength * (0.25 + 1.5 * dop * dop) * uMaskOn;

    // Event horizon: a perfect, knife-edged black circle — but its opacity is
    // scaled by uHoleFade, which drops 1→0 over the final ~15s. As it fades the
    // black sphere melts into the surrounding dark (pass-through) instead of
    // growing to eat the frame, while the star field converges through it.
    float hole = smoothstep(uHoleRadius - 0.003, uHoleRadius, d);
    gl_FragColor.rgb *= mix(1.0, hole, uMaskOn * uHoleFade);

    #include <colorspace_fragment>
  }
`

interface LensPassProps {
  telemetry: React.RefObject<Telemetry>
}

/**
 * Renders the whole scene to an offscreen target, then draws it back through a
 * lens shader that warps the image around the black hole. Runs with useFrame
 * priority 1, which turns off R3F's auto-render — this pass owns the frame.
 * No postprocessing library involved; just an FBO + one ShaderMaterial.
 */
export function LensPass({ telemetry }: LensPassProps) {
  const { size } = useThree()
  const fbo = useFBO()

  const projected = useMemo(() => new THREE.Vector3(), [])
  const postScene = useMemo(() => new THREE.Scene(), [])
  const postCamera = useMemo(
    () => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    [],
  )
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uScene: { value: null as THREE.Texture | null },
          uCenter: { value: new THREE.Vector2(0.5, 0.5) },
          uStrength: { value: 0.15 },
          uFalloff: { value: 6.5 },
          uAspect: { value: 1 },
          uTime: { value: 0 },
          uEdge: { value: 0 },
          uHoleRadius: { value: 0.02 },
          uMaskOn: { value: 1 },
          uHoleFade: { value: 1 },
          uSwirl: { value: 0 },
          uRingStrength: { value: 0 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  )

  useMemo(() => {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    quad.frustumCulled = false
    postScene.add(quad)
  }, [postScene, material])

  useFrame((state) => {
    const { gl, scene, camera } = state
    const tel = telemetry.current
    const d = tel.distortionFactor
    // In the whitehole there is no black hole — the lens becomes a passthrough.
    const white = tel.phase === 'whitehole'

    // Project the black-hole centre (world origin) into screen UV.
    projected.set(0, 0, 0).project(camera)
    material.uniforms.uCenter.value.set(
      projected.x * 0.5 + 0.5,
      projected.y * 0.5 + 0.5,
    )
    material.uniforms.uAspect.value = size.width / Math.max(1, size.height)
    // Sync-lock relief: when the marker is locked, ease BOTH the radial pull and
    // the swirl by 35% (syncEase is already frame-smoothed, so this lerps in/out
    // gently — spacetime "stabilises" rather than snapping).
    const calm35 = 1 - tel.syncEase * 0.35
    const fi = tel.fallIntensity
    // Lensing intensifies as we approach and again during the absorb.
    material.uniforms.uStrength.value = white
      ? 0
      : (0.12 + d * 0.32 + tel.absorb * 0.9) * calm35
    // Sim time freezes while paused → the lens ripple freezes, but we still
    // render every frame so the screen shows the frozen scene (never blank).
    material.uniforms.uTime.value = tel.simTime
    material.uniforms.uEdge.value = white ? 0 : d
    material.uniforms.uMaskOn.value = white ? 0 : 1
    // Horizon dissolve (1→0 over the final ~15s): fades the black sphere out and
    // takes the ring with it. Absorb no longer swells the hole — it drives the
    // background swirl so the last starlight whirls violently into the centre.
    const fade = white ? 0 : tel.horizonFade
    // Spiral swirl grows with distortion/fall (+ a violent final absorb whirl),
    // eased when the marker is synced.
    material.uniforms.uSwirl.value = white
      ? 0
      : (d * 0.55 + fi * 0.7 + tel.absorb * 1.6) * calm35
    // Event-horizon screen radius: grows as we approach and with the fall. It no
    // longer swells with absorb — the sphere is dissolved via uHoleFade instead.
    const dist = tel.distanceToBlackHole || 320
    const distHole = THREE.MathUtils.clamp((6.5 / dist) * (1 + fi * fi * 4.0), 0.02, 0.6)
    material.uniforms.uHoleRadius.value = white ? 0 : distHole
    material.uniforms.uHoleFade.value = fade
    // Einstein ring: blazes brighter as we approach and the fall deepens, eased
    // by a sync lock, and dissolves together with the horizon at the very end.
    material.uniforms.uRingStrength.value = white
      ? 0
      : (0.55 + d * 1.1 + fi * 0.7) * calm35 * fade
    material.uniforms.uScene.value = fbo.texture

    // 1) render the real scene to the FBO, 2) draw it through the lens.
    gl.setRenderTarget(fbo)
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(postScene, postCamera)
  }, 1)

  return null
}
