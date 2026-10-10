import type { Metadata } from "next";
import Camera from "@/components/Camera";

export const metadata: Metadata = {
  title: "Echo · Live demo",
};

export default function Demo() {
  return <Camera />;
}
