// Ground distances from where things sit in the frame. The camera is at the
// wearer's eye height and tilted by the pitch the motion sensor reports, so a
// point on the ground at a given row of the image is at a known distance:
//
//   distance = eyeHeight / tan(angle below level)
//
// where the angle below level is the camera's downward tilt plus how far the
// row is below the centre of the frame. Shared by the phone and the server.

export type CameraSetup = {
  // Camera height above the ground, metres: the wearer's eye height.
  eyeHeightM: number;
  // Vertical field of view of the frames sent, degrees.
  vfovDeg: number;
  // The wearer's typical step, metres, for "about 4 steps ahead".
  stepLengthM: number;
};

export const DEFAULT_EYE_HEIGHT_M = 1.6;

// Phone main cameras see about 65° across their long side. Echo is worn in
// portrait, so the long side is usually vertical.
const LONG_SIDE_FOV_DEG = 65;

// Rows closer to the horizon than this are too far to measure.
const MIN_DEPRESSION_DEG = 1.5;
const MAX_DISTANCE_M = 30;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function cameraSetup(eyeHeightM: number, frameWidth: number, frameHeight: number): CameraSetup {
  // Pinhole: scale the long side's field of view to the vertical side.
  const longHalf = Math.tan(rad(LONG_SIDE_FOV_DEG / 2));
  const verticalHalf = longHalf * (frameHeight / Math.max(frameWidth, frameHeight));
  return {
    eyeHeightM,
    vfovDeg: Math.round(deg(2 * Math.atan(verticalHalf))),
    // Step length is about 0.415 × body height, and eye height is about
    // 0.93 × body height.
    stepLengthM: Math.round((0.415 * eyeHeightM * 100) / 0.93) / 100,
  };
}

// Degrees below level of a row, 0 = top of frame, 1 = bottom.
function depressionDeg(rowFrac: number, pitchDeg: number, cam: CameraSetup): number {
  const half = Math.tan(rad(cam.vfovDeg / 2));
  const belowAxis = deg(Math.atan((rowFrac - 0.5) * 2 * half));
  return belowAxis - pitchDeg;
}

// Metres along the ground to the point at this row, or null when the row is
// at or above the horizon.
export function groundDistanceM(rowFrac: number, pitchDeg: number, cam: CameraSetup): number | null {
  const dep = depressionDeg(rowFrac, pitchDeg, cam);
  if (dep < MIN_DEPRESSION_DEG) return null;
  return Math.min(cam.eyeHeightM / Math.tan(rad(dep)), MAX_DISTANCE_M);
}

// Where the horizon falls in the frame, 0 = top, 1 = bottom.
function horizonRow(pitchDeg: number, cam: CameraSetup): number {
  const half = Math.tan(rad(cam.vfovDeg / 2));
  return 0.5 + Math.tan(rad(pitchDeg)) / (2 * half);
}

// Plain-language geometry for the models, e.g. "Camera about 1.6 m above the
// ground, tilted 20° down. The bottom edge of the frame shows ground about
// 0.9 m ahead, the middle about 4.4 m; the horizon is 15% from the top."
export function describeGeometry(pitchDeg: number, cam: CameraSetup): string {
  const tilt = Math.round(Math.abs(pitchDeg));
  const tiltText = tilt < 3 ? "level" : `tilted ${tilt}° ${pitchDeg < 0 ? "down" : "up"}`;
  const parts = [`Camera about ${cam.eyeHeightM.toFixed(1)} m above the ground, ${tiltText}.`];

  const bottom = groundDistanceM(1, pitchDeg, cam);
  const middle = groundDistanceM(0.5, pitchDeg, cam);
  const marks: string[] = [];
  if (bottom !== null) marks.push(`the bottom edge of the frame shows ground about ${bottom.toFixed(1)} m ahead`);
  if (middle !== null) marks.push(`the middle about ${middle.toFixed(1)} m`);
  const horizon = horizonRow(pitchDeg, cam);
  if (horizon > 0 && horizon < 1) marks.push(`the horizon is ${Math.round(horizon * 100)}% from the top`);
  if (marks.length) {
    const text = marks.join(", ");
    parts.push(text.charAt(0).toUpperCase() + text.slice(1) + ".");
  }
  return parts.join(" ");
}
