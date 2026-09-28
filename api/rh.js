/**
 * Sunset: RH↔Sui stock Bridge tab and keepers were retired.
 * Read-only RH RPC proxy kept as a 410 so old clients fail closed.
 */
export async function POST() {
  return Response.json(
    {
      error: "bridge_sunset",
      message: "The RH↔Sui stock Bridge is sunset. Stock wrap Instant Create quotes (NVDA/AMC) are also removed from the pad.",
    },
    { status: 410 },
  );
}

export async function GET() {
  return POST();
}
