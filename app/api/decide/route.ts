import { NextResponse } from "next/server";
import type { DecideRequest } from "@/lib/contract";
import { decide, stubDecide } from "@/lib/decisions";

// Keep the function close to OpenAI to cut a network hop.
export const preferredRegion = "iad1";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as DecideRequest;
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return NextResponse.json({ error: "images is required" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const forceStub = process.env.ECHO_STUB === "1" || new URL(request.url).searchParams.get("stub") === "1";
  if (!apiKey || forceStub) {
    return NextResponse.json(stubDecide());
  }

  try {
    return NextResponse.json(await decide({ ...body, images: body.images.slice(-3), recent: body.recent ?? [] }, apiKey));
  } catch (err) {
    // The phone skips this frame rather than speaking late.
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
