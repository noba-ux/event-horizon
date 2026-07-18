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
    for (int k = 0; k < 4; k++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
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

// Procedural plasma. Domain-warped noise breaks the ring into wispy, uneven
// filaments (never a clean circle); wide feathering softens the edges; the
// palette is cold (blue-white with only a little gold, no orange flood). The
// event-horizon black itself is stamped later in LensPass, so the interior is
// guaranteed pure black.
const DISK_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uBias;
  uniform float uSeed;
  ${NOISE}

  void main(){
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float ang = atan(p.y, p.x);

    // Wide, feathered radial band — no hard inner/outer edges.
    float inner = smoothstep(0.14, 0.40, r);
    float outer = 1.0 - smoothstep(0.5, 1.05, r);
    float radial = inner * outer;
    if (radial <= 0.001) discard;

    // Domain-warped turbulence → wispy, uneven filaments.
    vec2 sw = vec2(ang * 2.0 + r * 3.5, r * 5.0 - uTime * 0.22 + uSeed * 10.0);
    float warp = fbm(sw * 0.7 + uTime * 0.03);
    float n = fbm(sw + warp * 1.6);
    // Break the ring: threshold the noise so the glow cuts into patches.
    float patches = smoothstep(0.34, 0.76, n);
    float filaments = pow(0.2 + 0.9 * n, 1.8) * (0.35 + 0.75 * patches);

    float dop = 0.5 + 0.5 * cos(ang - uBias);
    float bright = radial * filaments * (0.12 + 0.9 * dop * dop);

    // Cool palette: deep blue-grey → a little gold → blue-white.
    vec3 cold = vec3(0.05, 0.08, 0.14);
    vec3 gold = vec3(0.85, 0.72, 0.42);
    vec3 blueWhite = vec3(0.78, 0.88, 1.0);
    vec3 col = mix(cold, gold, smoothstep(0.25, 0.72, dop) * 0.6);
    col = mix(col, blueWhite, smoothstep(0.72, 1.0, dop));

    float alpha = clamp(bright, 0.0, 0.8);
    gl_FragColor = vec4(col * bright, alpha);
    #include <colorspace_fragment>
  }
`

// A very faint, noisy dust/lensing haze that binds the hole to the background.
const HAZE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  ${NOISE}

  void main(){
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float radial = smoothstep(0.1, 0.32, r) * (1.0 - smoothstep(0.4, 1.0, r));
    if (radial <= 0.001) discard;
    vec2 sw = vec2(atan(p.y, p.x) * 1.5 + r * 3.0, r * 4.0 - uTime * 0.05);
    float n = fbm(sw + uTime * 0.02);
    float a = radial * (0.25 + 0.75 * n) * 0.14; // very faint
    vec3 col = vec3(0.55, 0.7, 0.95); // cool blue-white
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

  const uniformsA = useMemo(
    () => ({ uTime: { value: 0 }, uBias: { value: 0.6 }, uSeed: { value: 0.0 } }),
    [],
  )
  const uniformsB = useMemo(
    () => ({ uTime: { value: 0 }, uBias: { value: 0.95 }, uSeed: { value: 4.0 } }),
    [],
  )
  const uniformsHaze = useMemo(() => ({ uTime: { value: 0 } }), [])

  useFrame((state) => {
    // Sim time freezes while the music is paused → the plasma freezes too.
    const t = telemetry.current.simTime
    if (matARef.current) matARef.current.uniforms.uTime.value = t
    if (matBRef.current) matBRef.current.uniforms.uTime.value = t * 0.8
    if (hazeMatRef.current) hazeMatRef.current.uniforms.uTime.value = t
    // The haze faces the camera so it reads as a soft halo, not a flat card.
    hazeRef.current?.lookAt(state.camera.position)
  })

  return (
    <group>
      {/* Faint dust/lensing haze bridging the hole to the surrounding space. */}
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

      {/* Tilted plasma disks — irregular, feathered, cool. */}
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
