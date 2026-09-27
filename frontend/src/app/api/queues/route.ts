// Public (Hoodi) deployment only: the local demo reads queues from the proof service instead.
// Hoodi's queues are nearly empty, so the economics are shown with a mainnet snapshot, labelled as such.
import snapshot from "./mainnet-snapshot.json";

export function GET() {
  return Response.json(snapshot);
}
