// Summarises head motion between frames so the decision step knows whether the
// wearer is walking or turning, how far the camera tilts up or down, and how
// far the head is turned from the way they are walking. Assumes the phone is
// worn upright at eye level, screen facing the wearer, so a head turn is
// rotation around the device y axis.

export type Motion = {
  // Average yaw rate since the last frame, deg/s. Positive is a turn to the
  // left. Averaging cancels the side-to-side wobble of walking, so only a
  // real head turn counts.
  yawRate: number;
  // RMS of acceleration with gravity removed, m/s².
  accelRms: number;
  walking: boolean;
  turning: boolean;
  // Camera tilt from gravity, degrees: 0 is level, negative looks down at the
  // ground, positive looks up.
  pitch: number;
  // Head direction minus walking direction, degrees: positive is looking to
  // the left. From integrated gyro yaw, re-centred while walking straight.
  headOffset: number;
  samples: number;
};

// Starting thresholds, meant to be tuned on recorded walks.
const WALKING_ACCEL_RMS = 0.6;
const TURNING_YAW_RATE = 30;
// How fast the walking direction follows the head while walking straight
// (per frame); slow enough that a glance aside doesn't move it.
const WALK_HEADING_FOLLOW = 0.15;

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

// Call from a tap: iOS Safari asks for motion permission and needs a gesture.
export async function requestMotionPermission(): Promise<boolean> {
  if (typeof DeviceMotionEvent === "undefined") return false;
  const request = (DeviceMotionEvent as unknown as MotionPermission).requestPermission;
  if (!request) return true;
  try {
    return (await request()) === "granted";
  } catch {
    return false;
  }
}

export class MotionTracker {
  private yawSum = 0;
  private accelSqSum = 0;
  private samples = 0;
  // Gravity, summed over the window, for the camera tilt.
  private gravity = { y: 0, z: 0 };
  // Head yaw integrated from the gyro, and the walking direction, in degrees.
  private heading = 0;
  private walkHeading = 0;
  private lastTime: number | null = null;

  private onMotion = (e: DeviceMotionEvent) => {
    const yaw = e.rotationRate?.gamma ?? 0;
    this.yawSum += yaw;
    if (this.lastTime !== null) {
      const dt = Math.min((e.timeStamp - this.lastTime) / 1000, 0.2);
      this.heading += yaw * dt;
    }
    this.lastTime = e.timeStamp;

    const g = e.accelerationIncludingGravity;
    if (g) {
      this.gravity.y += g.y ?? 0;
      this.gravity.z += g.z ?? 0;
    }

    const a = e.acceleration;
    if (a) {
      this.accelSqSum += (a.x ?? 0) ** 2 + (a.y ?? 0) ** 2 + (a.z ?? 0) ** 2;
    }
    this.samples++;
  };

  start() {
    window.addEventListener("devicemotion", this.onMotion);
  }

  stop() {
    window.removeEventListener("devicemotion", this.onMotion);
  }

  // Returns the summary since the last call and starts a new window.
  take(): Motion {
    const accelRms = this.samples ? Math.sqrt(this.accelSqSum / this.samples) : 0;
    const yawRate = this.samples ? this.yawSum / this.samples : 0;
    const walking = accelRms > WALKING_ACCEL_RMS;
    const turning = Math.abs(yawRate) > TURNING_YAW_RATE;

    // While walking with the head steady, the head points roughly the way
    // the wearer walks, so let the walking direction drift toward it.
    if (walking && !turning) {
      this.walkHeading += WALK_HEADING_FOLLOW * (this.heading - this.walkHeading);
    }

    const motion: Motion = {
      yawRate: Math.round(yawRate),
      accelRms: Math.round(accelRms * 100) / 100,
      walking,
      turning,
      pitch: Math.round(pitchFromGravity(this.gravity.y, this.gravity.z)),
      headOffset: Math.round(this.heading - this.walkHeading),
      samples: this.samples,
    };
    this.yawSum = 0;
    this.gravity = { y: 0, z: 0 };
    this.accelSqSum = 0;
    this.samples = 0;
    return motion;
  }
}

// Camera tilt from the gravity vector. Upright, gravity runs along the y
// axis; tilting the camera down moves it into z. Browsers disagree on the
// sign of accelerationIncludingGravity, so normalise on y (the phone is worn
// upright, so y is the large component).
function pitchFromGravity(y: number, z: number): number {
  if (y === 0 && z === 0) return 0;
  const s = y >= 0 ? 1 : -1;
  return (-Math.atan2(s * z, s * y) * 180) / Math.PI;
}
