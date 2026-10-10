// Summarises head motion between frames so the decision step knows whether the
// wearer is walking or turning, how fast they walk, and where the camera points. Assumes the phone is worn upright at eye level,
// screen facing the wearer, so a head turn is rotation around the device y axis.

export type Motion = {
  // Average yaw rate since the last frame, deg/s. Positive is a turn to the
  // left. Averaging cancels the side-to-side wobble of walking, so only a
  // real head turn counts.
  yawRate: number;
  // How far the head turned since the last frame, degrees. Positive is left.
  yawDeg: number;
  // RMS of acceleration with gravity removed, m/s².
  accelRms: number;
  // Walking pace from the bounce of each step, over the last few seconds.
  // Zero when standing or when no steps were picked up.
  stepsPerSecond: number;
  // How far the camera points below level, degrees (negative is above).
  // Null when the browser gives no orientation.
  tiltDeg: number | null;
  walking: boolean;
  turning: boolean;
  samples: number;
};

// Starting thresholds, meant to be tuned on recorded walks.
const WALKING_ACCEL_RMS = 0.6;
const TURNING_YAW_RATE = 30;
// A step is a bounce above this, at least STEP_MIN_MS after the last one.
const STEP_ACCEL = 1.2;
const STEP_MIN_MS = 300;
const PACE_WINDOW_MS = 3000;

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

// Call from a tap: iOS Safari asks for motion permission and needs a gesture.
export async function requestMotionPermission(): Promise<boolean> {
  if (typeof DeviceMotionEvent === "undefined") return false;
  const ask = async (event: unknown) => {
    const request = (event as MotionPermission | undefined)?.requestPermission;
    if (!request) return true;
    try {
      return (await request()) === "granted";
    } catch {
      return false;
    }
  };
  const motion = await ask(DeviceMotionEvent);
  // Tilt is a nice-to-have; Echo still runs without it.
  if (typeof DeviceOrientationEvent !== "undefined") await ask(DeviceOrientationEvent);
  return motion;
}

export class MotionTracker {
  private yawSum = 0;
  private yawDeg = 0;
  private accelSqSum = 0;
  private samples = 0;
  private lastAt: number | null = null;
  private aboveStep = false;
  private steps: number[] = [];
  private beta: number | null = null;

  private onMotion = (e: DeviceMotionEvent) => {
    const gamma = e.rotationRate?.gamma ?? 0;
    this.yawSum += gamma;
    // Integrate the turn rate; skip gaps, e.g. after the tab was hidden.
    if (this.lastAt !== null) {
      const dt = (e.timeStamp - this.lastAt) / 1000;
      if (dt > 0 && dt < 0.2) this.yawDeg += gamma * dt;
    }
    this.lastAt = e.timeStamp;

    const a = e.acceleration;
    if (a) {
      const sq = (a.x ?? 0) ** 2 + (a.y ?? 0) ** 2 + (a.z ?? 0) ** 2;
      this.accelSqSum += sq;
      const above = Math.sqrt(sq) > STEP_ACCEL;
      const last = this.steps[this.steps.length - 1] ?? -Infinity;
      if (above && !this.aboveStep && e.timeStamp - last >= STEP_MIN_MS) this.steps.push(e.timeStamp);
      this.aboveStep = above;
    }
    this.samples++;
  };

  private onOrientation = (e: DeviceOrientationEvent) => {
    this.beta = e.beta;
  };

  start() {
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrientation);
  }

  stop() {
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrientation);
  }

  // Returns the summary since the last call and starts a new window.
  take(): Motion {
    const accelRms = this.samples ? Math.sqrt(this.accelSqSum / this.samples) : 0;
    const yawRate = this.samples ? this.yawSum / this.samples : 0;
    const walking = accelRms > WALKING_ACCEL_RMS;
    const now = this.lastAt ?? 0;
    this.steps = this.steps.filter((t) => now - t <= PACE_WINDOW_MS);
    const motion: Motion = {
      yawRate: Math.round(yawRate),
      yawDeg: Math.round(this.yawDeg),
      accelRms: Math.round(accelRms * 100) / 100,
      stepsPerSecond: walking ? Math.round((this.steps.length / (PACE_WINDOW_MS / 1000)) * 10) / 10 : 0,
      // Upright at eye level, beta is 90; tipping the camera down lowers it.
      tiltDeg: this.beta === null ? null : Math.round(90 - this.beta),
      walking,
      turning: Math.abs(yawRate) > TURNING_YAW_RATE,
      samples: this.samples,
    };
    this.yawSum = 0;
    this.yawDeg = 0;
    this.accelSqSum = 0;
    this.samples = 0;
    return motion;
  }
}
