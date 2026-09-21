/**
 * Sunset: RH↔Sui stock Bridge tab and keepers were retired.
 * Read-only RH RPC proxy kept as a 410 so old clients fail closed.
 */
export async function POST() {
  return Response.json(
    {
      error: "bridge_sunset",
      message: "The RH↔Sui stock Bridge is sunset. Instant Create on NVDA/AMC wraps remains.",
    },
    { status: 410 },
  );
}

export async function GET() {
  return POST();
}
