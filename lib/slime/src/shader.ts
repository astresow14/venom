/**
 * Original symbiote slime shader.
 *
 * The scene is raymarched as a signed distance field so linked concepts really
 * do fuse into one another: every node is a sphere, every connection is a
 * capsule, and both are combined with a smooth minimum. That smooth union is
 * what produces the stretched, stringy goo between nodes instead of a plain
 * line. Free-roaming micro-droplets are a second, tighter union so they read
 * as beads until they touch the body — then the shared smooth minimum grows a
 * neck and they visibly merge.
 *
 * The projection is orthographic and expressed directly in drawing-buffer
 * pixels. That keeps the slime locked to whatever 2D layout the host app has
 * already computed for its nodes, so each artifact can keep its own camera
 * math and the goo still lands exactly under its labels.
 *
 * Written against GLSL ES 1.00 so a single source string works in WebGL1,
 * WebGL2, and the expo-gl context on device. Uniform arrays are only ever
 * indexed by the loop counter, and every loop bound is a compile-time
 * constant — which is why the fragment source is built per capacity tier
 * instead of shipping one fixed string.
 */

import type { SlimeCapacity } from "./field";

export const SLIME_VERTEX_SHADER = `
attribute vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * GLSL ES 1.00 forbids zero-sized arrays, so a tier without droplets (the
 * software-rasterizer tier) must omit the droplet uniforms and bead pass
 * entirely instead of declaring `uDrops[0]` — that would fail to compile and
 * silently strip the goo for exactly the devices the tier exists to serve.
 */
function dropletUniforms(capacity: SlimeCapacity): string {
  if (capacity.drops <= 0) return "";
  return `uniform int uDropCount;
uniform vec4 uDrops[${capacity.drops}];
`;
}

function dropletPass(capacity: SlimeCapacity): string {
  if (capacity.drops <= 0) {
    return "  return body;";
  }
  return `  // Droplets skip the undulation: they are too small to survive it, and crisp
  // beads against a writhing body is exactly the contrast we want.
  float beads = 1.0e6;
  for (int i = 0; i < ${capacity.drops}; i++) {
    if (i >= uDropCount) break;
    vec4 drop = uDrops[i];
    beads = smin(beads, sdSphere(p, drop.xyz, drop.w), uBlend * 0.45);
  }

  return smin(body, beads, uBlend * 0.75);`;
}

export function buildSlimeFragmentShader(capacity: SlimeCapacity): string {
  if (capacity.blobs <= 0 || capacity.links <= 0) {
    throw new Error(
      `slime capacity must have positive blob and link counts, got blobs=${capacity.blobs} links=${capacity.links}`,
    );
  }
  return `
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uBlend;
uniform float uAlpha;
uniform vec3 uInk;
uniform vec3 uLight;

uniform int uBlobCount;
uniform vec4 uBlobs[${capacity.blobs}];

uniform int uLinkCount;
uniform vec4 uLinkA[${capacity.links}];
uniform vec4 uLinkB[${capacity.links}];

${dropletUniforms(capacity)}
const int MAX_STEPS = 64;
const float NEAR = -520.0;
const float FAR = 520.0;

float sdSphere(vec3 p, vec3 c, float r) {
  return length(p - c) - r;
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float denom = max(dot(ba, ba), 0.0001);
  float h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Polynomial smooth minimum. This is the whole trick behind the goo: as two
// surfaces approach, the union bulges toward them and forms a neck.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Cheap, seam-free surface movement. Two layers at unrelated frequencies keep
// the silhouette from ever visibly looping; amplitude stays small so the
// field remains close enough to a true distance function for sphere tracing.
float livingSurface(vec3 p) {
  float a = sin(p.x * 0.031 + uTime * 0.62);
  float b = sin(p.y * 0.027 - uTime * 0.48);
  float c = sin(p.z * 0.035 + uTime * 0.41);
  float d = sin((p.x + p.y) * 0.017 - uTime * 0.33);
  float e = sin(p.x * 0.052 - p.y * 0.043 + uTime * 0.23);
  float f = sin((p.y - p.z) * 0.024 + uTime * 0.17);
  return (a * b + c * d) * 0.42 + e * f * 0.3;
}

float map(vec3 p) {
  float body = 1.0e6;

  for (int i = 0; i < ${capacity.blobs}; i++) {
    if (i >= uBlobCount) break;
    vec4 blob = uBlobs[i];
    float fi = float(i);
    // Deep, layered breathing: a strong fast wave over a slow ground swell.
    float breathe = 1.0
      + 0.085 * sin(uTime * 1.15 + fi * 1.73)
      + 0.045 * sin(uTime * 0.42 + fi * 2.91);
    // Gentle anchor drift keeps the overall silhouette evolving. It stays a
    // fraction of the radius so the mass never detaches from its label.
    vec3 drift = vec3(
      sin(uTime * 0.24 + fi * 2.13),
      cos(uTime * 0.19 + fi * 1.41),
      sin(uTime * 0.16 + fi * 3.37)
    ) * blob.w * 0.14;
    body = smin(body, sdSphere(p, blob.xyz + drift, blob.w * breathe), uBlend);
  }

  for (int i = 0; i < ${capacity.links}; i++) {
    if (i >= uLinkCount) break;
    vec4 a = uLinkA[i];
    vec4 b = uLinkB[i];
    float thickness = min(a.w, b.w) * 0.26;
    float pulse = 0.78 + 0.22 * sin(uTime * 1.05 + float(i) * 2.31);
    body = smin(body, sdCapsule(p, a.xyz, b.xyz, thickness * pulse), uBlend * 1.45);
  }

  // Surface undulation whose own amplitude slowly swells and relaxes, so the
  // standing mass keeps changing shape even between droplet events.
  body += livingSurface(p) * (2.2 + 0.7 * sin(uTime * 0.11));

${dropletPass(capacity)}
}

vec3 estimateNormal(vec3 p) {
  vec2 e = vec2(1.15, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)
  ));
}

void main() {
  if (uBlobCount <= 0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Flip to top-left origin so shader space matches DOM/layout space.
  vec2 frag = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);

  vec3 origin = vec3(frag, NEAR);
  vec3 direction = vec3(0.0, 0.0, 1.0);

  float travelled = 0.0;
  float distance = 0.0;
  bool hit = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = origin + direction * travelled;
    distance = map(p);

    if (distance < 0.6) {
      hit = true;
      break;
    }

    // Damped stepping keeps the noise-displaced field from overshooting.
    travelled += max(distance * 0.68, 1.1);

    if (travelled > FAR - NEAR) break;
  }

  if (!hit) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 p = origin + direction * travelled;
  vec3 normal = estimateNormal(p);
  vec3 view = vec3(0.0, 0.0, -1.0);
  vec3 lightDir = normalize(vec3(-0.42, -0.68, -0.6));

  float facing = max(dot(normal, view), 0.0);
  float fresnel = pow(1.0 - facing, 3.0);
  float rim = pow(1.0 - facing, 7.0);
  float diffuse = max(dot(normal, lightDir), 0.0);
  float specular = pow(max(dot(reflect(-lightDir, normal), view), 0.0), 42.0);

  // Wet black material: almost no body colour, all of the read comes from the
  // rim and the highlight. The tight rim term is what keeps the silhouette
  // legible against Venom's near-black stage.
  vec3 colour = uInk
    + uLight * fresnel * 0.30
    + uLight * rim * 0.85
    + uLight * specular * 1.35
    + uLight * diffuse * diffuse * 0.26;

  // Fade with depth so the mass behind the front surface recedes.
  float depthFade = clamp(1.0 - (p.z - NEAR) / (FAR - NEAR) * 0.55, 0.42, 1.0);

  gl_FragColor = vec4(colour * depthFade, uAlpha * depthFade);
}
`;
}
