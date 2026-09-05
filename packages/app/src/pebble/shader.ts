/**
 * 「隅」的着色器。照着 docs/quiet-pebble.html 那份原型重写，只保留主窗口用得上的
 * 部分：形体、表情、眨眼、跟随视线。
 *
 * 原型里的抱起、轻弹、转身都去掉了——那些是桌宠窗口的交互，主窗口里它是装饰。
 * 于是 squash / lean / yaw / elevation 全部恒定，原型里的 localPoint 变换整个消失。
 *
 * 与原型最大的一处不同：背景不再画在这里。原型把它那一版底色直接写进片元，
 * 上下文也是 alpha:false，那样嵌进页面就是一块盖住底色与毛玻璃的不透明矩形。
 * 这里未命中的像素只输出接触阴影的透明度，颜色交给页面。
 */

export const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`

export const FRAGMENT = `
precision highp float;
uniform vec2 resolution;
uniform vec2 center;
uniform vec2 ground;
uniform float unit;
uniform float blink;
uniform vec2 gaze;
uniform vec3 bodyColor;
uniform float shadowStrength;
uniform vec4 eyeStyle;

/* 平滑超椭球：曲率连续，触地处被轻轻压平 */
float shape(vec3 p) {
  vec3 q = abs(p / vec3(1.115, 0.855, 0.79));
  float rounded = (pow(pow(q.x, 2.35) + pow(q.y, 2.35) + pow(q.z, 2.35), 1.0 / 2.35) - 1.0) * 0.72;
  float floorCut = -p.y - 0.81;
  float h = max(0.045 - abs(rounded - floorCut), 0.0) / 0.045;
  return (max(rounded, floorCut) + h * h * 0.01125) * 0.8;
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    shape(p + e.xyy) - shape(p - e.xyy),
    shape(p + e.yxy) - shape(p - e.yxy),
    shape(p + e.yyx) - shape(p - e.yyx)));
}

float eye(vec2 p, float side) {
  float tilt = eyeStyle.w * side;
  p = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * p;
  float opening = max(0.07, (eyeStyle.x + side * eyeStyle.z) * blink);
  vec2 capsule = p;
  capsule.y /= opening;
  vec2 q = abs(capsule) - vec2(0.0, 0.044);
  float oval = (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.065) * min(opening, 1.0);
  /* 闭眼时的弧线，笑起来的过程中笔画粗细不变 */
  vec2 cp = vec2(p.x, p.y - (0.052 - 5.2 * p.x * p.x) * blink);
  float arc = length(vec2(max(abs(cp.x) - 0.076, 0.0), cp.y)) - 0.025;
  return mix(oval, arc, eyeStyle.y);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);

  vec2 uv = (pixel - center) / unit;
  uv.y = -uv.y;
  vec3 ro = vec3(uv.x, uv.y + 0.33, 4.5);
  vec3 rd = normalize(vec3(0.0, -0.073, -1.0));
  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 64; i++) {
    vec3 p = ro + rd * t;
    float d = shape(p);
    if (d < 0.0015) { hit = true; break; }
    t += d;
    if (t > 8.0) break;
  }

  if (!hit) {
    /* 接触阴影。页面提供底色，这里只出浓度 */
    vec2 sp = (pixel - ground) / unit;
    float spread = exp(-pow(sp.x / 0.82, 2.0) - pow(sp.y / 0.13, 2.0));
    float contact = exp(-pow(sp.x / 0.58, 4.0) - pow(sp.y / 0.028, 2.0));
    gl_FragColor = vec4(0.0, 0.0, 0.0, (spread + contact * 0.7) * shadowStrength);
    return;
  }

  vec3 p = ro + rd * t;
  vec3 n = normalAt(p);
  vec3 light = normalize(vec3(-0.65, 1.1, 1.35));
  float diffuse = max(dot(n, light), 0.0);
  float fill = max(dot(n, normalize(vec3(0.8, 0.2, -0.6))), 0.0);
  vec3 linearBase = pow(bodyColor, vec3(2.2));
  /* 宽面光、暖漫射，底部压暗使它落在平面上 */
  vec3 illumination = vec3(0.43, 0.46, 0.49) + vec3(0.64, 0.615, 0.57) * diffuse + vec3(0.1, 0.12, 0.13) * fill;
  float under = mix(0.68, 1.0, smoothstep(-0.81, -0.26, p.y));
  vec3 halfway = normalize(light - rd);
  float broadSpec = pow(max(dot(n, halfway), 0.0), 14.0) * 0.038;
  float softRim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * 0.038;
  vec3 linearCol = linearBase * illumination * under + vec3(broadSpec + softRim);
  vec3 col = pow(max(linearCol, vec3(0.0)), vec3(1.0 / 2.2));

  float eyes = min(
    eye(p.xy - vec2(-0.235 + gaze.x, 0.035 + gaze.y), -1.0),
    eye(p.xy - vec2(0.235 + gaze.x, 0.035 + gaze.y), 1.0));
  float aa = max(0.002, 0.65 / unit);
  float mask = (1.0 - smoothstep(-aa, aa, eyes)) * smoothstep(0.43, 0.60, p.z);
  col = mix(col, vec3(0.18, 0.205, 0.20) + vec3(0.033) * diffuse, mask);

  gl_FragColor = vec4(col, 1.0);
}
`

/** 六种表情，每个是一组眼形参数：开合、闭合弧度、左右不对称、倾角 */
export const MOODS = {
  calm: [1, 0, 0, 0],
  happy: [0.7, 1, 0, 0],
  sleepy: [0.24, 0, 0, 0],
  curious: [0.9, 0, 0.32, 0.1],
  surprised: [1.3, 0, 0, 0],
  focus: [0.64, 0, 0, -0.12],
} as const

export type Mood = keyof typeof MOODS
