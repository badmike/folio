import { DEFAULT_BLUR_SIZE, adaptColor, isDarkColor } from '@folio/document'
import type { ArrowObject, CanvasObject, ImageObject, InkStroke, ShapeObject, TextObject, Vec2 } from '@folio/document'
import { arrowPath } from './arrows'
import { CORNELL_CUE, CORNELL_SUMMARY, DESK_COLOR, DESK_COLOR_DARK, DOT_RADIUS_PX, FADE_FULL_PX, FADE_MIN_PX, MINOR_WEIGHT, POLAR_STEP, backgroundLevels, frameColor, pageRect, patternColor, patternKind } from './background'
import { noteTailPoint, worldCorners } from './bounds'
import { counterLabel, noteBox, noteOutline, noteTail } from './callouts'
import { pathMidpoint } from './canvas2d'
import { FRAME_LABEL_SIZE } from './hit'
import { parseColor, premultiplied } from './color'
import type { Camera, Renderer, Scene, Size, VisualTheme } from './contract'
import { buildArrowMesh, buildInkMesh, buildInkStencilMesh, buildShapeMesh, addPolygon, addPolyline, MeshBuilder, VERTEX_FLOATS, type StencilFill } from './geometry/mesh'
import { ImageCache, type ImageResolver, type ImageSource } from './images'
import { IDENTITY, multiply, toMat3, transformMatrix, type Mat } from './math'
import { buildOverlay } from './overlay'
import { arrowKey, isRenderable, objectKey } from './scenekey'
import { ARROW_LABEL_WIDTH, labelLayout, layoutText, type TextLayout } from './text'
import { drawTextLayout, type Ctx2D } from './textdraw'

type GL = WebGLRenderingContext | WebGL2RenderingContext

// ---------------------------------------------------------------------------
// Shaders (written in GLSL ES 1.00 style; adapted to 3.00 es for WebGL2)
// ---------------------------------------------------------------------------

const VERT_MESH = `
attribute vec2 a_pos;
attribute vec4 a_color;
uniform mat3 u_model;
uniform vec4 u_cam;   // xy = world position of viewport top-left, z = zoom
uniform vec2 u_view;  // viewport size in CSS px
varying vec4 v_color;
void main() {
  vec2 w = (u_model * vec3(a_pos, 1.0)).xy;
  vec2 s = (w - u_cam.xy) * u_cam.z;
  vec2 c = s / u_view * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_color = a_color;
}`

const FRAG_MESH = `
varying vec4 v_color;
void main() { FRAG_OUT = v_color; }`

const VERT_QUAD = `
attribute vec2 a_pos;
uniform mat3 u_model;
uniform vec4 u_cam;
uniform vec2 u_view;
varying vec2 v_uv;
void main() {
  vec2 w = (u_model * vec3(a_pos, 1.0)).xy;
  vec2 s = (w - u_cam.xy) * u_cam.z;
  vec2 c = s / u_view * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_uv = a_pos;
}`

const FRAG_QUAD = `
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_tint;      // premultiplied colour used when u_useTex == 0
uniform float u_useTex;
uniform float u_alpha;    // extra opacity for textured quads
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  FRAG_OUT = u_useTex > 0.5 ? t * u_alpha : u_tint;
}`

/** Draws a copy of the frame buffer region back with block-quantised texture coordinates. */
const FRAG_PIXELATE = `
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_blocks;   // number of blocks across / down the quad
uniform float u_alpha;
void main() {
  vec2 q = (floor(v_uv * u_blocks) + 0.5) / u_blocks;
  vec4 t = texture2D(u_tex, vec2(q.x, 1.0 - q.y));
  FRAG_OUT = vec4(t.rgb, 1.0) * u_alpha;
}`

/** Separable Gaussian: 9 taps along u_dir (texel step already scaled by the radius). */
const FRAG_BLUR = `
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_alpha;
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec3 c = texture2D(u_tex, uv).rgb * 0.2270;
  c += (texture2D(u_tex, uv + u_dir * 1.0).rgb + texture2D(u_tex, uv - u_dir * 1.0).rgb) * 0.1946;
  c += (texture2D(u_tex, uv + u_dir * 2.0).rgb + texture2D(u_tex, uv - u_dir * 2.0).rgb) * 0.1216;
  c += (texture2D(u_tex, uv + u_dir * 3.0).rgb + texture2D(u_tex, uv - u_dir * 3.0).rgb) * 0.0541;
  c += (texture2D(u_tex, uv + u_dir * 4.0).rgb + texture2D(u_tex, uv - u_dir * 4.0).rgb) * 0.0162;
  FRAG_OUT = vec4(c, 1.0) * u_alpha;
}`

const VERT_BG = `
attribute vec2 a_pos;
uniform vec2 u_view;
varying vec2 v_px;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  vec2 uv = a_pos * 0.5 + 0.5;
  v_px = vec2(uv.x, 1.0 - uv.y) * u_view;
}`

// Keep pattern math in sync with patternCoverageLevels() in background.ts.
const FRAG_BG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#endif
varying vec2 v_px;
uniform vec4 u_cam;
uniform vec3 u_pageColor;
uniform vec3 u_lineColor;
uniform vec3 u_desk;
uniform vec4 u_pat;   // kind, opacity, majorEvery, minorWeight
uniform vec4 u_lv;    // spacing0, alpha0, spacing1, alpha1 (pattern levels, coarse first)
uniform vec4 u_page;  // x, y, w, h (world)
uniform float u_hasPage;

float cov(float d) { return clamp(1.0 - d, 0.0, 1.0); }

float sdBox(vec2 p, vec2 c, vec2 hs) {
  vec2 q = abs(p - c) - hs;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float levelCov(vec2 w, float s, float a) {
  if (s <= 0.0 || a <= 0.0) return 0.0;
  float z = u_cam.z;
  float c = 0.0;
  float k = u_pat.x;
  if (k > 11.5) {
    vec2 ctr = u_hasPage > 0.5 ? u_page.xy + u_page.zw * 0.5 : vec2(0.0);
    vec2 dv = w - ctr;
    float r = length(dv);
    float rm = mod(r, s);
    c = cov(min(rm, s - rm) * z);
    if (r >= s) {
      float am = mod(atan(dv.y, dv.x), ${POLAR_STEP});
      c = max(c, cov(r * abs(sin(min(am, ${POLAR_STEP} - am))) * z));
    }
  } else if (k > 9.5) {
    float h = s * 0.8660254;
    if (k > 10.5) {
      float g = s * 0.2;
      float period = s * 2.5;
      float m = mod(w.y, period);
      float i = clamp(floor(m / g + 0.5), 0.0, 5.0);
      c = cov(min(abs(m - i * g), period - m) * z);
    } else {
      float i = floor(w.x / h + 0.5);
      float yOff = mod(i, 2.0) > 0.5 ? s * 0.5 : 0.0;
      float ym = mod(w.y - yOff, s);
      c = clamp(${(DOT_RADIUS_PX + 0.5).toFixed(2)} - length(vec2(w.x - i * h, min(ym, s - ym))) * z, 0.0, 1.0);
    }
  } else if (k > 8.5) {
    vec2 m = mod(w, s);
    vec2 dd = min(m, s - m) * z;
    float ms = s * 0.2;
    vec2 mm = mod(w, ms);
    vec2 dm = min(mm, ms - mm) * z;
    float fade = clamp((ms * z - ${FADE_MIN_PX.toFixed(1)}) / ${(FADE_FULL_PX - FADE_MIN_PX).toFixed(1)}, 0.0, 1.0);
    c = max(max(cov(dd.x), cov(dd.y)), u_pat.w * fade * max(cov(dm.x), cov(dm.y)));
  } else if (k > 7.5) {
    float period = s * 1.5;
    float m = mod(w.y, period);
    c = cov(min(min(m, abs(m - s)), period - m) * z);
    float dash = s * 0.25;
    if (mod(w.x, dash) < dash * 0.5) c = max(c, cov(abs(m - s * 0.5) * z));
  } else if (k > 6.5) {
    float cueX = u_hasPage > 0.5 ? u_page.x + ${CORNELL_CUE} * u_page.z : 0.0;
    float my = mod(w.y, s);
    c = max(cov(min(my, s - my) * z), cov(abs(w.x - cueX) * z));
    if (u_hasPage > 0.5) c = max(c, cov(abs(w.y - (u_page.y + ${CORNELL_SUMMARY} * u_page.w)) * z));
  } else if (k > 5.5) {
    vec2 p = w / s;
    vec2 S = vec2(1.0, 1.7320508);
    vec2 off = vec2(0.5, 0.8660254);
    vec2 qa = p - (floor(p / S) + 0.5) * S;
    vec2 qb = p - ((floor((p - off) / S) + 0.5) * S + off);
    vec2 q = abs(dot(qa, qa) < dot(qb, qb) ? qa : qb);
    c = cov((0.5 - max(dot(q, off), q.x)) * s * z);
  } else if (k > 4.5) {
    float h = s * 0.8660254;
    vec3 t = vec3(w.x, dot(w, vec2(-0.5, 0.8660254)), dot(w, vec2(-0.5, -0.8660254)));
    vec3 m = mod(t, h);
    vec3 d = min(m, h - m) * z;
    c = max(cov(d.x), max(cov(d.y), cov(d.z)));
  } else if (k > 3.5) {
    float g = s * 0.25;
    float period = s * 2.5;
    float m = mod(w.y, period);
    float i = clamp(floor(m / g + 0.5), 0.0, 4.0);
    c = cov(min(abs(m - i * g), period - m) * z);
  } else {
    vec2 m = mod(w, s);
    vec2 dd = min(m, s - m) * z;
    vec2 wt = vec2(1.0);
    if (u_pat.z > 1.5) {
      vec2 idx = floor(w / s + 0.5);
      wt = vec2(mod(idx.x, u_pat.z) < 0.5 ? 1.0 : u_pat.w, mod(idx.y, u_pat.z) < 0.5 ? 1.0 : u_pat.w);
    }
    if (u_pat.x < 1.5) c = cov(dd.y) * wt.y;
    else if (u_pat.x < 2.5) c = max(cov(dd.x) * wt.x, cov(dd.y) * wt.y);
    else c = clamp(${(DOT_RADIUS_PX + 0.5).toFixed(2)} - length(dd), 0.0, 1.0) * min(wt.x, wt.y);
  }
  return c * a;
}

void main() {
  vec2 w = u_cam.xy + v_px / u_cam.z;
  float pat = 0.0;
  if (u_pat.x > 0.5) {
    pat = max(levelCov(w, u_lv.x, u_lv.y), levelCov(w, u_lv.z, u_lv.w)) * u_pat.y;
  }
  vec3 pageCol = mix(u_pageColor, u_lineColor, pat);
  vec3 col = pageCol;
  if (u_hasPage > 0.5) {
    vec2 lo = (u_page.xy - u_cam.xy) * u_cam.z;
    vec2 hs = u_page.zw * u_cam.z * 0.5;
    vec2 c = lo + hs;
    float d = sdBox(v_px, c, hs);
    float inside = clamp(0.5 - d, 0.0, 1.0);
    float d2 = sdBox(v_px, c + vec2(0.0, 3.0), hs);
    float sh = (1.0 - smoothstep(-2.0, 14.0, d2)) * 0.28;
    col = mix(u_desk * (1.0 - sh), pageCol, inside);
  }
  FRAG_OUT = vec4(col, 1.0);
}`

interface Prog {
  program: WebGLProgram
  u: Record<string, WebGLUniformLocation | null>
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

interface MeshEntry {
  key: string
  buf: WebGLBuffer
  vertexCount: number
  /** Stencil-filled meshes (see StencilFill); empty for plain triangle meshes. */
  passes: StencilFill['passes']
  /** Stencil mode: union of the fans instead of nonzero winding. */
  union: boolean
  used: number
}

interface TexEntry {
  key: string
  tex: WebGLTexture
  /** Texture pixels per local unit. */
  scale: number
  /** Local-space size of the quad (incl. padding) and the padding. */
  width: number
  height: number
  pad: number
  used: number
}

interface ImgTex {
  tex: WebGLTexture
  source: ImageSource
  used: number
}

const TEXT_PAD = 3
const MAX_TEX = 4096

/** Half-octave bucket >= s (keeps re-rasterization to a minimum while zooming). */
export function scaleBucket(s: number): number {
  const v = Math.max(0.25, s)
  return Math.pow(2, Math.ceil(Math.log2(v) * 2) / 2)
}

function hex(css: string): [number, number, number] {
  const c = parseColor(css)
  return [c[0], c[1], c[2]]
}

export class WebGLRenderer implements Renderer {
  private gl!: GL
  private isGL2 = false
  private hasStencil = false
  private lost = false
  private viewport: Size = { width: 1, height: 1, dpr: 1 }
  private frame = 0

  private meshProg!: Prog
  private quadProg!: Prog
  private pixProg!: Prog
  private blurProg!: Prog
  private bgProg!: Prog
  private pixTex: WebGLTexture | null = null
  private blurTex: WebGLTexture | null = null
  private blurFbo: WebGLFramebuffer | null = null
  private unitQuad: WebGLBuffer | null = null
  private bgTri: WebGLBuffer | null = null
  private stream: WebGLBuffer | null = null

  private meshes = new Map<string, MeshEntry>()
  private texts = new Map<string, TexEntry>()
  private imgTex = new Map<string, ImgTex>()
  private scratch = new MeshBuilder()
  private m3 = new Float32Array(9)
  private textCanvas: HTMLCanvasElement | OffscreenCanvas | null = null

  readonly images = new ImageCache()
  /** Called when async resources became available or the context was restored: re-render. */
  onDirty: (() => void) | null = null

  private readonly onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
    // GPU objects are gone with the context; forget them without deleting.
    this.meshes.clear()
    this.texts.clear()
    this.imgTex.clear()
  }
  private readonly onRestored = () => {
    try {
      this.initGL()
      this.lost = false
      this.onDirty?.()
    } catch {
      this.lost = true
    }
  }

  static isSupported(): boolean {
    try {
      const c = typeof document !== 'undefined' ? document.createElement('canvas') : null
      return !!c && !!(c.getContext('webgl2') || c.getContext('webgl'))
    } catch {
      return false
    }
  }

  constructor(private canvas: HTMLCanvasElement) {
    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: true,
      // ink is filled through the stencil buffer (nonzero winding)
      stencil: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }
    const gl2 = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null
    const gl = gl2 ?? (canvas.getContext('webgl', attrs) as WebGLRenderingContext | null)
    if (!gl) throw new Error('WebGL not available')
    this.gl = gl
    this.isGL2 = !!gl2
    this.hasStencil = !!gl.getContextAttributes()?.stencil
    canvas.addEventListener('webglcontextlost', this.onLost as EventListener)
    canvas.addEventListener('webglcontextrestored', this.onRestored as EventListener)
    this.initGL()
    this.images.onReady = () => this.onDirty?.()
    const w = canvas.clientWidth
    if (w) this.viewport = { width: w, height: canvas.clientHeight, dpr: 1 }
  }

  // --- setup ---------------------------------------------------------------

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl
    const isFrag = type === gl.FRAGMENT_SHADER
    let header: string
    if (this.isGL2) {
      header = '#version 300 es\n#define attribute in\n#define varying ' + (isFrag ? 'in' : 'out') + '\n'
      if (isFrag) header += 'precision mediump float;\nout vec4 fragColor;\n#define FRAG_OUT fragColor\n#define texture2D texture\n'
    } else {
      header = isFrag ? 'precision mediump float;\n#define FRAG_OUT gl_FragColor\n' : ''
    }
    const sh = gl.createShader(type)
    if (!sh) throw new Error('createShader failed')
    gl.shaderSource(sh, header + src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error(`Shader compile failed: ${log}`)
    }
    return sh
  }

  private link(vs: string, fs: string, uniforms: string[]): Prog {
    const gl = this.gl
    const v = this.compile(gl.VERTEX_SHADER, vs)
    const f = this.compile(gl.FRAGMENT_SHADER, fs)
    const program = gl.createProgram()
    if (!program) throw new Error('createProgram failed')
    gl.attachShader(program, v)
    gl.attachShader(program, f)
    gl.bindAttribLocation(program, 0, 'a_pos')
    gl.bindAttribLocation(program, 1, 'a_color')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`Program link failed: ${log}`)
    }
    gl.deleteShader(v)
    gl.deleteShader(f)
    const u: Record<string, WebGLUniformLocation | null> = {}
    for (const name of uniforms) u[name] = gl.getUniformLocation(program, name)
    return { program, u }
  }

  private initGL(): void {
    const gl = this.gl
    this.meshProg = this.link(VERT_MESH, FRAG_MESH, ['u_model', 'u_cam', 'u_view'])
    this.quadProg = this.link(VERT_QUAD, FRAG_QUAD, ['u_model', 'u_cam', 'u_view', 'u_tex', 'u_tint', 'u_useTex', 'u_alpha'])
    this.pixProg = this.link(VERT_QUAD, FRAG_PIXELATE, ['u_model', 'u_cam', 'u_view', 'u_tex', 'u_blocks', 'u_alpha'])
    this.blurProg = this.link(VERT_QUAD, FRAG_BLUR, ['u_model', 'u_cam', 'u_view', 'u_tex', 'u_dir', 'u_alpha'])
    this.pixTex = null
    this.blurTex = null
    this.blurFbo = null
    this.bgProg = this.link(VERT_BG, FRAG_BG, [
      'u_view', 'u_cam', 'u_pageColor', 'u_lineColor', 'u_desk', 'u_pat', 'u_lv', 'u_page', 'u_hasPage',
    ])
    this.unitQuad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW)
    this.bgTri = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgTri)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    this.stream = gl.createBuffer()
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  // --- Renderer API ---------------------------------------------------------

  setImageSource(resolver: ImageResolver | null): void {
    this.images.setResolver(resolver)
  }

  resize(viewport: Size): void {
    this.viewport = viewport
    this.canvas.width = Math.max(1, Math.round(viewport.width * viewport.dpr))
    this.canvas.height = Math.max(1, Math.round(viewport.height * viewport.dpr))
    if (this.canvas.style) {
      this.canvas.style.width = `${viewport.width}px`
      this.canvas.style.height = `${viewport.height}px`
    }
  }

  invalidate(ids?: Iterable<string>): void {
    if (this.lost) return
    const gl = this.gl
    const dropMesh = (k: string) => {
      const e = this.meshes.get(k)
      if (e) {
        gl.deleteBuffer(e.buf)
        this.meshes.delete(k)
      }
    }
    const dropTex = (k: string) => {
      const e = this.texts.get(k)
      if (e) {
        gl.deleteTexture(e.tex)
        this.texts.delete(k)
      }
    }
    if (!ids) {
      for (const k of [...this.meshes.keys()]) dropMesh(k)
      for (const k of [...this.texts.keys()]) dropTex(k)
      return
    }
    for (const id of ids) {
      dropMesh(id)
      dropTex(id)
      dropTex(id + '#label')
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost as EventListener)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored as EventListener)
    if (!this.lost) {
      const gl = this.gl
      this.invalidate()
      for (const t of this.imgTex.values()) gl.deleteTexture(t.tex)
      this.imgTex.clear()
      gl.deleteBuffer(this.unitQuad)
      gl.deleteBuffer(this.bgTri)
      gl.deleteBuffer(this.stream)
      gl.deleteProgram(this.meshProg.program)
      gl.deleteProgram(this.quadProg.program)
      gl.deleteProgram(this.pixProg.program)
      gl.deleteProgram(this.blurProg.program)
      gl.deleteProgram(this.bgProg.program)
      if (this.pixTex) gl.deleteTexture(this.pixTex)
      if (this.blurTex) gl.deleteTexture(this.blurTex)
      if (this.blurFbo) gl.deleteFramebuffer(this.blurFbo)
    }
    this.images.clear()
    this.lost = true
  }

  render(scene: Scene, camera: Camera): void {
    if (this.lost) return
    const gl = this.gl
    if (gl.isContextLost()) return
    this.frame++
    const { width, height } = this.viewport
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.drawBackground(scene, camera)

    gl.enable(gl.BLEND)
    const theme = scene.theme
    for (const obj of scene.objects) {
      if (!isRenderable(obj, scene.hiddenIds)) continue
      const clipped = this.clipToFrame(obj, scene, camera)
      this.drawObject(obj, scene, camera, theme, true)
      if (clipped) gl.disable(gl.SCISSOR_TEST)
    }
    if (scene.previews) for (const obj of scene.previews) this.drawObject(obj, scene, camera, theme, false)
    this.drawOverlay(scene, camera, width, height)
    gl.disable(gl.BLEND)
    this.evict()
  }

  /** Scissor to the object's frame (axis-aligned screen bounds). Returns true when a scissor was set. */
  private clipToFrame(obj: CanvasObject, scene: Scene, camera: Camera): boolean {
    if (!obj.frameId) return false
    const f = scene.resolve(obj.frameId)
    if (!f || f.type !== 'shape' || f.kind !== 'frame' || f.supersededBy) return false
    const r = this.screenRect(f, camera)
    if (!r) return false
    const gl = this.gl
    const dpr = this.viewport.dpr
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(Math.round(r.x * dpr), Math.round((this.viewport.height - r.y - r.h) * dpr), Math.round(r.w * dpr), Math.round(r.h * dpr))
    return true
  }

  /** Axis-aligned screen rect (CSS px, clamped to the viewport) of an object's oriented box. */
  private screenRect(o: CanvasObject, camera: Camera): { x: number; y: number; w: number; h: number } | null {
    const corners = worldCorners(o)
    if (!corners) return null
    const z = camera.zoom
    const xs = corners.map((c) => (c.x - camera.x) * z), ys = corners.map((c) => (c.y - camera.y) * z)
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)))
    const x1 = Math.min(this.viewport.width, Math.ceil(Math.max(...xs))), y1 = Math.min(this.viewport.height, Math.ceil(Math.max(...ys)))
    if (x1 - x0 < 1 || y1 - y0 < 1) return null
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  /** Copy the shape's screen rect out of the frame buffer and draw it back block-quantised. */
  private drawBlur(s: ShapeObject, camera: Camera): void {
    const r = this.screenRect(s, camera)
    if (!r) return
    const gl = this.gl
    const dpr = this.viewport.dpr
    const px = Math.round(r.x * dpr), py = Math.round((this.viewport.height - r.y - r.h) * dpr)
    const pw = Math.max(1, Math.round(r.w * dpr)), ph = Math.max(1, Math.round(r.h * dpr))
    this.pixTex ??= gl.createTexture()
    if (!this.pixTex) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pixTex)
    // The context has alpha:false, so the drawing buffer is RGB: the copy must use RGB too (RGBA is rejected).
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, px, py, pw, ph, 0)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    const size = Math.max(2, (s.blurSize ?? DEFAULT_BLUR_SIZE) * camera.zoom)
    // unit quad → the screen rect in world units
    const wx = camera.x + r.x / camera.zoom, wy = camera.y + r.y / camera.zoom
    const model: Mat = [r.w / camera.zoom, 0, 0, r.h / camera.zoom, wx, wy]
    if (s.blurMode === 'gaussian') {
      this.drawGaussian(pw, ph, size * dpr, model, camera, s.style.opacity)
      return
    }
    const p = this.pixProg
    gl.useProgram(p.program)
    gl.uniformMatrix3fv(p.u.u_model, false, toMat3(model, this.m3) as Float32Array)
    gl.uniform4f(p.u.u_cam, camera.x, camera.y, camera.zoom, 0)
    gl.uniform2f(p.u.u_view, this.viewport.width, this.viewport.height)
    gl.uniform2f(p.u.u_blocks, Math.max(1, Math.round(r.w / size)), Math.max(1, Math.round(r.h / size)))
    gl.uniform1f(p.u.u_alpha, s.style.opacity)
    gl.uniform1i(p.u.u_tex, 0)
    this.drawUnitQuad()
  }

  private drawUnitQuad(): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuad)
    gl.disableVertexAttribArray(1)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /**
   * Two-pass Gaussian of the copied region (already bound on texture unit 0): horizontal into an
   * intermediate texture, then vertical back onto the screen. `radius` is in device pixels.
   */
  private drawGaussian(pw: number, ph: number, radius: number, model: Mat, camera: Camera, alpha: number): void {
    const gl = this.gl
    const p = this.blurProg
    const step = Math.max(0.5, radius / 4) // 9 taps span about two radii
    this.blurTex ??= gl.createTexture()
    this.blurFbo ??= gl.createFramebuffer()
    if (!this.blurTex || !this.blurFbo) return
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.blurTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, pw, ph, 0, gl.RGB, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.activeTexture(gl.TEXTURE0)
    // pass 1: source (unit 0) → intermediate, drawn over the whole framebuffer
    const scissor = gl.isEnabled(gl.SCISSOR_TEST)
    if (scissor) gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.blurTex, 0)
    gl.viewport(0, 0, pw, ph)
    gl.disable(gl.BLEND)
    gl.useProgram(p.program)
    gl.uniformMatrix3fv(p.u.u_model, false, toMat3([pw, 0, 0, ph, 0, 0], this.m3) as Float32Array)
    gl.uniform4f(p.u.u_cam, 0, 0, 1, 0)
    gl.uniform2f(p.u.u_view, pw, ph)
    gl.uniform2f(p.u.u_dir, step / pw, 0)
    gl.uniform1f(p.u.u_alpha, 1)
    gl.uniform1i(p.u.u_tex, 0)
    this.drawUnitQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.enable(gl.BLEND)
    if (scissor) gl.enable(gl.SCISSOR_TEST)
    // pass 2: intermediate (unit 1) → screen
    gl.uniformMatrix3fv(p.u.u_model, false, toMat3(model, this.m3) as Float32Array)
    gl.uniform4f(p.u.u_cam, camera.x, camera.y, camera.zoom, 0)
    gl.uniform2f(p.u.u_view, this.viewport.width, this.viewport.height)
    gl.uniform2f(p.u.u_dir, 0, step / ph)
    gl.uniform1f(p.u.u_alpha, alpha)
    gl.uniform1i(p.u.u_tex, 1)
    this.drawUnitQuad()
  }

  // --- background -----------------------------------------------------------

  private drawBackground(scene: Scene, camera: Camera): void {
    const gl = this.gl
    const p = this.bgProg
    const bg = scene.page.background
    gl.disable(gl.BLEND)
    gl.useProgram(p.program)
    gl.disableVertexAttribArray(1)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgTri)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.uniform2f(p.u.u_view, this.viewport.width, this.viewport.height)
    gl.uniform4f(p.u.u_cam, camera.x, camera.y, camera.zoom, 0)
    const pc = hex(bg.color)
    const lc = hex(patternColor(bg))
    const desk = hex(isDarkColor(bg.color) ? DESK_COLOR_DARK : DESK_COLOR)
    gl.uniform3f(p.u.u_pageColor, pc[0], pc[1], pc[2])
    gl.uniform3f(p.u.u_lineColor, lc[0], lc[1], lc[2])
    gl.uniform3f(p.u.u_desk, desk[0], desk[1], desk[2])
    const levels = backgroundLevels(bg, camera.zoom)
    const major = bg.majorEvery && bg.majorEvery > 1 ? Math.round(bg.majorEvery) : 0
    gl.uniform4f(p.u.u_pat, levels.length ? patternKind(bg.pattern) : 0, Math.max(0, Math.min(1, bg.opacity)), major, MINOR_WEIGHT)
    gl.uniform4f(p.u.u_lv, levels[0]?.spacing ?? 0, levels[0]?.alpha ?? 0, levels[1]?.spacing ?? 0, levels[1]?.alpha ?? 0)
    const pr = pageRect(scene.page)
    if (pr) {
      gl.uniform4f(p.u.u_page, pr.x, pr.y, pr.width, pr.height)
      gl.uniform1f(p.u.u_hasPage, 1)
    } else {
      gl.uniform4f(p.u.u_page, 0, 0, 0, 0)
      gl.uniform1f(p.u.u_hasPage, 0)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // --- objects --------------------------------------------------------------

  private setMeshUniforms(model: Mat, cam: { x: number; y: number; zoom: number }): void {
    const gl = this.gl
    const p = this.meshProg
    gl.useProgram(p.program)
    gl.uniformMatrix3fv(p.u.u_model, false, toMat3(model, this.m3) as Float32Array)
    gl.uniform4f(p.u.u_cam, cam.x, cam.y, cam.zoom, 0)
    gl.uniform2f(p.u.u_view, this.viewport.width, this.viewport.height)
  }

  private bindMeshBuffer(buf: WebGLBuffer | null): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    const stride = VERTEX_FLOATS * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8)
  }

  /** Draw `scratch` contents through the streaming buffer. */
  private drawScratch(model: Mat, cam: { x: number; y: number; zoom: number }): void {
    const mb = this.scratch
    if (mb.vertexCount === 0) return
    const gl = this.gl
    this.setMeshUniforms(model, cam)
    this.bindMeshBuffer(this.stream)
    gl.bufferData(gl.ARRAY_BUFFER, mb.view(), gl.STREAM_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, mb.vertexCount)
  }

  /**
   * Draw a mesh (cached per object id). When `build` returns a fan vertex count the mesh is a
   * stencil fill (see buildInkStencilMesh) and is drawn in two passes.
   */
  private drawCachedMesh(id: string, key: string, model: Mat, cam: Camera, build: (mb: MeshBuilder) => StencilFill | void, cache: boolean): void {
    const gl = this.gl
    if (!cache) {
      this.scratch.reset()
      const fill = build(this.scratch)
      if (!fill || !fill.passes.length) { this.drawScratch(model, cam); return }
      this.setMeshUniforms(model, cam)
      this.bindMeshBuffer(this.stream)
      gl.bufferData(gl.ARRAY_BUFFER, this.scratch.view(), gl.STREAM_DRAW)
      this.drawStencilFill(fill.passes, fill.union)
      return
    }
    let e = this.meshes.get(id)
    if (!e || e.key !== key) {
      const mb = this.scratch
      mb.reset()
      const fill = build(mb)
      if (e) gl.deleteBuffer(e.buf)
      const buf = gl.createBuffer()
      if (!buf) return
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, mb.view(), gl.STATIC_DRAW)
      e = { key, buf, vertexCount: mb.vertexCount, passes: fill ? fill.passes : [], union: !!fill && fill.union, used: this.frame }
      this.meshes.set(id, e)
    }
    e.used = this.frame
    if (e.vertexCount === 0) return
    this.setMeshUniforms(model, cam)
    this.bindMeshBuffer(e.buf)
    if (e.passes.length) this.drawStencilFill(e.passes, e.union)
    else gl.drawArrays(gl.TRIANGLES, 0, e.vertexCount)
  }

  /**
   * Fill the bound mesh through the stencil buffer, pass by pass: mark the fan triangles (winding
   * count, or plain coverage for `union`), then draw the cover quad where the mark is set (which resets it).
   */
  private drawStencilFill(passes: StencilFill['passes'], union: boolean): void {
    const gl = this.gl
    gl.enable(gl.STENCIL_TEST)
    let start = 0
    for (const { fan, end } of passes) {
      gl.colorMask(false, false, false, false)
      if (union) {
        gl.stencilFunc(gl.ALWAYS, 1, 0xff)
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
      } else {
        gl.stencilFunc(gl.ALWAYS, 0, 0xff)
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP)
        gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP)
      }
      gl.drawArrays(gl.TRIANGLES, start, fan - start)
      gl.colorMask(true, true, true, true)
      gl.stencilFunc(gl.NOTEQUAL, 0, 0xff)
      gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO)
      gl.drawArrays(gl.TRIANGLES, fan, end - fan)
      start = end
    }
    gl.disable(gl.STENCIL_TEST)
  }

  private drawObject(obj: CanvasObject, scene: Scene, camera: Camera, theme: VisualTheme, cache: boolean): void {
    const clean = theme === 'clean'
    const bgc = scene.page.background.color
    switch (obj.type) {
      case 'ink':
        this.drawCachedMesh(
          obj.id, objectKey(obj, theme, bgc), transformMatrix(obj.transform), camera,
          // without a stencil buffer fall back to ear clipping (wrong only for self-crossing strokes)
          (mb) => (this.hasStencil ? buildInkStencilMesh(mb, obj as InkStroke, bgc) : void buildInkMesh(mb, obj as InkStroke, bgc)), cache,
        )
        break
      case 'shape': {
        const s = obj as ShapeObject
        if (s.kind === 'blur') {
          this.drawBlur(s, camera)
          break
        }
        const m = transformMatrix(s.transform)
        this.drawCachedMesh(s.id, objectKey(s, theme, bgc), m, camera, (mb) => buildShapeMesh(mb, s, theme, bgc), cache)
        if (s.kind === 'frame') {
          if (s.label) {
            const l = layoutText({ text: s.label, fontSize: s.labelSize ?? FRAME_LABEL_SIZE, fontFamily: 'sans', align: 'left' })
            const fc = frameColor(bgc)
            this.drawText(cache ? s.id + '#label' : null, `${s.label}|${fc}|${s.labelSize ?? ''}`, l, fc, 'left', null, multiply(m, [1, 0, 0, 1, 0, -l.height - 2]), 1, camera)
          }
          break
        }
        if (s.kind === 'counter') {
          const l = counterLabel(s)
          // the number sits on the pin, so a filled pin keeps the picked colour as is
          const lc = s.style.fillColor ? s.style.strokeColor : adaptColor(s.style.strokeColor, bgc)
          if (l) {
            this.drawText(
              cache ? s.id + '#label' : null, `${s.label}|${lc}|${s.width}x${s.height}|${s.fontFamily ?? ''}`, l.layout, lc, 'center', null,
              multiply(m, [1, 0, 0, 1, l.x, l.y]), Math.max(Math.abs(s.transform.scaleX), Math.abs(s.transform.scaleY)), camera, s.style.opacity,
            )
          }
          break
        }
        if (s.label) {
          const l = labelLayout(s.label, s.width, clean, false, s.labelSize)
          const lc = adaptColor(s.style.strokeColor, bgc)
          this.drawText(
            cache ? s.id + '#label' : null,
            `${s.label}|${lc}|${theme}|${s.labelSize ?? ''}`,
            l, lc, 'center', null,
            multiply(m, [1, 0, 0, 1, (s.width - l.width) / 2, (s.height - l.height) / 2]),
            Math.max(Math.abs(s.transform.scaleX), Math.abs(s.transform.scaleY)), camera,
          )
        }
        break
      }
      case 'arrow': {
        const a = obj as ArrowObject
        const path = arrowPath(a, scene.resolve)
        this.drawCachedMesh(a.id, arrowKey(a, path, theme, bgc), IDENTITY, camera, (mb) => buildArrowMesh(mb, a, path, theme, bgc), cache)
        if (a.label) {
          const l = labelLayout(a.label, ARROW_LABEL_WIDTH, clean, true, a.labelSize)
          const lc = adaptColor(a.style.strokeColor, bgc)
          const mid = pathMidpoint(path)
          this.drawText(
            cache ? a.id + '#label' : null,
            `${a.label}|${lc}|${theme}|${bgc}|${a.labelSize ?? ''}`,
            l, lc, 'center', bgc,
            [1, 0, 0, 1, mid.x - l.width / 2, mid.y - l.height / 2],
            1, camera,
          )
        }
        break
      }
      case 'text': {
        const t = obj as TextObject
        const l = layoutText(t)
        // a note's text sits on its box, so it keeps the picked colour as is
        const tc = t.background ? t.color : adaptColor(t.color, bgc)
        if (t.background) {
          const box = noteBox(t)
          const fill = premultiplied(adaptColor(t.background, bgc), t.opacity ?? 1)
          const tailPoint = noteTailPoint(t, scene.resolve)
          this.drawCachedMesh(
            t.id, `${t.updatedAt}|${bgc}|${t.background}|${t.opacity ?? 1}|${box.width}x${box.height}|${tailPoint?.x},${tailPoint?.y}`,
            transformMatrix(t.transform), camera,
            (mb) => {
              addPolygon(mb, noteOutline(box), fill)
              const tail = noteTail(box, tailPoint)
              if (tail) addPolygon(mb, tail, fill)
            },
            cache,
          )
        }
        this.drawText(
          cache ? t.id : null, `${t.updatedAt}|${t.text}|${tc}|${t.fontSize}|${t.fontFamily}|${t.width ?? ''}|${t.align ?? ''}`,
          l, tc, t.align, null, transformMatrix(t.transform),
          Math.max(Math.abs(t.transform.scaleX), Math.abs(t.transform.scaleY)), camera, t.opacity ?? 1,
        )
        break
      }
      case 'image':
        this.drawImage(obj as ImageObject, camera)
        break
      default:
    }
  }

  // --- textured quads ---------------------------------------------------------

  private drawQuad(model: Mat, camera: Camera, tex: WebGLTexture | null, tint: [number, number, number, number], alpha = 1): void {
    const gl = this.gl
    const p = this.quadProg
    gl.useProgram(p.program)
    gl.uniformMatrix3fv(p.u.u_model, false, toMat3(model, this.m3) as Float32Array)
    gl.uniform4f(p.u.u_cam, camera.x, camera.y, camera.zoom, 0)
    gl.uniform2f(p.u.u_view, this.viewport.width, this.viewport.height)
    gl.uniform4f(p.u.u_tint, tint[0], tint[1], tint[2], tint[3])
    gl.uniform1f(p.u.u_useTex, tex ? 1 : 0)
    gl.uniform1f(p.u.u_alpha, alpha)
    if (tex) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(p.u.u_tex, 0)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuad)
    gl.disableVertexAttribArray(1)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  private uploadTexture(source: TexImageSource, mipmaps: boolean, reuse?: WebGLTexture): WebGLTexture | null {
    const gl = this.gl
    const tex = reuse ?? gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    if (mipmaps && this.isGL2) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    }
    return tex
  }

  private getTextCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } | null {
    if (!this.textCanvas) {
      this.textCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
    }
    const c = this.textCanvas
    c.width = w
    c.height = h
    const ctx = c.getContext('2d') as Ctx2D | null
    return ctx ? { canvas: c, ctx } : null
  }

  /**
   * Draw a text layout as a cached, crisp texture. `cacheId` null = uncached (previews).
   * `model` maps the layout's top-left (local origin) to world.
   */
  private drawText(
    cacheId: string | null,
    version: string,
    layout: TextLayout,
    color: string,
    align: 'left' | 'center' | 'right' | undefined,
    background: string | null,
    model: Mat,
    objScale: number,
    camera: Camera,
    alpha = 1,
  ): void {
    if (layout.width <= 0 || layout.height <= 0) return
    const gl = this.gl
    const needed = camera.zoom * this.viewport.dpr * (objScale || 1)
    let entry = cacheId ? this.texts.get(cacheId) : undefined
    const fresh = entry && entry.key === version && entry.scale >= needed * 0.999 && entry.scale <= Math.max(needed * 3, 1)
    if (!fresh) {
      let scale = scaleBucket(needed)
      const pad = TEXT_PAD + layout.overhang
      const lw = layout.width + pad * 2
      const lh = layout.height + pad * 2
      scale = Math.min(scale, MAX_TEX / lw, MAX_TEX / lh)
      const pw = Math.max(1, Math.ceil(lw * scale))
      const ph = Math.max(1, Math.ceil(lh * scale))
      const surf = this.getTextCanvas(pw, ph)
      if (!surf) return
      const { ctx } = surf
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      if (background) {
        ctx.fillStyle = background
        ctx.globalAlpha = 0.85
        ctx.fillRect(0, 0, lw, lh)
        ctx.globalAlpha = 1
      }
      drawTextLayout(ctx, layout, color, align, pad, pad)
      const tex = this.uploadTexture(surf.canvas as TexImageSource, false, entry?.tex)
      if (!tex) return
      entry = { key: version, tex, scale, width: lw, height: lh, pad, used: this.frame }
      if (cacheId) this.texts.set(cacheId, entry)
    }
    if (!entry) return
    entry.used = this.frame
    // unit quad → padded layout box → world
    const m = multiply(model, [entry.width, 0, 0, entry.height, -entry.pad, -entry.pad])
    this.drawQuad(m, camera, entry.tex, [0, 0, 0, 0], alpha)
    if (!cacheId) gl.deleteTexture(entry.tex)
  }

  private drawImage(obj: ImageObject, camera: Camera): void {
    const source = this.images.get(obj.assetId)
    const m = multiply(transformMatrix(obj.transform), [obj.width, 0, 0, obj.height, 0, 0])
    if (!source) {
      this.drawQuad(m, camera, null, [0.5 * 0.15, 0.5 * 0.15, 0.5 * 0.15, 0.15])
      return
    }
    let t = this.imgTex.get(obj.assetId)
    if (!t || t.source !== source) {
      if (t) this.gl.deleteTexture(t.tex)
      const tex = this.uploadTexture(source as TexImageSource, true)
      if (!tex) return
      t = { tex, source, used: this.frame }
      this.imgTex.set(obj.assetId, t)
    }
    t.used = this.frame
    this.drawQuad(m, camera, t.tex, [0, 0, 0, 0])
  }

  // --- overlay ----------------------------------------------------------------

  private drawOverlay(scene: Scene, camera: Camera, width: number, height: number): void {
    if (!scene.selection && !scene.highlights?.length) return
    const polys = buildOverlay(scene, camera)
    if (!polys.length) return
    const mb = this.scratch
    mb.reset()
    for (const poly of polys) {
      if (poly.points.length < 2) continue
      if (poly.fill) addPolygon(mb, poly.points, premultiplied(poly.fill))
      if (poly.stroke) addPolyline(mb, poly.points, poly.strokeWidth ?? 1, premultiplied(poly.stroke), poly.closed)
    }
    void width; void height
    this.drawScratch(IDENTITY, { x: 0, y: 0, zoom: 1 })
  }

  // --- housekeeping -------------------------------------------------------------

  /** Bound GPU memory: drop entries not used recently when caches grow large. */
  private evict(): void {
    const gl = this.gl
    const trim = <T extends { used: number }>(map: Map<string, T>, limit: number, free: (v: T) => void) => {
      if (map.size <= limit) return
      for (const [k, v] of map) {
        if (map.size <= limit * 0.8) break
        if (v.used < this.frame) {
          free(v)
          map.delete(k)
        }
      }
    }
    trim(this.meshes, 4000, (e) => gl.deleteBuffer(e.buf))
    trim(this.texts, 400, (e) => gl.deleteTexture(e.tex))
    trim(this.imgTex, 60, (e) => gl.deleteTexture(e.tex))
  }
}

export type { Vec2 }
