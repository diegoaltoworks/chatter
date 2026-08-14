/**
 * Cloudinary's signed-upload scheme - pure, no I/O.
 *
 * Sign every parameter except the file itself: sort keys, join as `key=value`
 * pairs with `&`, append the API secret with no separator, then SHA-1 the
 * result. https://cloudinary.com/documentation/signatures
 */

import { createHash } from "node:crypto";

export function signCloudinaryParams(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("sha1").update(`${toSign}${apiSecret}`).digest("hex");
}
