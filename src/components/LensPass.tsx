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
// We bend the sampled UV toward the black-hole centre, with an epsilon + clamp
// so the distortion never blows up near the middle.
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform vec2 uCenter;
  uniform float uStrength;
  uniform float uMaxLens;
  uniform float uAspect;
  uniform float uTime;
  uniform float uEdge;
  uniform float uHoleRadius;
  uniform float uMaskOn;
  uniform float uSwirl;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    vec2 delta = uv - uCenter;
    delta.x *= uAspect;            // aspect-correct so the well is round
    float d = length(delta);
    float ang = atan(delta.y, delta.x);
    float safeD = max(d, 0.03);    // epsilon: avoid a singularity at centre
    float lens = uStrength / (safeD * safeD);
    lens = clamp(lens, 0.0, uMaxLens);
    vec2 dir = delta / max(d, 1e-4);
    dir.x /= uAspect;              // back to UV space

    // Angular swirl: rotate the sampling offset more as we near the centre, so
    // the warp spirals inward rather than just magnifying radially.
    float swirlAmt = clamp(uSwirl / (safeD + 0.12), 0.0, 1.4);
    float sc = cos(swirlAmt), ss = sin(swirlAmt);
    vec2 rot = vec2(delta.x * sc - delta.y * ss, delta.x * ss + delta.y * sc);
    rot.x /= uAspect;             // back to UV space
    vec2 distortedUv = uCenter + rot - dir * lens; // swirl, then pull inward

    // Edge instability: a faint ripple that grows toward the frame edges and
    // with distortion, so the periphery feels like it's coming apart.
    float edge = smoothstep(0.32, 0.72, d);
    distortedUv += edge * uEdge * 0.004 * vec2(
      sin(uv.y * 42.0 + uTime * 3.0),
      cos(uv.x * 42.0 + uTime * 2.3)
    );
    distortedUv = clamp(distortedUv, 0.0, 1.0); // never sample out of bounds

    gl_FragColor = texture2D(uScene, distortedUv);

    // Event horizon (TOP PRIORITY): interior is pure black, no exceptions.
    // The rim is angularly wobbled so it never reads as a perfect circle.
    float rs = uHoleRadius * (1.0
      + 0.05 * sin(ang * 7.0 + uTime * 0.7)
      + 0.03 * sin(ang * 13.0 - uTime * 0.4));
    float hole = smoothstep(rs * 0.9, rs, d);
    gl_FragColor.rgb *= mix(1.0, hole, uMaskOn);

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
          uStrength: { value: 0.0012 },
          uMaxLens: { value: 0.16 },
          uAspect: { value: 1 },
          uTime: { value: 0 },
          uEdge: { value: 0 },
          uHoleRadius: { value: 0.02 },
          uMaskOn: { value: 1 },
          uSwirl: { value: 0 },
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
    // Lensing intensifies as we approach and again during the absorb.
    material.uniforms.uStrength.value = white ? 0 : 0.0011 + d * 0.0032 + tel.absorb * 0.012
    // Sim time freezes while paused → the lens ripple freezes, but we still
    // render every frame so the screen shows the frozen scene (never blank).
    material.uniforms.uTime.value = tel.simTime
    material.uniforms.uEdge.value = white ? 0 : d
    material.uniforms.uMaskOn.value = white ? 0 : 1
    // Spiral swirl grows with distortion/fall, eased when the marker is synced.
    const calm = 1 - tel.syncEase * 0.4
    material.uniforms.uSwirl.value = white ? 0 : (d * 0.4 + tel.fallIntensity * 0.5) * calm
    // Event-horizon screen radius grows with approach and swells to swallow the
    // whole frame during the singularity absorb.
    const dist = tel.distanceToBlackHole || 320
    const distHole = THREE.MathUtils.clamp(6.0 / dist, 0.02, 0.4)
    material.uniforms.uHoleRadius.value = white
      ? 0
      : Math.max(distHole, tel.absorb * 1.7)
    material.uniforms.uScene.value = fbo.texture

    // 1) render the real scene to the FBO, 2) draw it through the lens.
    gl.setRenderTarget(fbo)
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(postScene, postCamera)
  }, 1)

  return null
}
