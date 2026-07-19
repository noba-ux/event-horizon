import { useMemo } from 'react'
import * as THREE from 'three'

// Purely decorative deep-space backdrop: a large inward-facing sphere painted
// with a soft, very dark indigo/navy/muted-purple fBm nebula so the empty void
// reads with depth instead of flat pure black. It is static (no per-frame work,
// no telemetry) and sits behind everything — it changes appearance only through
// the camera's own parallax as it drifts. Nothing here touches scene logic.
const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position); // object-space direction → world-fixed pattern
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0; float a = 0.5;
    for (int k = 0; k < 5; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main(){
    vec3 d = normalize(vDir);
    // Longitude/latitude mapping → even, low-frequency (soft/blurred) patches.
    vec2 uv = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0)));
    float warp = fbm(uv * 0.9 - 1.0);
    float n = fbm(uv * 1.6 + 3.0);
    float n2 = fbm(uv * 2.7 + warp * 1.5);

    // Only the densest patches glow, and even then only faintly — the rest of
    // the sky stays pure black so the void keeps its depth. This is ADDITIVE, so
    // it only tints where wisps exist; it never lifts the whole frame.
    float neb = smoothstep(0.55, 0.95, n) * (0.4 + 0.6 * n2);
    vec3 indigo = vec3(0.10, 0.12, 0.28);
    vec3 purple = vec3(0.20, 0.11, 0.28);
    vec3 col = mix(indigo, purple, smoothstep(0.4, 0.9, n2));

    gl_FragColor = vec4(col * neb * 0.09, 1.0); // 0.09 = whisper-faint strength
    #include <colorspace_fragment>
  }
`

export function NebulaBackdrop() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        transparent: true,
        blending: THREE.AdditiveBlending, // adds faint wisps; never fills to grey
        fog: false,
      }),
    [],
  )

  return (
    <mesh material={material} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[800, 48, 32]} />
    </mesh>
  )
}
