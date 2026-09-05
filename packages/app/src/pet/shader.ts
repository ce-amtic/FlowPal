/**
 * The pet is a single full-screen triangle pair.  Keeping the shader source in
 * its own module keeps the production pet entry independent from React and
 * Electron, while still making the renderer contract easy to exercise in
 * focused tests.
 */

export const PET_VERTEX_SHADER = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * The high precision version is the normal path.  Its soft-pebble shape,
 * lighting, eye geometry, gaze and spring pose are ported directly from the
 * user-approved quiet-pebble.html design (SHA-256
 * 3629b807bf759092d1ff808aff9b918ee5e9e61ea1b57847b1170e3f10d944ef).
 * FlowPal only adds transparent compositing and status tint; there are no
 * textures, external assets, network requests, or showcase controls here.
 */
export const PET_FRAGMENT_SHADER_HIGH = `
precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform vec2 u_ground;
uniform float u_unit;
uniform float u_squash;
uniform float u_lean;
uniform float u_yaw;
uniform float u_blink;
uniform vec2 u_gaze;
uniform vec3 u_bodyColor;
uniform vec3 u_statusColor;
uniform float u_elevation;
uniform vec4 u_eyeStyle;

vec3 localPoint(vec3 p) {
  p.y /= max(u_squash, 0.001);
  p.x *= sqrt(max(u_squash, 0.001));
  p.x -= u_lean * (p.y + 0.81) * 0.3;
  float c = cos(u_yaw);
  float s = sin(u_yaw);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

float shape(vec3 p) {
  p = localPoint(p);
  // Smooth superellipsoid with a softly flattened contact area.
  vec3 q = abs(p / vec3(1.115, 0.855, 0.79));
  float rounded = (pow(pow(q.x, 2.35) + pow(q.y, 2.35) + pow(q.z, 2.35), 1.0 / 2.35) - 1.0) * 0.72;
  float floorCut = -p.y - 0.81;
  float seam = max(0.045 - abs(rounded - floorCut), 0.0) / 0.045;
  return (max(rounded, floorCut) + seam * seam * 0.01125) * min(u_squash, 0.8);
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    shape(p + e.xyy) - shape(p - e.xyy),
    shape(p + e.yxy) - shape(p - e.yxy),
    shape(p + e.yyx) - shape(p - e.yyx)
  ));
}

float eye(vec2 p, float side) {
  float tilt = u_eyeStyle.w * side;
  p = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * p;
  float opening = max(0.07, (u_eyeStyle.x + side * u_eyeStyle.z) * u_blink);
  vec2 capsule = p;
  capsule.y /= opening;
  vec2 q = abs(capsule) - vec2(0.0, 0.044);
  float oval = (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.065) * min(opening, 1.0);
  // Curved closed eyes keep their stroke weight during a smile transition.
  vec2 closed = vec2(p.x, p.y - (0.052 - 5.2 * p.x * p.x) * u_blink);
  float arc = length(vec2(max(abs(closed.x) - 0.076, 0.0), closed.y)) - 0.025;
  return mix(oval, arc, u_eyeStyle.y);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 screenPoint = (pixel - u_center) / max(u_unit, 1.0);
  screenPoint.y = -screenPoint.y;

  vec3 rayOrigin = vec3(screenPoint.x, screenPoint.y + 0.33, 4.5);
  vec3 rayDirection = normalize(vec3(0.0, -0.073, -1.0));
  float distanceTravelled = 0.0;
  float distanceToSurface = 0.0;
  bool hit = false;

  for (int i = 0; i < 64; i += 1) {
    vec3 point = rayOrigin + rayDirection * distanceTravelled;
    distanceToSurface = shape(point);
    if (distanceToSurface < 0.0015) {
      hit = true;
      break;
    }
    distanceTravelled += distanceToSurface;
    if (distanceTravelled > 8.0) break;
  }

  float spread = 1.0 + u_elevation * 0.2;
  float shadow = exp(-pow(screenPoint.x / (0.82 * spread), 2.0) - pow(screenPoint.y / (0.13 * spread), 2.0));
  float contact = exp(-pow(screenPoint.x / 0.58, 4.0) - pow(screenPoint.y / 0.028, 2.0)) * exp(-u_elevation * 5.0);

  if (!hit) {
    // Transparent canvas outside the body.  A very faint contact shadow keeps
    // the pet grounded without turning the transparent window into a rectangle.
    float alpha = min(0.22, shadow * 0.20 + contact * 0.14);
    gl_FragColor = vec4(vec3(0.24, 0.20, 0.18), alpha);
    return;
  }

  vec3 point = rayOrigin + rayDirection * distanceTravelled;
  vec3 normal = normalAt(point);
  vec3 local = localPoint(point);
  vec3 light = normalize(vec3(-0.65, 1.1, 1.35));
  float diffuse = max(dot(normal, light), 0.0);
  float fill = max(dot(normal, normalize(vec3(0.8, 0.2, -0.6))), 0.0);
  vec3 linearBase = pow(max(u_bodyColor, vec3(0.0)), vec3(2.2));
  vec3 illumination = vec3(0.43, 0.46, 0.49)
    + vec3(0.64, 0.615, 0.57) * diffuse
    + vec3(0.1, 0.12, 0.13) * fill;
  float underside = mix(0.68, 1.0, smoothstep(-0.81, -0.26, local.y));
  float broadSpecular = pow(max(dot(normal, normalize(light - rayDirection)), 0.0), 14.0) * 0.038;
  float softRim = pow(1.0 - max(dot(normal, -rayDirection), 0.0), 3.0) * 0.038;
  vec3 linearColor = linearBase * illumination * underside + vec3(broadSpecular + softRim);
  vec3 color = pow(max(linearColor, vec3(0.0)), vec3(1.0 / 2.2));

  // Status tint is deliberately subtle: the shape, not a loud badge, carries
  // the state in the desktop overlay.
  color = mix(color, u_statusColor, 0.16);
  vec2 gaze = u_gaze;
  float eyes = min(
    eye(local.xy - vec2(-0.235 + gaze.x, 0.035 + gaze.y), -1.0),
    eye(local.xy - vec2(0.235 + gaze.x, 0.035 + gaze.y), 1.0)
  );
  float antialias = max(0.002, 0.65 / max(u_unit, 1.0));
  float bodyAlpha = 1.0 - smoothstep(-antialias, antialias, distanceToSurface);
  float eyeMask = (1.0 - smoothstep(-antialias, antialias, eyes)) * smoothstep(0.43, 0.60, local.z);
  vec3 eyeColor = vec3(0.18, 0.16, 0.15) + vec3(0.033) * diffuse;
  color = mix(color, eyeColor, eyeMask);
  gl_FragColor = vec4(color, bodyAlpha);
}
`

/** A mediump fallback for GPUs that cannot compile highp fragment shaders. */
export const PET_FRAGMENT_SHADER_MEDIUM = PET_FRAGMENT_SHADER_HIGH.replace(
  'precision highp float;',
  'precision mediump float;',
)
