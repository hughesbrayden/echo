// Summarises head motion between frames so the decision step knows whether the
// wearer is walking or turning. Assumes the phone is worn upright at eye level,
// screen facing the wearer, so a head turn is rotation around the device y axis.

export type Motion = {
  // Peak yaw rate since the last frame, deg/s. Positive is a turn to the left.
  yawRate: number;
  // RMS of acceleration with gravity removed, m/s².
  accelRms: number;
  walking: boolean;
  turning: boolean;
  samples: number;
};

// Starting thresholds, meant to be tuned on recorded walks.
const WALKING_ACCEL_RMS = 0.6;
const TURNING_YAW_RATE = 45;

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
  private yawPeak = 0;
  private accelSqSum = 0;
  private samples = 0;

  private onMotion = (e: DeviceMotionEvent) => {
    const yaw = e.rotationRate?.gamma ?? 0;
    if (Math.abs(yaw) > Math.abs(this.yawPeak)) this.yawPeak = yaw;

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
    const motion: Motion = {
      yawRate: Math.round(this.yawPeak),
      accelRms: Math.round(accelRms * 100) / 100,
      walking: accelRms > WALKING_ACCEL_RMS,
      turning: Math.abs(this.yawPeak) > TURNING_YAW_RATE,
      samples: this.samples,
    };
    this.yawPeak = 0;
    this.accelSqSum = 0;
    this.samples = 0;
    return motion;
  }
}
