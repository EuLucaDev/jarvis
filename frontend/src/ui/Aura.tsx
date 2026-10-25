// Esfera do Jarvis: o shader "Aura" dos componentes de agente da LiveKit (licença MIT, © 2025 LiveKit, Inc.),
// com um renderizador WebGL próprio e enxuto no lugar do react-shader-toy. Reage à fase (espera, ouvindo,
// pensando, falando) e ao volume da voz, lidos do voiceStore a cada quadro, sem re-renderizar o React.

import { useEffect, useRef } from 'react'
import { voiceStore, type Phase } from '../lib/live'

const FRAG = `
precision highp float;
uniform vec2 iResolution;
uniform float iTime, uSpeed, uBlur, uScale, uFrequency, uAmplitude, uMix, uSpacing, uColorShift, uVariance, uSmoothing;
uniform vec3 uColor;
const float TAU = 6.283185;
vec2 randFibo(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.xx + p.yx) * p.xy); }
vec3 Tonemap(vec3 x) { x *= 4.0; return x / (1.0 + x); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) { vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
vec2 turb(vec2 pos, float t, float it) {
  mat2 rotation = mat2(0.6, -0.25, 0.25, 0.9);
  mat2 layerRotation = mat2(0.6, -0.8, 0.8, 0.6);
  float frequency = mix(2.0, 15.0, uFrequency);
  float amplitude = uAmplitude;
  float animTime = t * 0.1 * uSpeed;
  for (int i = 0; i < 4; i++) {
    vec2 wave = sin(frequency * (pos * rotation) + float(i) * animTime + it);
    pos += (amplitude / frequency) * rotation[0] * wave;
    rotation *= layerRotation;
    amplitude *= mix(1.0, max(wave.x, wave.y), uVariance);
    frequency *= 1.4;
  }
  return pos;
}
const float ITERATIONS = 36.0;
void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / iResolution.xy;
  vec3 pp = vec3(0.0); vec3 bloom = vec3(0.0);
  float t = iTime * 0.5;
  vec2 pos = uv - 0.5;
  vec2 prevPos = turb(pos, t, 0.0 - 1.0 / ITERATIONS);
  float spacing = mix(1.0, TAU, uSpacing);
  for (float i = 1.0; i < ITERATIONS + 1.0; i++) {
    float iter = i / ITERATIONS;
    vec2 st = turb(pos, t, iter * spacing);
    float d = abs(length(st) - uScale);
    float pd = distance(st, prevPos);
    prevPos = st;
    float dynamicBlur = exp2(pd * 2.0 * 1.4426950408889634) - 1.0;
    float ds = smoothstep(0.0, uBlur * 0.05 + max(dynamicBlur * uSmoothing, 0.001), d);
    vec3 color = uColor;
    if (uColorShift > 0.01) { vec3 hsv = rgb2hsv(color); hsv.x = fract(hsv.x + (1.0 - iter) * uColorShift * 0.3); color = hsv2rgb(hsv); }
    float invd = 1.0 / max(d + dynamicBlur, 0.001);
    pp += (ds - 1.0) * color;
    bloom += clamp(invd, 0.0, 250.0) * color;
  }
  pp *= 1.0 / ITERATIONS;
  bloom = bloom / (bloom + 2e4);
  vec3 color = (-pp + bloom * 3.0 * 0.0) * 1.2;
  color += (randFibo(fragCoord).x - 0.5) / 255.0;
  color = Tonemap(color);
  gl_FragColor = vec4(color * uMix, luma(color) * uMix);
}`

const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'

// alvo de cada fase (velocidade, escala, amplitude, frequência, brilho mínimo e máximo do pulso), como na LiveKit
const LOOK: Record<Phase, { speed: number; scale: number; amp: number; freq: number; b0: number; b1: number }> = {
  espera: { speed: 10, scale: 0.24, amp: 1.2, freq: 0.4, b0: 1.35, b1: 1.35 },
  ouvindo: { speed: 20, scale: 0.3, amp: 1.0, freq: 0.7, b0: 1.5, b1: 2.0 },
  pensando: { speed: 30, scale: 0.3, amp: 0.5, freq: 1.0, b0: 0.5, b1: 2.5 },
  falando: { speed: 70, scale: 0.3, amp: 0.75, freq: 1.25, b0: 1.5, b1: 1.5 },
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)

/** gain: brilho extra (a esfera pequena da camada precisa de mais para aparecer sobre qualquer fundo). */
export function Aura({ color = '#1FD5F9', className, maxRes = 720, gain = 1 }: { color?: string; className?: string; maxRes?: number; gain?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current!
    const gl = cv.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: false })
    if (!gl) return
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s))
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    const U = Object.fromEntries(
      ['iResolution', 'iTime', 'uSpeed', 'uBlur', 'uScale', 'uFrequency', 'uAmplitude', 'uMix', 'uSpacing', 'uColorShift', 'uVariance', 'uSmoothing', 'uColor'].map((n) => [n, u(n)]),
    )
    gl.uniform1f(U.uBlur, 1.0)
    gl.uniform1f(U.uSpacing, 0.5)
    gl.uniform1f(U.uColorShift, 0.05)
    gl.uniform1f(U.uVariance, 0.1)
    gl.uniform1f(U.uSmoothing, 1.0)
    gl.uniform3fv(U.uColor, hex(color))

    const cur = { ...LOOK.espera, mix: 1 }
    let tempo = 0
    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // resolução limitada: o shader é pesado, e a esfera não precisa de mais que isso
      const w = cv.clientWidth
      const scale = Math.min(window.devicePixelRatio || 1, maxRes / Math.max(1, w))
      const px = Math.round(w * scale)
      if (cv.width !== px) {
        cv.width = cv.height = px
        gl.viewport(0, 0, px, px)
      }
      const { fase, nivel } = voiceStore.get()
      const alvo = LOOK[fase]
      const k = Math.min(1, dt * 4) // ~0,5 s para trocar de fase, como a transição da LiveKit
      cur.speed += (alvo.speed - cur.speed) * k
      cur.amp += (alvo.amp - cur.amp) * k
      cur.freq += (alvo.freq - cur.freq) * k
      const escala = fase === 'falando' ? 0.2 + 0.2 * Math.min(1, nivel) : alvo.scale
      cur.scale += (escala - cur.scale) * (fase === 'falando' ? 0.5 : k)
      const pulso = alvo.b0 === alvo.b1 ? alvo.b0 : alvo.b0 + (alvo.b1 - alvo.b0) * (0.5 + 0.5 * Math.sin(now / 350))
      cur.mix += (pulso - cur.mix) * k
      tempo += dt
      gl.uniform2f(U.iResolution, px, px)
      gl.uniform1f(U.iTime, tempo)
      gl.uniform1f(U.uSpeed, cur.speed)
      gl.uniform1f(U.uScale, cur.scale)
      gl.uniform1f(U.uAmplitude, cur.amp)
      gl.uniform1f(U.uFrequency, cur.freq)
      gl.uniform1f(U.uMix, cur.mix * gain)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [color, maxRes, gain])

  return <canvas ref={ref} className={`aura ${className ?? ''}`} aria-hidden="true" />
}
