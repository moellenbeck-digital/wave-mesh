import { handlePlausible, plausibleConfig } from "@/lib/plausible";

// `%5F` is an underscore that Next does not take for a private folder: a plain
// `_plausible` would not be routed at all. The environment is read per request,
// not at build, because one image serves every environment.
export const dynamic = "force-dynamic";

// Every method answers, so that anything but the two known pairs is the 404 of
// `handlePlausible` and not Next's 405.
const handle = (request: Request) => handlePlausible(request, { config: plausibleConfig(process.env) });

export {
  handle as DELETE,
  handle as GET,
  handle as HEAD,
  handle as OPTIONS,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
