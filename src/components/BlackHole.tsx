import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Telemetry } from '../telemetry'

const CORE_RADIUS = 7.2

const NOISE = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0; float a = 0.5;
    for (int k = 0; k < 5; k++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
    return v;
  }
`

const DISK_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Organic accretion nebula. The sampling frame is SWIRLED toward the centre
// (inner gas winds faster than outer), and heavily domain-warped fBm is read in
// that swirled polar frame — so the gas spirals inward and "tears like jelly"
// as it wraps the hole. A sharp-ish inner cut keeps the horizon cold and empty;
// relativistic beaming makes the ring asymmetric. Palette is cold and gaseous
// (indigo → steel blue → pale), with only a whisper of warmth on the bright limb.
const DISK_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uBias;    // doppler axis (which limb blazes)
  uniform float uSeed;
  uniform float uFall;    // 0→1 fall intensity: spins/tears harder late
  uniform float uThicken; // 0→1: thickens into dense engulfing fog on the plunge
  ${NOISE}

  void main(){
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float ang = atan(p.y, p.x);

    // Swirl the frame toward the centre → filaments spiral in and shear apart.
    float swirl = (1.5 + uFall * 3.2) / (r + 0.18) + uTime * 0.22;
    float sa = ang + swirl;

    // Domain-warped fBm in the swirled polar frame → torn, stringy gas.
    vec2 q = vec2(sa * 1.25, r * 3.0 - uTime * 0.14 + uSeed * 7.0);
    float warp = fbm(q * 0.8 + uTime * 0.04);
    float n = fbm(q + warp * (1.7 + uFall * 1.2));
    float n2 = fbm(q * 2.3 - warp * 1.1);
    float gas = pow(0.12 + 0.92 * n, 1.7) * (0.35 + 0.75 * n2);

    // Radial envelope: cut just outside the horizon, long feather outward.
    float inner = smoothstep(0.15, 0.33, r);
    float outer = 1.0 - smoothstep(0.55, 1.08, r);
    float band = inner * outer;
    float bright = band * gas;
    if (band <= 0.002) discard;

    // Relativistic beaming: one limb blazes, the opposite dims to near nothing.
    float dop = 0.5 + 0.5 * cos(ang - uBias);
    bright *= 0.22 + 1.5 * dop * dop;

    // Thicken into engulfing fog on the final plunge: raise the gain AND add a
    // solid base fill across the band, so the cloud becomes dense enough that
    // the infalling stars sink into it and vanish — no alpha trickery needed.
    bright = bright * (1.0 + uThicken * 2.4) + band * uThicken * 0.55;

    // Cold, gaseous palette with a faint warm kiss on the bright limb.
    vec3 deep = vec3(0.03, 0.06, 0.14);
    vec3 blue = vec3(0.26, 0.48, 0.85);
    vec3 pale = vec3(0.74, 0.86, 1.0);
    vec3 warm = vec3(0.95, 0.82, 0.6);
    vec3 col = mix(deep, blue, smoothstep(0.05, 0.5, gas));
    col = mix(col, pale, smoothstep(0.55, 1.05, gas));
    col = mix(col, warm, dop * dop * 0.22);
    col = mix(col, pale, uThicken * 0.5); // fog brightens to a pale blue-white

    float alpha = clamp(bright, 0.0, 0.95);
    gl_FragColor = vec4(col * bright * 1.35, alpha);
    #include <colorspace_fragment>
  }
`

// A broad, faint torn nebula haze that binds the hole to the surrounding void.
// Same swirl+warp treatment as the disk, but wider, slower and much dimmer.
const HAZE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFall;
  uniform float uThicken;
  ${NOISE}

  void main(){
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float ang = atan(p.y, p.x);
    float radial = smoothstep(0.08, 0.3, r) * (1.0 - smoothstep(0.42, 1.0, r));
    if (radial <= 0.001) discard;

    float swirl = (1.0 + uFall * 2.2) / (r + 0.25) + uTime * 0.06;
    vec2 q = vec2((ang + swirl) * 1.1, r * 2.4 - uTime * 0.05);
    float warp = fbm(q * 0.7 + uTime * 0.02);
    float n = fbm(q + warp * 1.5);
    // Faint early, but thickens dramatically on the plunge → a dense volumetric
    // fog the whole field is swallowed into.
    float a = radial * (0.18 + 0.82 * n) * (0.16 + uThicken * 0.95);
    vec3 col = mix(vec3(0.10, 0.16, 0.34), vec3(0.5, 0.66, 0.95), n);
    gl_FragColor = vec4(col * a, a);
    #include <colorspace_fragment>
  }
`

interface BlackHoleProps {
  telemetry: React.RefObject<Telemetry>
}

export function BlackHole({ telemetry }: BlackHoleProps) {
  const matARef = useRef<THREE.ShaderMaterial>(null)
  const matBRef = useRef<THREE.ShaderMaterial>(null)
  const hazeMatRef = useRef<THREE.ShaderMaterial>(null)
  const hazeRef = useRef<THREE.Group>(null)
  const rootRef = useRef<THREE.Group>(null)

  const uniformsA = useMemo(
    () => ({ uTime: { value: 0 }, uBias: { value: 0.6 }, uSeed: { value: 0.0 }, uFall: { value: 0 }, uThicken: { value: 0 } }),
    [],
  )
  const uniformsB = useMemo(
    () => ({ uTime: { value: 0 }, uBias: { value: 0.95 }, uSeed: { value: 4.0 }, uFall: { value: 0 }, uThicken: { value: 0 } }),
    [],
  )
  const uniformsHaze = useMemo(() => ({ uTime: { value: 0 }, uFall: { value: 0 }, uThicken: { value: 0 } }), [])

  useFrame((state) => {
    // Sim time freezes while the music is paused → the plasma freezes too.
    const tel = telemetry.current
    const t = tel.simTime
    const fi = tel.fallIntensity
    // Grow/thicken ramp over the back half of the fall (60s → end), squared so
    // it accelerates late; the final ~15s (endRush) pushes it over the top.
    const grow = THREE.MathUtils.clamp((tel.fallProgress - 0.5) / 0.5, 0, 1)
    const endRush = 1 - tel.horizonFade
    const thicken = Math.min(grow * grow + endRush * endRush, 1)
    if (matARef.current) {
      matARef.current.uniforms.uTime.value = t
      matARef.current.uniforms.uFall.value = fi
      matARef.current.uniforms.uThicken.value = thicken
    }
    if (matBRef.current) {
      matBRef.current.uniforms.uTime.value = t * 0.8
      matBRef.current.uniforms.uFall.value = fi
      matBRef.current.uniforms.uThicken.value = thicken
    }
    if (hazeMatRef.current) {
      hazeMatRef.current.uniforms.uTime.value = t
      hazeMatRef.current.uniforms.uFall.value = fi
      hazeMatRef.current.uniforms.uThicken.value = thicken
    }
    // The haze faces the camera so it reads as a soft halo, not a flat card.
    hazeRef.current?.lookAt(state.camera.position)
    // Explosive proximity swell: the cloud scales up to overwhelm the frame as
    // we plunge in — the player flies INTO a giant swirling nebula rather than
    // watching a small disc. Grows through the back half, then blows up in the
    // final convergence (endRush) so it fully engulfs the view.
    const s = 1 + grow * grow * 7 + endRush * endRush * 11
    rootRef.current?.scale.setScalar(s)
  })

  return (
    <group ref={rootRef}>
      {/* Broad, faint torn-nebula haze bridging the hole to the void. */}
      <group ref={hazeRef}>
        <mesh>
          <planeGeometry args={[CORE_RADIUS * 20, CORE_RADIUS * 20]} />
          <shaderMaterial
            ref={hazeMatRef}
            vertexShader={DISK_VERT}
            fragmentShader={HAZE_FRAG}
            uniforms={uniformsHaze}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>

      {/* Tilted accretion nebula — swirling, torn, cold gas. */}
      <group rotation={[1.15, -0.12, -0.3]}>
        <mesh rotation={[0, 0, 0.4]}>
          <planeGeometry args={[CORE_RADIUS * 14, CORE_RADIUS * 14]} />
          <shaderMaterial
            ref={matBRef}
            vertexShader={DISK_VERT}
            fragmentShader={DISK_FRAG}
            uniforms={uniformsB}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh>
          <planeGeometry args={[CORE_RADIUS * 9, CORE_RADIUS * 9]} />
          <shaderMaterial
            ref={matARef}
            vertexShader={DISK_VERT}
            fragmentShader={DISK_FRAG}
            uniforms={uniformsA}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  )
}
